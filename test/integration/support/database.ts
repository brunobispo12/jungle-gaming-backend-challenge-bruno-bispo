import { SQL } from 'bun';
import { expect } from 'bun:test';

import { Money } from '@/domain/money';

export const MIGRATOR_URL =
  process.env['TEST_DATABASE_MIGRATION_URL'] ??
  'postgres://wagering_migrator:wagering_migrator@localhost:55432/wagering';

export const APP_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgres://wagering_app:wagering_app@localhost:55432/wagering';

export function connect(url: string): SQL {
  return new SQL(url);
}

export interface PgFailure {
  readonly sqlstate: string;
  readonly message: string;
}

export async function expectSqlFailure(run: () => Promise<unknown>): Promise<PgFailure> {
  try {
    await run();
  } catch (error: unknown) {
    const fields = error as Record<string, unknown>;
    return {
      sqlstate: String(fields['errno'] ?? ''),
      message: String(fields['message'] ?? ''),
    };
  }
  throw new Error('a operação deveria ter falhado no banco, mas foi aceita');
}

let sequence = 0;

export function uniqueSuffix(): string {
  sequence += 1;
  return `${Date.now().toString(36)}-${sequence}`;
}

export function uuid(): string {
  return crypto.randomUUID();
}

export interface SeededWallet {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: string;
}

export async function seedWallet(
  sql: SQL,
  overrides: { currency?: string; balance?: string } = {},
): Promise<SeededWallet> {
  const wallet: SeededWallet = {
    id: uuid(),
    playerId: `player-${uniqueSuffix()}`,
    currency: overrides.currency ?? 'BRL',
    balance: overrides.balance ?? '1000.00',
  };

  await sql`
    INSERT INTO wallet (id, player_id, currency, balance, version, created_at, updated_at)
    VALUES (${wallet.id}::uuid, ${wallet.playerId}, ${wallet.currency}, ${wallet.balance}::numeric,
            1, now(), now())
  `;

  return wallet;
}

export interface SeedWagerOptions {
  readonly walletId: string;
  readonly playerId: string;
  readonly currency: string;
  readonly kind: 'OPENING' | 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  readonly status: 'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';
  readonly amount?: string;
  readonly providerId?: string;
  readonly resultBalanceAmount?: string | null;
  readonly resultBalanceCurrency?: string | null;
  readonly failureCode?: string | null;
  readonly referenceExternalTransactionId?: string | null;
  readonly referenceTransactionId?: string | null;
}

export async function seedWager(sql: SQL, options: SeedWagerOptions): Promise<string> {
  const id = uuid();
  const suffix = uniqueSuffix();
  const providerId = options.providerId ?? 'provider-a';
  const terminal = ['PROCESSED', 'REJECTED', 'FAILED'].includes(options.status);

  const resultBalanceAmount =
    options.resultBalanceAmount === undefined ? '1000.00' : options.resultBalanceAmount;
  const resultBalanceCurrency =
    options.resultBalanceCurrency === undefined ? options.currency : options.resultBalanceCurrency;

  await sql`
    INSERT INTO wager_transaction (
      id, provider_id, external_transaction_id, idempotency_key, payload_hash,
      wallet_id, player_id, round_id, game_id, kind, amount, currency,
      reference_external_transaction_id, reference_transaction_id,
      status, failure_code, result_balance_amount, result_balance_currency,
      attempts, next_attempt_at, expires_at, correlation_id, created_at, processed_at
    ) VALUES (
      ${id}::uuid, ${providerId}, ${`external-${suffix}`}, ${`${providerId}:external-${suffix}`},
      ${'a'.repeat(64)},
      ${options.walletId}::uuid, ${options.playerId}, ${`round-${suffix}`}, 'fortune-chimp',
      ${options.kind}::wager_transaction_kind, ${options.amount ?? '25.00'}::numeric, ${options.currency},
      ${options.referenceExternalTransactionId ?? null},
      ${options.referenceTransactionId ?? null}::uuid,
      ${options.status}::wager_transaction_status,
      ${options.failureCode ?? null}::wager_failure_code,
      ${resultBalanceAmount}::numeric,
      ${resultBalanceCurrency},
      0,
      ${options.status === 'PENDING_REFERENCE' ? new Date() : null},
      ${options.status === 'PENDING_REFERENCE' ? new Date() : null},
      ${`correlation-${suffix}`}, now(),
      ${terminal ? new Date() : null}
    )
  `;

  return id;
}

export async function seedLedgerEntry(
  sql: SQL,
  entry: {
    walletId: string;
    transactionId: string;
    currency: string;
    direction: 'DEBIT' | 'CREDIT';
    amount: string;
    balanceBefore: string;
    balanceAfter: string;
  },
): Promise<string> {
  const id = uuid();
  await sql`
    INSERT INTO wallet_ledger_entry (
      id, wallet_id, transaction_id, direction, amount, currency,
      balance_before, balance_after, created_at
    ) VALUES (
      ${id}::uuid, ${entry.walletId}::uuid, ${entry.transactionId}::uuid,
      ${entry.direction}::ledger_direction, ${entry.amount}::numeric, ${entry.currency},
      ${entry.balanceBefore}::numeric, ${entry.balanceAfter}::numeric, now()
    )
  `;
  return id;
}

export interface SeedOutboxOptions {
  readonly eventType?: string;
  readonly aggregateId?: string;
  readonly payload?: Record<string, unknown>;
  readonly occurredAt?: Date;
  readonly attempts?: number;
  readonly nextAttemptAt?: Date;
  readonly claimedBy?: string | null;
  readonly claimedUntil?: Date | null;
  readonly publishedAt?: Date | null;
}

export interface SeededOutboxMessage {
  readonly id: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
}

export async function seedOutboxMessage(
  sql: SQL,
  options: SeedOutboxOptions = {},
): Promise<SeededOutboxMessage> {
  const id = uuid();
  const eventId = uuid();
  const eventType = options.eventType ?? 'WagerTransactionProcessed';
  const aggregateId = options.aggregateId ?? uuid();
  const payload = options.payload ?? { eventId, eventType, aggregateId };
  const occurredAt = options.occurredAt ?? new Date();

  await sql`
    INSERT INTO outbox_message (
      id, event_id, aggregate_id, event_type, payload, occurred_at,
      attempts, next_attempt_at, claimed_by, claimed_until, last_error, published_at
    ) VALUES (
      ${id}::uuid, ${eventId}::uuid, ${aggregateId}, ${eventType},
      ${payload}::jsonb, ${occurredAt},
      ${options.attempts ?? 0}, ${options.nextAttemptAt ?? occurredAt},
      ${options.claimedBy ?? null}, ${options.claimedUntil ?? null},
      NULL, ${options.publishedAt ?? null}
    )
  `;

  return { id, eventId, eventType, aggregateId, payload };
}

export interface OutboxRow {
  readonly attempts: number;
  readonly next_attempt_at: Date;
  readonly claimed_by: string | null;
  readonly claimed_until: Date | null;
  readonly last_error: string | null;
  readonly published_at: Date | null;
}

export async function readOutboxRow(sql: SQL, id: string): Promise<OutboxRow> {
  const rows = await sql`
    SELECT attempts, next_attempt_at, claimed_by, claimed_until, last_error, published_at
    FROM outbox_message WHERE id = ${id}::uuid
  `;
  const row = (rows as OutboxRow[])[0];
  if (row === undefined) {
    throw new Error(`outbox_message ${id} não existe`);
  }
  return row;
}

// The closing invariant README §13 demands of every test. The reconstruction
// runs in Money, so a currency that drifted throws instead of comparing numbers.
export async function expectWalletsMatchLedger(
  sql: SQL,
  walletIds: readonly string[],
): Promise<void> {
  for (const walletId of walletIds) {
    const rows = (await sql`
      SELECT
        w.balance::text  AS balance,
        w.currency       AS currency,
        COALESCE(
          SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END),
          0
        )::text AS reconstructed
      FROM wallet w
      LEFT JOIN wallet_ledger_entry l ON l.wallet_id = w.id
      WHERE w.id = ${walletId}::uuid
      GROUP BY w.balance, w.currency
    `) as { balance: string; currency: string; reconstructed: string }[];

    const row = rows[0];
    if (row === undefined) {
      throw new Error(`wallet ${walletId} não existe: a invariante final não pode ser verificada`);
    }

    const money = (amount: string): Money =>
      amount.startsWith('-')
        ? Money.from({ amount: amount.slice(1), currency: row.currency }).negate()
        : Money.from({ amount, currency: row.currency });
    const reconstructed = money(row.reconstructed);

    expect(reconstructed.toString()).toBe(money(row.balance).toString());
  }
}
