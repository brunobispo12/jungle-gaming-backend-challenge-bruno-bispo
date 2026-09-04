import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';

export const EVENTS_QUEUE = 'wager-events.fifo';
export const INPUT_QUEUE = 'wager-transactions.fifo';
export const DLQ_QUEUE = 'wager-transactions-dlq.fifo';

export async function sendRaw(
  sqs: SQSClient,
  url: string,
  body: string,
  fifo: { groupId: string; deduplicationId: string },
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: url,
      MessageBody: body,
      MessageGroupId: fifo.groupId,
      MessageDeduplicationId: fifo.deduplicationId,
    }),
  );
}

export function sqsClient(): SQSClient {
  return new SQSClient({
    region: process.env['AWS_REGION'] ?? 'us-east-1',
    endpoint: process.env['AWS_ENDPOINT_URL'] ?? 'http://localhost:54566',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
}

export async function queueUrl(sqs: SQSClient, queueName: string): Promise<string> {
  const result = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
  if (result.QueueUrl === undefined) {
    throw new Error(`fila ${queueName} não tem url`);
  }
  return result.QueueUrl;
}

async function receiveBatch(sqs: SQSClient, url: string, waitSeconds: number): Promise<Message[]> {
  const result = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: url,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: waitSeconds,
      MessageSystemAttributeNames: ['All'],
    }),
  );
  return result.Messages ?? [];
}

async function deleteBatch(sqs: SQSClient, url: string, messages: Message[]): Promise<void> {
  await Promise.all(
    messages.map((message) =>
      sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle })),
    ),
  );
}

export async function drainQueue(sqs: SQSClient, url: string): Promise<void> {
  for (let empty = 0; empty < 2; ) {
    const messages = await receiveBatch(sqs, url, 0);
    if (messages.length === 0) {
      empty += 1;
      continue;
    }
    empty = 0;
    await deleteBatch(sqs, url, messages);
  }
}

// Polls a fixed number of times instead of stopping at the first hit, so a test
// that expects exactly one delivery still observes an unwanted second one.
export async function receiveMessages(sqs: SQSClient, url: string, polls = 3): Promise<Message[]> {
  const collected: Message[] = [];
  for (let poll = 0; poll < polls; poll += 1) {
    const messages = await receiveBatch(sqs, url, 1);
    collected.push(...messages);
    await deleteBatch(sqs, url, messages);
  }
  return collected;
}
