import type { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { SQL } from 'bun';
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';

import { PublishOutboxMessageUseCase } from '@/application/use-cases/publish-outbox-message';
import { SystemClock } from '@/infrastructure/adapters';
import { SqsEventPublisher } from '@/infrastructure/messaging/sqs-event-publisher';
import { runtimeOrmConfig } from '@/infrastructure/persistence/orm.config';
import { MikroOutboxClaimRepository } from '@/infrastructure/persistence/outbox-claim.repository';
import { SCHEMAS } from '@/infrastructure/persistence/rows';
import { APP_URL, connect, MIGRATOR_URL, readOutboxRow, seedOutboxMessage } from './support/database';
import { silentLogger } from './support/logging';
import { drainQueue, EVENTS_QUEUE, queueUrl, receiveMessages, sqsClient } from './support/sqs';

const LEASE_MS = 30_000;
const SEND_TIMEOUT_MS = 10_000;
const SQS_TEST_TIMEOUT_MS = 15_000;

setDefaultTimeout(SQS_TEST_TIMEOUT_MS);

let orm: MikroORM;
let sql: SQL;
let sqs: SQSClient;
let eventsUrl: string;
let outbox: MikroOutboxClaimRepository;
let publisher: SqsEventPublisher;

function useCaseOf(publisherId: string, events = publisher): PublishOutboxMessageUseCase {
  return new PublishOutboxMessageUseCase(
    outbox,
    events,
    new SystemClock(),
    { publisherId, leaseMs: LEASE_MS },
    Math.random,
  );
}

beforeAll(async () => {
  orm = await MikroORM.init({
    ...runtimeOrmConfig(APP_URL),
    entities: SCHEMAS,
    discovery: {},
  });
  sql = connect(MIGRATOR_URL);
  sqs = sqsClient();
  eventsUrl = await queueUrl(sqs, EVENTS_QUEUE);
  outbox = new MikroOutboxClaimRepository(orm);
  publisher = new SqsEventPublisher(sqs, EVENTS_QUEUE, SEND_TIMEOUT_MS, silentLogger());
}, SQS_TEST_TIMEOUT_MS);

afterAll(async () => {
  await orm.close(true);
  await sql.close();
  sqs.destroy();
}, SQS_TEST_TIMEOUT_MS);

beforeEach(async () => {
  await sql`DELETE FROM outbox_message`;
  await drainQueue(sqs, eventsUrl);
}, SQS_TEST_TIMEOUT_MS);

describe('SqsEventPublisher', () => {
  test('envia o envelope com dedup por eventId e grupo por aggregateId', async () => {
    const seeded = await seedOutboxMessage(sql);

    await publisher.publish({
      eventId: seeded.eventId,
      aggregateId: seeded.aggregateId,
      payload: seeded.payload,
    });

    const [message] = await receiveMessages(sqs, eventsUrl);
    expect(JSON.parse(message?.Body ?? '{}')).toEqual(seeded.payload);
    expect(message?.Attributes?.['MessageGroupId']).toBe(seeded.aggregateId);
    expect(message?.Attributes?.['MessageDeduplicationId']).toBe(seeded.eventId);
  });

  test('a fila inexistente falha o envio em vez de descartar o evento', async () => {
    const broken = new SqsEventPublisher(sqs, 'missing-queue.fifo', SEND_TIMEOUT_MS, silentLogger());

    await expect(
      broken.publish({
        eventId: 'event-1',
        aggregateId: 'aggregate-1',
        payload: {},
      }),
    ).rejects.toThrow();
  });
});

describe('PublishOutboxMessageUseCase sobre PostgreSQL e SQS reais', () => {
  test('publica a mensagem pendente e marca published_at', async () => {
    const seeded = await seedOutboxMessage(sql);

    expect(await useCaseOf('instance-1').run()).toBe('published');

    const row = await readOutboxRow(sql, seeded.id);
    expect(row.published_at).not.toBeNull();
    expect(row.claimed_by).toBeNull();
    expect(row.attempts).toBe(0);

    const [message] = await receiveMessages(sqs, eventsUrl);
    expect(JSON.parse(message?.Body ?? '{}')).toEqual(seeded.payload);
  });

  test('não republica a mensagem já publicada', async () => {
    await seedOutboxMessage(sql);
    await useCaseOf('instance-1').run();
    await drainQueue(sqs, eventsUrl);

    expect(await useCaseOf('instance-1').run()).toBe('idle');
    expect(await receiveMessages(sqs, eventsUrl, 2)).toEqual([]);
  });

  test('outra instância assume o lease do publisher morto e publica o evento', async () => {
    const seeded = await seedOutboxMessage(sql);
    await outbox.claim('instance-dead', new Date(), new Date(Date.now() + LEASE_MS));
    await sql`
      UPDATE outbox_message SET claimed_until = now() - interval '1 second'
      WHERE id = ${seeded.id}::uuid
    `;

    expect(await useCaseOf('instance-2').run()).toBe('published');

    const row = await readOutboxRow(sql, seeded.id);
    expect(row.published_at).not.toBeNull();
    expect(row.claimed_by).toBeNull();

    const [message] = await receiveMessages(sqs, eventsUrl);
    expect(JSON.parse(message?.Body ?? '{}')).toEqual(seeded.payload);
  });

  test('o mesmo eventId publicado duas vezes é entregue uma vez', async () => {
    const seeded = await seedOutboxMessage(sql);
    const envelope = {
      eventId: seeded.eventId,
      aggregateId: seeded.aggregateId,
      payload: seeded.payload,
    };

    await publisher.publish(envelope);
    await publisher.publish(envelope);

    expect(await receiveMessages(sqs, eventsUrl, 4)).toHaveLength(1);
  });

  test('falha no envio conta a tentativa e mantém a mensagem elegível', async () => {
    const seeded = await seedOutboxMessage(sql);
    const broken = new SqsEventPublisher(sqs, 'missing-queue.fifo', SEND_TIMEOUT_MS, silentLogger());

    expect(await useCaseOf('instance-1', broken).run()).toBe('retry-scheduled');

    const row = await readOutboxRow(sql, seeded.id);
    expect(row.attempts).toBe(1);
    expect(row.published_at).toBeNull();
    expect(row.claimed_by).toBeNull();
    expect(row.last_error).not.toBeNull();
    expect(row.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
  });

  // The property, not the schedule: whatever order the two publishers interleave
  // in, every row is published exactly once and none is left behind.
  test('dois publishers concorrentes drenam a mesma outbox sem perder nem repetir', async () => {
    const pending = 30;
    for (let index = 0; index < pending; index += 1) {
      await seedOutboxMessage(sql);
    }

    const barrier = gate();
    const drain = async (publisherId: string): Promise<string[]> => {
      const outcomes: string[] = [];
      await barrier.wait;

      for (let guard = 0; guard <= pending * 2; guard += 1) {
        const outcome = await useCaseOf(publisherId).run();
        outcomes.push(outcome);
        if (outcome === 'idle') {
          return outcomes;
        }
      }
      throw new Error(`${publisherId} não drenou a outbox dentro do limite`);
    };

    const both = Promise.all([drain('instance-1'), drain('instance-2')]);
    barrier.open();
    const [first, second] = await both;
    const outcomes = [...first, ...second];

    expect(outcomes.filter((outcome) => outcome === 'published')).toHaveLength(pending);
    // Without this the same numbers would pass if one publisher had done all the
    // work and the other had only ever seen an empty outbox.
    expect(first.filter((outcome) => outcome === 'published').length).toBeGreaterThan(0);
    expect(second.filter((outcome) => outcome === 'published').length).toBeGreaterThan(0);

    const rows = (await sql`
      SELECT
        count(*) FILTER (WHERE published_at IS NULL)::int  AS unpublished,
        count(*) FILTER (WHERE claimed_by IS NOT NULL)::int AS still_claimed
      FROM outbox_message
    `) as { unpublished: number; still_claimed: number }[];

    expect(rows[0]).toEqual({ unpublished: 0, still_claimed: 0 });
  }, 60_000);
});

interface Gate {
  readonly wait: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}
