import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

import type { EventPublisher, PublishableMessage } from '@/application/ports';
import { QueueUrlCache } from './queue-urls';

export class SqsEventPublisher implements EventPublisher {
  private readonly urls: QueueUrlCache;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueName: string,
    private readonly sendTimeoutMs: number,
  ) {
    this.urls = new QueueUrlCache(sqs);
  }

  async publish(message: PublishableMessage): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: await this.urls.resolve(this.queueName),
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.eventId,
      }),
      { abortSignal: AbortSignal.timeout(this.sendTimeoutMs) },
    );
  }
}
