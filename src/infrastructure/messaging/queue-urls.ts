import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';

export class QueueUrlCache {
  private readonly urls = new Map<string, Promise<string>>();

  constructor(private readonly sqs: SQSClient) {}

  resolve(queueName: string): Promise<string> {
    const cached = this.urls.get(queueName);
    if (cached !== undefined) {
      return cached;
    }

    const pending = this.sqs
      .send(new GetQueueUrlCommand({ QueueName: queueName }))
      .then((result) => {
        if (result.QueueUrl === undefined) {
          throw new Error(`queue ${queueName} has no url`);
        }
        return result.QueueUrl;
      });

    // A cached rejection would keep the queue unreachable for the whole process.
    pending.catch(() => this.urls.delete(queueName));
    this.urls.set(queueName, pending);
    return pending;
  }
}
