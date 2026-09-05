import { DeleteMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';

import { JsonLogger, type LogFields, type LogLevel } from '@/infrastructure/observability/json-logger';
import { CONSUMER_NAME } from '@/interface/sqs/envelope';
import { WagerConsumerWorker } from '@/interface/sqs/wager-consumer.worker';
import { DLQ_QUEUE, INPUT_QUEUE, sqsClient } from './sqs';
import { bootUseCases } from './use-cases';

const receiptPath = process.env['CRASH_RECEIPT_FILE'];
if (receiptPath === undefined || receiptPath === '') {
  throw new Error('CRASH_RECEIPT_FILE is required');
}

class CheckpointLogger extends JsonLogger {
  readonly lines: Array<{ level: LogLevel; message: string; fields: LogFields }> = [];

  constructor() {
    super({});
  }

  override write(level: LogLevel, message: string, fields: LogFields = {}): void {
    this.lines.push({ level, message, fields });
  }
}

const app = await bootUseCases();
const sqs = sqsClient();
const logger = new CheckpointLogger();
const originalSend = sqs.send.bind(sqs);

// Every real SQS operation is forwarded except DeleteMessage. Reaching this
// branch proves the real worker completed consume(), including its transaction,
// and is about to ACK. SIGKILL happens before the command reaches the client.
const crashingSqs = new Proxy(sqs, {
  get(target, property, receiver) {
    if (property === 'send') {
      return async (command: unknown): Promise<unknown> => {
        if (command instanceof DeleteMessageCommand) {
          const processed = logger.lines.find((line) => line.message === 'message processed');
          await Bun.write(
            receiptPath,
            JSON.stringify({
              phase: 'before-delete-message',
              receiptHandle: command.input.ReceiptHandle ?? '',
              processedLog: processed ?? null,
            }),
          );
          process.kill(process.pid, 'SIGKILL');
          return new Promise<never>(() => undefined);
        }
        return originalSend(command as never);
      };
    }

    const value = Reflect.get(target, property, receiver) as unknown;
    return typeof value === 'function' ? value.bind(target) : value;
  },
}) as SQSClient;

const worker = new WagerConsumerWorker(crashingSqs, app.consumeWagerMessage, logger, {
  enabled: false,
  consumerName: CONSUMER_NAME,
  inputQueue: INPUT_QUEUE,
  dlqQueue: DLQ_QUEUE,
  batchSize: 1,
  waitTimeSeconds: 10,
  visibilityTimeoutSeconds: 60,
  inFlightGraceMs: 1_000,
  shutdownWindowMs: 2_000,
});

await worker.pollOnce();
throw new Error('the worker returned without reaching DeleteMessage');
