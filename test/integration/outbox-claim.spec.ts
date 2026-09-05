import { MikroORM } from '@mikro-orm/postgresql';
import type { SQL } from 'bun';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { MikroOutboxClaimRepository } from '@/infrastructure/persistence/outbox-claim.repository';
import { runtimeOrmConfig } from '@/infrastructure/persistence/orm.config';
import { SCHEMAS } from '@/infrastructure/persistence/rows';
import { APP_URL, connect, MIGRATOR_URL, readOutboxRow, seedOutboxMessage } from './support/database';

const LEASE_MS = 30_000;

let orm: MikroORM;
let sql: SQL;
let outbox: MikroOutboxClaimRepository;

beforeAll(async () => {
  // The claim repository runs as the runtime role; only the fixture connection
  // keeps the migration credential, because it needs DELETE to reset the table.
  orm = await MikroORM.init({
    ...runtimeOrmConfig(APP_URL),
    entities: SCHEMAS,
    discovery: {},
  });
  sql = connect(MIGRATOR_URL);
  outbox = new MikroOutboxClaimRepository(orm);
});

afterAll(async () => {
  await orm.close(true);
  await sql.close();
});

beforeEach(async () => {
  await sql`DELETE FROM outbox_message`;
});

function claimAt(publisherId: string, now = new Date()): Promise<unknown> {
  return outbox.claim(publisherId, now, new Date(now.getTime() + LEASE_MS));
}

describe('MikroOutboxClaimRepository.claim', () => {
  test('reclama a mensagem elegível e devolve o envelope persistido', async () => {
    const seeded = await seedOutboxMessage(sql, { attempts: 2 });

    const claim = await outbox.claim('instance-1', new Date(), new Date(Date.now() + LEASE_MS));

    expect(claim).toEqual({
      id: seeded.id,
      eventId: seeded.eventId,
      eventType: seeded.eventType,
      aggregateId: seeded.aggregateId,
      payload: seeded.payload,
      attempts: 2,
    });
  });

  test('grava o lease do publisher na linha reclamada', async () => {
    const seeded = await seedOutboxMessage(sql);
    const now = new Date();

    await outbox.claim('instance-1', now, new Date(now.getTime() + LEASE_MS));

    const row = await readOutboxRow(sql, seeded.id);
    expect(row.claimed_by).toBe('instance-1');
    expect(row.claimed_until?.getTime()).toBe(now.getTime() + LEASE_MS);
    expect(row.published_at).toBeNull();
  });

  test('não reclama antes de next_attempt_at', async () => {
    await seedOutboxMessage(sql, { nextAttemptAt: new Date(Date.now() + 60_000) });

    expect(await claimAt('instance-1')).toBeUndefined();
  });

  test('não reclama mensagem já publicada', async () => {
    await seedOutboxMessage(sql, { publishedAt: new Date() });

    expect(await claimAt('instance-1')).toBeUndefined();
  });

  test('não reclama mensagem com lease ativo de outro publisher', async () => {
    await seedOutboxMessage(sql, {
      claimedBy: 'instance-2',
      claimedUntil: new Date(Date.now() + LEASE_MS),
    });

    expect(await claimAt('instance-1')).toBeUndefined();
  });

  test('reclama mensagem cujo lease expirou', async () => {
    const seeded = await seedOutboxMessage(sql, {
      claimedBy: 'instance-dead',
      claimedUntil: new Date(Date.now() - 1_000),
    });

    const claim = await claimAt('instance-1');

    expect(claim).toMatchObject({ id: seeded.id });
    expect((await readOutboxRow(sql, seeded.id)).claimed_by).toBe('instance-1');
  });

  test('publishers concorrentes não reclamam a mesma mensagem', async () => {
    const seeded = await seedOutboxMessage(sql);
    const now = new Date();
    const until = new Date(now.getTime() + LEASE_MS);

    const claims = await Promise.all([
      outbox.claim('instance-1', now, until),
      outbox.claim('instance-2', now, until),
    ]);

    const winners = claims.filter((claim) => claim !== undefined);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.id).toBe(seeded.id);
  });

  test('publishers concorrentes reclamam mensagens diferentes', async () => {
    await seedOutboxMessage(sql);
    await seedOutboxMessage(sql);
    const now = new Date();
    const until = new Date(now.getTime() + LEASE_MS);

    const claims = await Promise.all([
      outbox.claim('instance-1', now, until),
      outbox.claim('instance-2', now, until),
    ]);

    expect(claims[0]?.id).toBeDefined();
    expect(claims[1]?.id).toBeDefined();
    expect(claims[0]?.id).not.toBe(claims[1]?.id);
  });

  test('entrega a mensagem mais antiga primeiro', async () => {
    const older = await seedOutboxMessage(sql, { occurredAt: new Date(Date.now() - 60_000) });
    await seedOutboxMessage(sql, { occurredAt: new Date() });

    expect(await claimAt('instance-1')).toMatchObject({ id: older.id });
  });
});

describe('MikroOutboxClaimRepository.markPublished', () => {
  test('marca a publicação enquanto o lease é do publisher', async () => {
    const seeded = await seedOutboxMessage(sql);
    await claimAt('instance-1');
    const publishedAt = new Date();

    expect(await outbox.markPublished(seeded.id, 'instance-1', publishedAt)).toBe(true);

    const row = await readOutboxRow(sql, seeded.id);
    expect(row.published_at?.getTime()).toBe(publishedAt.getTime());
    expect(row.claimed_by).toBeNull();
    expect(row.claimed_until).toBeNull();
  });

  test('não marca quando outro publisher tomou o lease', async () => {
    const seeded = await seedOutboxMessage(sql);
    await claimAt('instance-1');
    await sql`UPDATE outbox_message SET claimed_by = 'instance-2' WHERE id = ${seeded.id}::uuid`;

    expect(await outbox.markPublished(seeded.id, 'instance-1', new Date())).toBe(false);
    expect((await readOutboxRow(sql, seeded.id)).published_at).toBeNull();
  });
});

describe('MikroOutboxClaimRepository.reschedule', () => {
  test('conta a tentativa, registra o erro e libera o lease', async () => {
    const seeded = await seedOutboxMessage(sql, { attempts: 1 });
    await claimAt('instance-1');
    const nextAttemptAt = new Date(Date.now() + 2_000);

    expect(
      await outbox.reschedule(seeded.id, 'instance-1', nextAttemptAt, 'sqs unavailable'),
    ).toBe(true);

    const row = await readOutboxRow(sql, seeded.id);
    expect(row.attempts).toBe(2);
    expect(row.next_attempt_at.getTime()).toBe(nextAttemptAt.getTime());
    expect(row.last_error).toBe('sqs unavailable');
    expect(row.claimed_by).toBeNull();
    expect(row.claimed_until).toBeNull();
    expect(row.published_at).toBeNull();
  });

  test('não reagenda quando outro publisher tomou o lease', async () => {
    const seeded = await seedOutboxMessage(sql);
    await claimAt('instance-1');
    await sql`UPDATE outbox_message SET claimed_by = 'instance-2' WHERE id = ${seeded.id}::uuid`;

    expect(await outbox.reschedule(seeded.id, 'instance-1', new Date(), 'boom')).toBe(false);
    expect((await readOutboxRow(sql, seeded.id)).attempts).toBe(0);
  });

  test('a mensagem reagendada volta a ser elegível no próximo horário', async () => {
    const seeded = await seedOutboxMessage(sql);
    await claimAt('instance-1');
    await outbox.reschedule(seeded.id, 'instance-1', new Date(Date.now() - 1), 'boom');

    expect(await claimAt('instance-2')).toMatchObject({ id: seeded.id, attempts: 1 });
  });
});
