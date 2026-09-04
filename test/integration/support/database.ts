import { SQL } from 'bun';

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
