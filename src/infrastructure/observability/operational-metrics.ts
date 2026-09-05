import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';

import { QueueUrlCache } from '@/infrastructure/messaging/queue-urls';

export interface OutboxState {
  readonly pending: number;
  readonly oldestAgeSeconds: number;
}

export interface OperationalMetricsSource {
  outboxState(): Promise<OutboxState>;
  dlqVisibleMessages(): Promise<number>;
}

interface OutboxStateRow {
  readonly pending: string;
  readonly oldest_age_seconds: string;
}

export class PostgresSqsOperationalMetrics implements OperationalMetricsSource {
  private readonly urls: QueueUrlCache;

  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly dlqName: string,
  ) {
    this.urls = new QueueUrlCache(sqs);
  }

  async dlqVisibleMessages(): Promise<number> {
    const result = await this.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: await this.urls.resolve(this.dlqName),
        AttributeNames: ['ApproximateNumberOfMessages'],
      }),
    );
    return nonNegativeNumber(result.Attributes?.['ApproximateNumberOfMessages']);
  }

  async outboxState(): Promise<OutboxState> {
    const [row] = await this.orm.em.fork().getConnection().execute<OutboxStateRow[]>(
      `SELECT
         COUNT(*)::text AS pending,
         COALESCE(
           EXTRACT(EPOCH FROM (clock_timestamp() - MIN(occurred_at))),
           0
         )::text AS oldest_age_seconds
       FROM outbox_message
       WHERE published_at IS NULL`,
      [],
      'all',
    );

    return {
      pending: nonNegativeNumber(row?.pending),
      oldestAgeSeconds: nonNegativeNumber(row?.oldest_age_seconds),
    };
  }
}

function nonNegativeNumber(value: string | undefined): number {
  const parsed = Number(value ?? '0');
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
