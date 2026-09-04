import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';

import { AppModule } from '@/bootstrap/app.module';

const HTTP_TEST_TIMEOUT_MS = 20_000;

setDefaultTimeout(HTTP_TEST_TIMEOUT_MS);

let app: INestApplication;
let baseUrl: string;
let previousRoles: string | undefined;

interface WalletResponse {
  readonly id: string;
  readonly playerId: string;
  readonly balance: { readonly amount: string; readonly currency: string };
  readonly version: number;
}

interface ErrorResponse {
  readonly error: { readonly code: string; readonly correlationId: string };
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

async function createWallet(balance = '1000.00'): Promise<WalletResponse> {
  const playerId = `player-${suffix()}`;
  const response = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId,
      initialBalance: { amount: balance, currency: 'BRL' },
    }),
  });

  expect(response.status).toBe(201);
  return (await response.json()) as WalletResponse;
}

beforeAll(async () => {
  previousRoles = process.env['APP_ROLES'];
  process.env['APP_ROLES'] = 'api';

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
  if (previousRoles === undefined) {
    delete process.env['APP_ROLES'];
  } else {
    process.env['APP_ROLES'] = previousRoles;
  }
}, HTTP_TEST_TIMEOUT_MS);

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
});
