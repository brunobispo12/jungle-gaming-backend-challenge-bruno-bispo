import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';

import { AppModule } from '@/bootstrap/app.module';

// Shutting a consumer down waits out the in-flight 20 s long poll, which is the
// behaviour README §10 asks for; the hook has to outlast it.
const ROLES_TEST_TIMEOUT_MS = 45_000;

setDefaultTimeout(ROLES_TEST_TIMEOUT_MS);

let app: INestApplication;
let baseUrl: string;
let previousRoles: string | undefined;

beforeAll(async () => {
  previousRoles = process.env['APP_ROLES'];
  process.env['APP_ROLES'] = 'consumer';

  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, '127.0.0.1');

  const address = app.getHttpServer().address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('a instância sem papel api não expôs endereço TCP');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
}, ROLES_TEST_TIMEOUT_MS);

afterAll(async () => {
  await app.close();
  if (previousRoles === undefined) {
    delete process.env['APP_ROLES'];
  } else {
    process.env['APP_ROLES'] = previousRoles;
  }
}, ROLES_TEST_TIMEOUT_MS);

describe('instância sem o papel api', () => {
  test('continua raspável: health e métricas respondem', async () => {
    const live = await fetch(`${baseUrl}/health/live`);
    expect(live.status).toBe(200);

    const ready = await fetch(`${baseUrl}/health/ready`);
    expect(ready.status).toBe(200);

    const metrics = await fetch(`${baseUrl}/metrics`);
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get('content-type')).toContain('text/plain');
    expect(await metrics.text()).toContain('outbox_pending_messages');
  });

  test('não serve a API de negócio', async () => {
    const submit = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'provider-a:x' },
      body: JSON.stringify({}),
    });
    expect(submit.status).toBe(404);

    const wallets = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: 'p', initialBalance: { amount: '1.00', currency: 'BRL' } }),
    });
    expect(wallets.status).toBe(404);
  });
});
