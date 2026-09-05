import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

import type { EventPublisher, PublishableMessage } from '@/application/ports';
import type { JsonLogger } from '@/infrastructure/observability/json-logger';
import { QueueUrlCache } from './queue-urls';

export class SqsEventPublisher implements EventPublisher {
  private readonly urls: QueueUrlCache;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueName: string,
    private readonly sendTimeoutMs: number,
    private readonly logger: JsonLogger,
  ) {
    this.urls = new QueueUrlCache(sqs);
  }

  // The whole call, url resolution included, has to fit the budget the module
  // sizes against the lease: a resolution that hangs would otherwise let the
  // lease expire while this publisher still believes it owns the row.
  async publish(message: PublishableMessage): Promise<void> {
    const startedAt = performance.now();
    const queueUrl = await withTimeout(
      this.urls.resolve(this.queueName),
      this.sendTimeoutMs,
      'queue url resolution',
    );
    const remainingMs = Math.max(1, Math.round(this.sendTimeoutMs - (performance.now() - startedAt)));

    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify(message.payload),
          MessageGroupId: message.aggregateId,
          MessageDeduplicationId: message.eventId,
        }),
        { abortSignal: AbortSignal.timeout(remainingMs) },
      );
    } catch (error: unknown) {
      this.logger.write('warn', 'outbox publication failed', {
        ...describe(message),
        errorType: error instanceof Error ? error.name : typeof error,
      });
      throw error;
    }

    this.logger.write('info', 'outbox message published', describe(message));
  }
}

function describe(message: PublishableMessage): Record<string, unknown> {
  const payload = message.payload;
  return {
    eventId: message.eventId,
    aggregateId: message.aggregateId,
    ...textField(payload, 'eventType'),
    ...textField(payload, 'correlationId'),
  };
}

function textField(
  payload: Record<string, unknown>,
  field: string,
): Record<string, string> | Record<string, never> {
  const value = payload[field];
  return typeof value === 'string' ? { [field]: value } : {};
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}
