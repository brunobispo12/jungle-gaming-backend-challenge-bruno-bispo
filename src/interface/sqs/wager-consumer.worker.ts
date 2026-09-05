import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';

import { ApplicationError, ErrorCode } from '@/application/errors';
import { NOOP_METRICS, type MetricsPort } from '@/application/ports';
import type {
  ConsumeOutcome,
  ConsumeWagerMessageUseCase,
} from '@/application/use-cases/consume-wager-message';
import { QueueUrlCache } from '@/infrastructure/messaging/queue-urls';
import type { JsonLogger } from '@/infrastructure/observability/json-logger';
import { CONSUMER_NAME, correlationIdOf, parseWagerMessage, sha256Hex } from './envelope';

const BASE_RETRY_DELAY_SECONDS = 5;
const MAX_RETRY_DELAY_SECONDS = 60;
const PERMANENT_INPUT_CODES = new Set<ErrorCode>([
  ErrorCode.InvalidPayload,
  ErrorCode.ReferenceRequired,
  ErrorCode.ReservedProviderId,
]);

export interface WagerConsumerOptions {
  readonly enabled: boolean;
  readonly consumerName: string;
  readonly inputQueue: string;
  readonly dlqQueue: string;
  readonly batchSize: number;
  readonly waitTimeSeconds: number;
  readonly visibilityTimeoutSeconds: number;
  readonly inFlightGraceMs: number;
  readonly shutdownWindowMs: number;
}

function raceWithDeadline(work: Promise<unknown>, deadlineMs: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, deadlineMs);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

export function retryDelaySeconds(receiveCount: number): number {
  return Math.min(MAX_RETRY_DELAY_SECONDS, BASE_RETRY_DELAY_SECONDS * 2 ** (receiveCount - 1));
}

export class WagerConsumerWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly urls: QueueUrlCache;
  private readonly inFlight = new Map<string, { queueUrl: string; message: Message }>();
  private running = false;
  private stopping = false;
  private drained: Promise<void> | undefined;
  private wakeFromBackoff: (() => void) | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly consume: ConsumeWagerMessageUseCase,
    private readonly logger: JsonLogger,
    private readonly options: WagerConsumerOptions,
    private readonly metrics: MetricsPort = NOOP_METRICS,
  ) {
    this.urls = new QueueUrlCache(sqs);
  }

  onApplicationBootstrap(): void {
    if (!this.options.enabled || this.running) {
      return;
    }
    this.running = true;
    this.drained = this.loop();
  }

  // What the grace does not finish has its visibility returned inside the rest of
  // the shutdown window, so it comes back at once instead of waiting the timeout.
  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    this.stopping = true;
    this.wakeFromBackoff?.();

    await raceWithDeadline(this.drained ?? Promise.resolve(), this.options.inFlightGraceMs);
    this.drained = undefined;

    await this.releaseInFlight();
  }

  private async releaseInFlight(): Promise<void> {
    const held = [...this.inFlight.values()];
    this.inFlight.clear();
    if (held.length === 0) {
      return;
    }

    const reserve = Math.max(0, this.options.shutdownWindowMs - this.options.inFlightGraceMs);
    await raceWithDeadline(
      Promise.allSettled(
        held.map(({ queueUrl, message }) => this.changeVisibility(queueUrl, message, 0)),
      ),
      reserve,
    );
  }

  async pollOnce(): Promise<number> {
    const queueUrl = await this.urls.resolve(this.options.inputQueue);
    const received = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: this.options.batchSize,
        WaitTimeSeconds: this.options.waitTimeSeconds,
        MessageSystemAttributeNames: ['All'],
      }),
    );

    const messages = received.Messages ?? [];
    for (const [index, message] of messages.entries()) {
      if (this.stopping) {
        await this.changeVisibility(queueUrl, message, 0);
        continue;
      }
      // A contended wallet can hold one message for the whole lock timeout, so
      // the rest of the batch restarts its window instead of inheriting the wait.
      if (index > 0) {
        await this.changeVisibility(queueUrl, message, this.options.visibilityTimeoutSeconds);
      }
      await this.handle(queueUrl, message);
    }

    return messages.length;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (error: unknown) {
        this.logger.write('error', 'sqs receive loop failed', { errorType: errorTypeOf(error) });
        this.metrics.recordRetry('sqs-consumer', 'receive-error');
        await this.backoff();
      }
    }
  }

  private async backoff(): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, BASE_RETRY_DELAY_SECONDS * 1_000);
      this.wakeFromBackoff = (): void => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.wakeFromBackoff = undefined;
  }

  private async handle(queueUrl: string, message: Message): Promise<void> {
    const held = message.ReceiptHandle ?? '';
    this.inFlight.set(held, { queueUrl, message });
    try {
      await this.decide(queueUrl, message);
    } finally {
      this.inFlight.delete(held);
    }
  }

  private async decide(queueUrl: string, message: Message): Promise<void> {
    const rawBody = message.Body ?? '';
    const { outcome, context } = await this.outcomeOf(rawBody, message);
    const fields = {
      brokerMessageId: message.MessageId ?? '',
      ...context,
    };

    switch (outcome.kind) {
      case 'processed':
        this.logger.write('info', 'message processed', {
          ...fields,
          transactionId: outcome.result.transactionId,
          status: outcome.result.status,
          idempotentReplay: outcome.result.idempotentReplay,
        });
        await this.ack(queueUrl, message);
        return;

      case 'duplicate':
        this.logger.write('info', 'message deduplicated', fields);
        await this.ack(queueUrl, message);
        return;

      case 'permanent':
        this.logger.write('error', 'message rejected as permanent', {
          ...fields,
          reason: safeReason(outcome.reason, 'PERMANENT_FAILURE'),
        });
        await this.deadLetter(rawBody, message);
        this.metrics.recordDlq('permanent');
        await this.ack(queueUrl, message);
        return;

      case 'transient':
        this.logger.write('warn', 'message returned for retry', {
          ...fields,
          reason: safeReason(outcome.reason, 'TRANSIENT_FAILURE'),
        });
        await this.returnForRetry(queueUrl, message);
        this.metrics.recordRetry('sqs-consumer', 'transient');
    }
  }

  private async outcomeOf(rawBody: string, message: Message): Promise<MessageDecision> {
    let parsed: ReturnType<typeof parseWagerMessage>;
    try {
      parsed = parseWagerMessage(rawBody);
    } catch (error: unknown) {
      const context = bestEffortContextOf(rawBody);
      if (error instanceof ApplicationError && PERMANENT_INPUT_CODES.has(error.code)) {
        return { outcome: { kind: 'permanent', reason: `${error.code}: ${error.message}` }, context };
      }
      return { outcome: { kind: 'transient', reason: messageOf(error) }, context };
    }

    try {
      return {
        outcome: await this.consume.consume(
          {
            consumerName: this.options.consumerName,
            messageId: parsed.messageId,
            payloadHash: parsed.inboxPayloadHash,
            brokerMessageId: message.MessageId,
          },
          parsed.command,
        ),
        context: {
          messageId: parsed.messageId,
          correlationId: parsed.command.correlationId,
          walletId: parsed.command.walletId,
          providerId: parsed.command.providerId,
        },
      };
    } catch (error: unknown) {
      // The use case returns its known permanent outcomes. Anything that escapes
      // it is unexpected and must be retried, not silently converted into DLQ.
      return { outcome: { kind: 'transient', reason: messageOf(error) } };
    }
  }

  private async ack(queueUrl: string, message: Message): Promise<void> {
    await this.sqs.send(
      new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
    );
  }

  // The send precedes the delete on purpose: dying in between costs a duplicate
  // in the DLQ, dying the other way round would lose the message entirely.
  private async deadLetter(rawBody: string, message: Message): Promise<void> {
    const brokerMessageId = message.MessageId ?? '';
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: await this.urls.resolve(this.options.dlqQueue),
        MessageBody: rawBody,
        MessageGroupId: message.Attributes?.['MessageGroupId'] ?? brokerMessageId,
        MessageDeduplicationId: sha256Hex(
          `${this.options.consumerName}\0${brokerMessageId}\0${sha256Hex(rawBody)}`,
        ),
      }),
    );
  }

  private async returnForRetry(queueUrl: string, message: Message): Promise<void> {
    const receiveCount = Number.parseInt(
      message.Attributes?.['ApproximateReceiveCount'] ?? '1',
      10,
    );

    await this.changeVisibility(
      queueUrl,
      message,
      retryDelaySeconds(Number.isNaN(receiveCount) ? 1 : receiveCount),
    );
  }

  private async changeVisibility(
    queueUrl: string,
    message: Message,
    seconds: number,
  ): Promise<void> {
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorTypeOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

interface MessageDecision {
  readonly outcome: ConsumeOutcome;
  readonly context?:
    | {
        readonly messageId?: string;
        readonly correlationId?: string;
        readonly walletId?: string;
        readonly providerId?: string;
      }
    | undefined;
}

function safeReason(reason: string, fallback: string): string {
  const code = /^([A-Z][A-Z0-9_]+):/.exec(reason)?.[1];
  if (code !== undefined) {
    return code;
  }
  if (reason.includes('inbox row')) {
    return 'INBOX_INCOMPLETE';
  }
  if (reason.includes('messageId')) {
    return 'INBOX_PAYLOAD_CONFLICT';
  }
  return fallback;
}

function bestEffortContextOf(rawBody: string): MessageDecision['context'] {
  const envelope = objectOf(safeJson(rawBody));
  if (envelope === undefined) {
    return undefined;
  }

  const data = objectOf(envelope['data']) ?? {};
  const messageId = shortTextOf(envelope['messageId']);
  const walletId = shortTextOf(data['walletId']);
  const providerId = shortTextOf(data['providerId']);

  return {
    ...(messageId === undefined
      ? {}
      : { messageId, correlationId: correlationIdOf(CONSUMER_NAME, messageId) }),
    ...(walletId === undefined ? {} : { walletId }),
    ...(providerId === undefined ? {} : { providerId }),
  };
}

function safeJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return undefined;
  }
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function shortTextOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' && value.length <= 128
    ? value
    : undefined;
}
