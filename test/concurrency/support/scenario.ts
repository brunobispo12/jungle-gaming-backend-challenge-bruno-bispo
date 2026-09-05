import { SQL } from 'bun';

import { Money } from '@/domain/money';
import type { Cluster } from './cluster';

export const MIGRATOR_URL =
  'postgres://wagering_migrator:wagering_migrator@localhost:55432/wagering';

export interface Gate {
  readonly wait: Promise<void>;
  open(): void;
}

// Every task parks on the same promise, so releasing it puts all of them in
// flight within one microtask flush. No sleeps, so the race is reproducible.
export function gate(): Gate {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

export async function inParallel<T>(tasks: readonly (() => Promise<T>)[]): Promise<T[]> {
  const barrier = gate();
  const running = tasks.map(async (task) => {
    await barrier.wait;
    return task();
  });
  barrier.open();
  return Promise.all(running);
}

export interface WagerResponse {
  readonly status: number;
  readonly body: {
    transactionId?: string;
    status?: string;
    balance?: { amount: string; currency: string };
    failureCode?: string;
    idempotentReplay?: boolean;
    error?: { code: string };
  };
}

export interface WagerRequest {
  readonly externalTransactionId: string;
  readonly idempotencyKey?: string | undefined;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId?: string | undefined;
  readonly kind: string;
  readonly amount: string;
  readonly referenceExternalTransactionId?: string | undefined;
}

export async function submitWager(url: string, request: WagerRequest): Promise<WagerResponse> {
  const response = await fetch(`${url}/wagering/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Idempotency-Key': request.idempotencyKey ?? `provider-a:${request.externalTransactionId}`,
    },
    body: JSON.stringify({
      providerId: 'provider-a',
      externalTransactionId: request.externalTransactionId,
      playerId: request.playerId,
      walletId: request.walletId,
      roundId: request.roundId ?? `round-${request.externalTransactionId}`,
      gameId: 'fortune-chimp',
      kind: request.kind,
      money: { amount: request.amount, currency: 'BRL' },
      ...(request.referenceExternalTransactionId === undefined
        ? {}
        : { referenceExternalTransactionId: request.referenceExternalTransactionId }),
    }),
  });

  return { status: response.status, body: (await response.json()) as WagerResponse['body'] };
}

export interface OpenedWallet {
  readonly id: string;
  readonly playerId: string;
}

export async function openWallet(
  cluster: Cluster,
  balance: string,
  label: string,
): Promise<OpenedWallet> {
  const playerId = `player-${label}-${crypto.randomUUID().slice(0, 8)}`;
  const response = await fetch(`${cluster.next()}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount: balance, currency: 'BRL' } }),
  });

  const body = (await response.json()) as { id: string };
  return { id: body.id, playerId };
}

export interface WalletState {
  readonly balance: Money;
  readonly reconstructed: Money;
  readonly debits: number;
  readonly credits: number;
}

export async function inspectWallet(sql: SQL, walletId: string): Promise<WalletState> {
  const rows = (await sql`
    SELECT
      w.balance::text AS balance,
      w.currency AS currency,
      COALESCE(
        SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END),
        0
      )::text AS reconstructed,
      COUNT(*) FILTER (WHERE l.direction = 'DEBIT')::int AS debits,
      COUNT(*) FILTER (WHERE l.direction = 'CREDIT')::int AS credits
    FROM wallet w
    LEFT JOIN wallet_ledger_entry l ON l.wallet_id = w.id
    WHERE w.id = ${walletId}::uuid
    GROUP BY w.balance, w.currency
  `) as {
    balance: string;
    currency: string;
    reconstructed: string;
    debits: number;
    credits: number;
  }[];

  const row = rows[0];
  if (!row) {
    throw new Error(`wallet ${walletId} not found`);
  }

  const money = (amount: string): Money =>
    amount.startsWith('-')
      ? Money.from({ amount: amount.slice(1), currency: row.currency }).negate()
      : Money.from({ amount, currency: row.currency });

  return {
    balance: money(row.balance),
    reconstructed: money(row.reconstructed),
    debits: row.debits,
    credits: row.credits,
  };
}

export function connectDatabase(): SQL {
  return new SQL(MIGRATOR_URL);
}
