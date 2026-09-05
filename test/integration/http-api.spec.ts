import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { SQL } from 'bun';
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';

import { AppModule } from '@/bootstrap/app.module';
import { connect, expectWalletsMatchLedger, MIGRATOR_URL, uuid } from './support/database';

const HTTP_TEST_TIMEOUT_MS = 20_000;

// Short enough for the transient-failure case to answer inside a test instead of
// waiting out the 20 s production default.
const LOCK_TIMEOUT_MS = '500';

setDefaultTimeout(HTTP_TEST_TIMEOUT_MS);

let app: INestApplication;
let baseUrl: string;
let sql: SQL;
let previousRoles: string | undefined;
let previousLockTimeout: string | undefined;

interface WalletResponse {
  readonly id: string;
  readonly playerId: string;
  readonly balance: { readonly amount: string; readonly currency: string };
  readonly version: number;
}

interface ErrorResponse {
  readonly error: { readonly code: string; readonly correlationId: string };
}

interface WagerResponse {
  readonly transactionId: string;
  readonly status: string;
  readonly idempotentReplay: boolean;
}

interface LedgerEntryView {
  readonly id: string;
  readonly direction: string;
  readonly money: { readonly amount: string; readonly currency: string };
}

interface LedgerPageResponse {
  readonly items: readonly LedgerEntryView[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

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

async function submitWager(
  body: Record<string, unknown>,
  idempotencyKey = `${body['providerId'] as string}:${body['externalTransactionId'] as string}`,
): Promise<{ status: number; body: WagerResponse }> {
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify(body),
  });

  return { status: response.status, body: (await response.json()) as WagerResponse };
}

function suffix(): string {
  return crypto.randomUUID();
}

function wagerBody(
  wallet: { id: string; playerId: string },
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const id = suffix();
  return {
    providerId: 'provider-http',
    externalTransactionId: `transaction-${id}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: `round-${id}`,
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

const touched: string[] = [];

async function createWallet(
  balance = '1000.00',
  playerId = `player-${suffix()}`,
): Promise<WalletResponse> {
  const response = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId,
      initialBalance: { amount: balance, currency: 'BRL' },
    }),
  });

  expect(response.status).toBe(201);
  const wallet = (await response.json()) as WalletResponse;
  touched.push(wallet.id);
  return wallet;
}

beforeAll(async () => {
  previousRoles = process.env['APP_ROLES'];
  previousLockTimeout = process.env['WALLET_LOCK_TIMEOUT_MS'];
  process.env['APP_ROLES'] = 'api';
  process.env['WALLET_LOCK_TIMEOUT_MS'] = LOCK_TIMEOUT_MS;
  sql = connect(MIGRATOR_URL);

  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');

  const address = app.getHttpServer().address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('HTTP test server did not expose a TCP address');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
}, HTTP_TEST_TIMEOUT_MS);

afterAll(async () => {
  await app.close();
  await sql.close();
  restore('APP_ROLES', previousRoles);
  restore('WALLET_LOCK_TIMEOUT_MS', previousLockTimeout);
}, HTTP_TEST_TIMEOUT_MS);

afterEach(async () => {
  await expectWalletsMatchLedger(sql, touched.splice(0));
});

function restore(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
}

describe('API HTTP contra PostgreSQL real', () => {
  test('os exemplos normativos de wallet, aposta e replay preservam o contrato monetário', async () => {
    const wallet = await createWallet();
    expect(wallet).toEqual({
      id: expect.any(String),
      playerId: expect.any(String),
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });

    const body = wagerBody(wallet);
    const idempotencyKey = `${body['providerId']}:${body['externalTransactionId']}`;
    const first = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify(body),
    });
    const firstView = (await first.json()) as Record<string, unknown>;

    expect(first.status).toBe(201);
    expect(firstView).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });

    const replay = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify(body),
    });

    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ...firstView, idempotentReplay: true });
  });

  test('JSON malformado é payload inválido e ainda recebe correlation id', async () => {
    const response = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    const body = (await response.json()) as ErrorResponse;

    expect(response.status).toBe(400);
    expect(response.headers.get('x-correlation-id')).toBe(body.error.correlationId);
    expect(body.error.code).toBe('INVALID_PAYLOAD');
  });

  test('UUID, limites textuais e dinheiro invalidos respondem 400 deterministicamente', async () => {
    const wallet = await createWallet();
    const cases = [
      {
        url: `${baseUrl}/wagering/transactions`,
        body: wagerBody(wallet, { walletId: 'not-a-uuid' }),
      },
      {
        url: `${baseUrl}/wallets`,
        body: {
          playerId: 'p'.repeat(65),
          initialBalance: { amount: '1.00', currency: 'BRL' },
        },
      },
      {
        url: `${baseUrl}/wallets`,
        body: {
          playerId: `player-${suffix()}`,
          initialBalance: { amount: 'NaN', currency: 'BRL' },
        },
      },
      {
        url: `${baseUrl}/wallets`,
        body: {
          playerId: `player-${suffix()}`,
          initialBalance: { amount: '1.001', currency: 'BRL' },
        },
      },
    ];

    for (const candidate of cases) {
      const response = await fetch(candidate.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `provider-http:invalid-${suffix()}`,
        },
        body: JSON.stringify(candidate.body),
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as ErrorResponse).error.code).toBe('INVALID_PAYLOAD');
    }
  });

  test('wallet duplicada responde 409', async () => {
    const playerId = `player-${suffix()}`;
    const wallet = await createWallet('1000.00', playerId);
    const duplicate = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: '1000.00', currency: 'BRL' },
      }),
    });

    expect(duplicate.status).toBe(409);
    expect(((await duplicate.json()) as ErrorResponse).error.code).toBe('WALLET_ALREADY_EXISTS');
    expect(wallet.playerId).toBe(playerId);
  });

  test('header ausente, conflito, rejeição e pendência têm respostas distintas', async () => {
    const wallet = await createWallet('10.00');
    const body = wagerBody(wallet);

    const withoutKey = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(withoutKey.status).toBe(400);
    expect(((await withoutKey.json()) as ErrorResponse).error.code).toBe(
      'MISSING_IDEMPOTENCY_KEY',
    );

    const key = `provider-http:${body['externalTransactionId']}`;
    const rejected = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body),
    });
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toEqual(
      expect.objectContaining({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' }),
    );

    const conflict = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ ...body, money: { amount: '5.00', currency: 'BRL' } }),
    });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as ErrorResponse).error.code).toBe(
      'IDEMPOTENCY_KEY_CONFLICT',
    );

    const reusedExternalId = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `provider-http:different-${suffix()}`,
      },
      body: JSON.stringify(body),
    });
    expect(reusedExternalId.status).toBe(409);
    expect(((await reusedExternalId.json()) as ErrorResponse).error.code).toBe(
      'EXTERNAL_TRANSACTION_ID_REUSED',
    );

    const pendingBody = wagerBody(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: `missing-${suffix()}`,
      money: { amount: '5.00', currency: 'BRL' },
    });
    const pending = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `provider-http:${pendingBody['externalTransactionId']}`,
      },
      body: JSON.stringify(pendingBody),
    });
    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual(
      expect.objectContaining({ status: 'PENDING_REFERENCE', idempotentReplay: false }),
    );
  });

  test('expõe as métricas operacionais obrigatórias no formato Prometheus', async () => {
    const response = await fetch(`${baseUrl}/metrics`);
    const exposition = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(exposition).toContain('wager_transactions_total');
    expect(exposition).toContain('wager_duplicates_total');
    expect(exposition).toContain('http_requests_total');
    expect(exposition).toContain('http_request_duration_seconds');
    expect(exposition).toContain('wallet_lock_wait_seconds');
    expect(exposition).toContain('outbox_pending_messages');
    expect(exposition).toContain('outbox_oldest_pending_age_seconds');
    expect(exposition).toContain('sqs_dlq_visible_messages');
    expect(exposition).toMatch(/wager_transactions_total\{[^}\n]*source="http"[^}\n]*\} [1-9]/);
    expect(exposition).toContain('wager_duplicates_total{layer="business"} 1');
    expect(exposition).toMatch(/http_requests_total\{[^}\n]*route="\/wallets"[^}\n]*\}/);
    expect(exposition).not.toContain('1000.00');
    expect(exposition).not.toContain('975.00');
  });

  test('a wallet criada é consultável pelo seu identificador', async () => {
    const wallet = await createWallet();
    const response = await fetch(`${baseUrl}/wallets/${wallet.id}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: wallet.id,
      playerId: wallet.playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
  });

  test('recurso inexistente é 404 nas três consultas', async () => {
    const wallet = await fetch(`${baseUrl}/wallets/${uuid()}`);
    expect(wallet.status).toBe(404);
    expect(((await wallet.json()) as ErrorResponse).error.code).toBe('RESOURCE_NOT_FOUND');

    const transaction = await fetch(`${baseUrl}/wagering/transactions/${uuid()}`);
    expect(transaction.status).toBe(404);

    const byProvider = await fetch(
      `${baseUrl}/providers/provider-http/wagering/transactions/never-${suffix()}`,
    );
    expect(byProvider.status).toBe(404);
  });

  test('as duas consultas de transação devolvem a mesma submissão', async () => {
    const wallet = await createWallet();
    const body = wagerBody(wallet);
    const submitted = await submitWager(body);
    expect(submitted.status).toBe(201);

    const byId = await fetch(`${baseUrl}/wagering/transactions/${submitted.body.transactionId}`);
    const byProvider = await fetch(
      `${baseUrl}/providers/${body['providerId'] as string}` +
        `/wagering/transactions/${body['externalTransactionId'] as string}`,
    );

    expect(byId.status).toBe(200);
    expect(byProvider.status).toBe(200);

    const view = await byId.json();
    expect(view).toMatchObject({
      transactionId: submitted.body.transactionId,
      providerId: 'provider-http',
      externalTransactionId: body['externalTransactionId'],
      walletId: wallet.id,
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
    });
    expect(await byProvider.json()).toEqual(view);
  });

  test('o ledger pagina por cursor opaco, do mais recente para o mais antigo', async () => {
    const wallet = await createWallet();
    await submitWager(wagerBody(wallet));

    const first = await fetch(`${baseUrl}/wallets/${wallet.id}/ledger?limit=1`);
    const firstPage = (await first.json()) as LedgerPageResponse;

    expect(first.status).toBe(200);
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(firstPage.items[0]).toMatchObject({
      direction: 'DEBIT',
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '1000.00', currency: 'BRL' },
      balanceAfter: { amount: '975.00', currency: 'BRL' },
    });

    const cursor = encodeURIComponent(firstPage.nextCursor ?? '');
    const second = await fetch(`${baseUrl}/wallets/${wallet.id}/ledger?limit=1&cursor=${cursor}`);
    const secondPage = (await second.json()) as LedgerPageResponse;

    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]).toMatchObject({
      direction: 'CREDIT',
      money: { amount: '1000.00', currency: 'BRL' },
    });
    expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id);
    expect(secondPage.hasMore).toBe(false);
    expect(secondPage.nextCursor).toBeNull();
  });

  test('limite fora da faixa e cursor ilegível são payload inválido', async () => {
    const tooLarge = await fetch(`${baseUrl}/wallets/${uuid()}/ledger?limit=201`);
    expect(tooLarge.status).toBe(400);
    expect(((await tooLarge.json()) as ErrorResponse).error.code).toBe('INVALID_PAYLOAD');

    const broken = await fetch(`${baseUrl}/wallets/${uuid()}/ledger?cursor=not-a-cursor`);
    expect(broken.status).toBe(400);
  });

  test('a reconciliação relata divergência e não corrige o saldo materializado', async () => {
    const wallet = await createWallet();
    await submitWager(wagerBody(wallet));

    const consistent = await fetch(`${baseUrl}/wallets/${wallet.id}/reconciliation`, {
      method: 'POST',
    });

    expect(consistent.status).toBe(200);
    expect(await consistent.json()).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '975.00', currency: 'BRL' },
      calculatedBalance: { amount: '975.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });

    // A LOSS leaves a PROCESSED transaction with no entry, so the forged row does
    // not collide with the one-entry-per-transaction uniqueness.
    const orphan = await submitWager(
      wagerBody(wallet, { kind: 'LOSS', money: { amount: '5.00', currency: 'BRL' } }),
    );
    await sql`
      INSERT INTO wallet_ledger_entry (
        id, wallet_id, transaction_id, direction, amount, currency,
        balance_before, balance_after, created_at
      ) VALUES (
        ${uuid()}::uuid, ${wallet.id}::uuid, ${orphan.body.transactionId}::uuid,
        'DEBIT'::ledger_direction, 5.00::numeric, 'BRL',
        975.00::numeric, 970.00::numeric, now()
      )
    `;

    const divergent = await fetch(`${baseUrl}/wallets/${wallet.id}/reconciliation`, {
      method: 'POST',
    });

    expect(divergent.status).toBe(200);
    expect(await divergent.json()).toMatchObject({
      storedBalance: { amount: '975.00', currency: 'BRL' },
      calculatedBalance: { amount: '970.00', currency: 'BRL' },
      difference: { amount: '5.00', currency: 'BRL' },
      consistent: false,
      checkedEntries: 3,
    });

    const after = await fetch(`${baseUrl}/wallets/${wallet.id}`);
    expect(((await after.json()) as WalletResponse).balance).toEqual({
      amount: '975.00',
      currency: 'BRL',
    });

    // Administrative cleanup after proving the endpoint itself made no write.
    await sql`UPDATE wallet SET balance = 970.00 WHERE id = ${wallet.id}::uuid`;
  });

  test('reconcilia giro bruto acima do limite quando o saldo liquido continua valido', async () => {
    const maximum = '999999999999999999.99';
    const wallet = await createWallet(maximum);

    const bet = await submitWager(
      wagerBody(wallet, { money: { amount: '1.00', currency: 'BRL' } }),
    );
    expect(bet.status).toBe(201);

    const win = await submitWager(
      wagerBody(wallet, { kind: 'WIN', money: { amount: '1.00', currency: 'BRL' } }),
    );
    expect(win.status).toBe(201);

    const reconciliation = await fetch(`${baseUrl}/wallets/${wallet.id}/reconciliation`, {
      method: 'POST',
    });
    expect(reconciliation.status).toBe(200);
    expect(await reconciliation.json()).toMatchObject({
      walletId: wallet.id,
      storedBalance: { amount: maximum, currency: 'BRL' },
      calculatedBalance: { amount: maximum, currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 3,
    });
  });

  test('wallet travada por outra transação responde 503 com Retry-After', async () => {
    const wallet = await createWallet();
    const holder = connect(MIGRATOR_URL);
    const acquired = gate();
    const release = gate();

    const holding = holder.begin(async (tx) => {
      await tx`SELECT id FROM wallet WHERE id = ${wallet.id}::uuid FOR UPDATE`;
      acquired.open();
      await release.wait;
    });

    try {
      await acquired.wait;
      const response = await fetch(`${baseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `provider-http:contended-${suffix()}`,
        },
        body: JSON.stringify(wagerBody(wallet)),
      });

      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('1');
      expect(((await response.json()) as ErrorResponse).error.code).toBe('SERVICE_UNAVAILABLE');
    } finally {
      release.open();
      await holding;
      await holder.close();
    }
  });
});
