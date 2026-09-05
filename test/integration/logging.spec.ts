import type { SQL } from 'bun';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { Response } from 'express';

import type { CreateWalletUseCase } from '@/application/use-cases/create-wallet';
import { JsonLogger, type LogFields, type LogLevel } from '@/infrastructure/observability/json-logger';
import { TrustedProviderIdentityAdapter } from '@/infrastructure/security/trusted-provider-identity';
import { WageringController } from '@/interface/http/wagering.controller';
import {
  MIGRATOR_URL,
  connect,
  expectWalletsMatchLedger,
  uniqueSuffix,
} from './support/database';
import { bootUseCases, type UseCases } from './support/use-cases';

// The forbidden substrings are the concrete amounts this suite moves, so a log
// line that leaked any monetary field would fail on its value, not on its name.
const OPENING_BALANCE = '500.00';
const BET_AMOUNT = '25.00';
const RESULTING_BALANCE = '475.00';
const OVERDRAFT_AMOUNT = '900.00';

class CapturingLogger extends JsonLogger {
  readonly lines: { level: LogLevel; message: string; fields: LogFields }[] = [];

  constructor() {
    super({});
  }

  override write(level: LogLevel, message: string, fields: LogFields = {}): void {
    this.lines.push({ level, message, fields });
  }
}

let app: UseCases;
let sql: SQL;
let logger: CapturingLogger;
let controller: WageringController;

beforeAll(async () => {
  app = await bootUseCases();
  sql = connect(MIGRATOR_URL);
  logger = new CapturingLogger();
  controller = new WageringController(
    app.createWallet as unknown as CreateWalletUseCase,
    app.submitWager,
    app.reconcileWallet,
    app.unitOfWork,
    new TrustedProviderIdentityAdapter(),
    logger,
  );
});

afterAll(async () => {
  await app.close();
  await sql.end();
});

const touched: string[] = [];

afterEach(async () => {
  await expectWalletsMatchLedger(sql, touched.splice(0));
});

function fakeResponse(correlationId: string = crypto.randomUUID()): Response {
  return {
    locals: { requestContext: { correlationId, requestId: crypto.randomUUID() } },
    status: () => undefined,
    setHeader: () => undefined,
    getHeader: () => undefined,
  } as unknown as Response;
}

function isForbiddenLogKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return (
    normalized === 'payload' ||
    normalized === 'financialdata' ||
    /(amount|balance|money|credential|password|secret|authorization|accesskey|token)/.test(
      normalized,
    )
  );
}

function forbiddenLogPaths(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => forbiddenLogPaths(item, `${path}[${index}]`));
  }
  if (typeof value !== 'object' || value === null) {
    return [];
  }

  return Object.entries(value).flatMap(([key, child]) => {
    const childPath = `${path}.${key}`;
    return [
      ...(isForbiddenLogKey(key) ? [childPath] : []),
      ...forbiddenLogPaths(child, childPath),
    ];
  });
}

function expectSafeLogs(lines: CapturingLogger['lines']): void {
  for (const line of lines) {
    const serialized = JSON.stringify(line);
    expect(serialized).not.toContain(OPENING_BALANCE);
    expect(serialized).not.toContain(BET_AMOUNT);
    expect(serialized).not.toContain(RESULTING_BALANCE);
    expect(serialized).not.toContain(OVERDRAFT_AMOUNT);
    expect(forbiddenLogPaths(line)).toEqual([]);
  }
}

interface OpenedWallet {
  readonly id: string;
  readonly playerId: string;
}

async function openWallet(): Promise<OpenedWallet> {
  const playerId = `player-${uniqueSuffix()}`;
  const created = (await controller.postWallet(
    { playerId, initialBalance: { amount: OPENING_BALANCE, currency: 'BRL' } },
    fakeResponse(),
  )) as { id: string };

  touched.push(created.id);
  return { id: created.id, playerId };
}

function wagerBody(wallet: OpenedWallet, amount: string): Record<string, unknown> {
  const suffix = uniqueSuffix();
  return {
    providerId: 'provider-a',
    externalTransactionId: `external-${suffix}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: `round-${suffix}`,
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}

describe('TST-045 logs estruturados sem payload financeiro', () => {
  test('a submissão é correlacionável pelos identificadores exigidos', async () => {
    const wallet = await openWallet();
    logger.lines.length = 0;

    const body = wagerBody(wallet, BET_AMOUNT);
    await controller.postWager(
      body,
      `provider-a:${body['externalTransactionId'] as string}`,
      undefined,
      fakeResponse(),
    );

    const completed = logger.lines.filter(
      (line) => line.message === 'wager transaction completed',
    );

    expect(completed).toHaveLength(1);
    expect(completed[0]?.fields).toMatchObject({
      correlationId: expect.any(String),
      transactionId: expect.any(String),
      walletId: wallet.id,
      providerId: 'provider-a',
      kind: 'BET',
      status: 'PROCESSED',
      idempotentReplay: false,
    });
  });

  test('nenhuma linha carrega valor, saldo ou o payload financeiro completo', async () => {
    const wallet = await openWallet();
    logger.lines.length = 0;

    const applied = wagerBody(wallet, BET_AMOUNT);
    await controller.postWager(
      applied,
      `provider-a:${applied['externalTransactionId'] as string}`,
      undefined,
      fakeResponse(),
    );

    const rejected = wagerBody(wallet, OVERDRAFT_AMOUNT);
    await controller.postWager(
      rejected,
      `provider-a:${rejected['externalTransactionId'] as string}`,
      undefined,
      fakeResponse(),
    );

    expect(logger.lines.length).toBeGreaterThanOrEqual(2);
    expect(
      logger.lines.map((line) => line.fields['status']).filter((status) => status !== undefined),
    ).toEqual(expect.arrayContaining(['PROCESSED', 'REJECTED']));

    expectSafeLogs(logger.lines);
  });

  test('a divergência de reconciliação é logada sem despejar o ledger', async () => {
    const wallet = await openWallet();
    const correlationId = `reconciliation-${uniqueSuffix()}`;
    logger.lines.length = 0;

    await sql`UPDATE wallet SET balance = 499.00 WHERE id = ${wallet.id}::uuid`;
    try {
      const report = (await controller.postReconciliation(
        wallet.id,
        fakeResponse(correlationId),
      )) as { consistent: boolean };
      expect(report.consistent).toBe(false);

      const diverged = logger.lines.filter(
        (line) => line.message === 'wallet reconciliation diverged',
      );
      expect(diverged).toHaveLength(1);
      expect(diverged[0]?.fields).toEqual({
        correlationId,
        walletId: wallet.id,
        checkedEntries: 1,
      });
      expectSafeLogs(diverged);
    } finally {
      await sql`UPDATE wallet SET balance = 500.00 WHERE id = ${wallet.id}::uuid`;
    }
  });
});
