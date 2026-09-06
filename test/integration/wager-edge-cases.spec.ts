import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { SQL } from 'bun';
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';

import { payloadHashOf } from '@/application/idempotency/payload-hash';
import type { SubmitWagerCommand } from '@/application/use-cases/submit-wager-transaction';
import { AppModule } from '@/bootstrap/app.module';
import { FailureCode } from '@/domain/failure-code';
import { Money } from '@/domain/money';
import { WagerTransactionKind, WagerTransactionStatus } from '@/domain/wager-transaction';
import { CONSUMER_NAME } from '@/interface/sqs/envelope';
import { connect, expectWalletsMatchLedger, MIGRATOR_URL, uniqueSuffix } from './support/database';
import { bootUseCases, type UseCases } from './support/use-cases';

const TEST_TIMEOUT_MS = 20_000;
setDefaultTimeout(TEST_TIMEOUT_MS);

let app: UseCases;
let http: INestApplication;
let baseUrl: string;
let sql: SQL;
let previousRoles: string | undefined;

const touched: string[] = [];

beforeAll(async () => {
  previousRoles = process.env['APP_ROLES'];
  process.env['APP_ROLES'] = 'api';
  app = await bootUseCases();
  sql = connect(MIGRATOR_URL);

  http = await NestFactory.create(AppModule, { logger: false });
  await http.listen(0, '127.0.0.1');
  const address = http.getHttpServer().address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('HTTP test server did not expose a TCP address');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  await http.close();
  await app.close();
  await sql.end();
  if (previousRoles === undefined) {
    delete process.env['APP_ROLES'];
  } else {
    process.env['APP_ROLES'] = previousRoles;
  }
}, TEST_TIMEOUT_MS);

afterEach(async () => {
  await expectWalletsMatchLedger(sql, touched.splice(0));
});

interface Owner {
  readonly id: string;
  readonly playerId: string;
}

async function openWallet(balance: string, currency = 'BRL'): Promise<Owner> {
  const playerId = `player-${uniqueSuffix()}`;
  const wallet = await app.createWallet.execute({
    playerId,
    initialBalance: { amount: balance, currency },
    correlationId: `correlation-${uniqueSuffix()}`,
  });
  touched.push(wallet.id);
  return { id: wallet.id, playerId };
}

function command(owner: Owner, overrides: Partial<SubmitWagerCommand> = {}): SubmitWagerCommand {
  const suffix = uniqueSuffix();
  return {
    providerId: 'provider-edge',
    externalTransactionId: `external-${suffix}`,
    idempotencyKey: `provider-edge:external-${suffix}`,
    playerId: owner.playerId,
    walletId: owner.id,
    roundId: `round-${suffix}`,
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: { amount: '25.00', currency: 'BRL' },
    correlationId: `correlation-${suffix}`,
    ...overrides,
  };
}

async function balanceOf(walletId: string): Promise<string> {
  const rows = (await sql`
    SELECT balance::text AS balance FROM wallet WHERE id = ${walletId}::uuid
  `) as { balance: string }[];
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`wallet ${walletId} não existe`);
  }
  return row.balance;
}

async function drainPendingReference(transactionId: string): Promise<string> {
  for (let tick = 0; tick < 20; tick += 1) {
    const rows = (await sql`
      SELECT status::text AS status FROM wager_transaction WHERE id = ${transactionId}::uuid
    `) as { status: string }[];
    const status = rows[0]?.status;
    if (status !== WagerTransactionStatus.PendingReference) {
      return status ?? 'AUSENTE';
    }
    if ((await app.resolvePendingReference.run()).kind === 'idle') {
      return WagerTransactionStatus.PendingReference;
    }
  }
  throw new Error(`${transactionId} continua pendente depois de 20 ticks do worker`);
}

async function httpWager(
  body: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<{ status: number; retryAfter: string | null; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    retryAfter: response.headers.get('retry-after'),
    body: (await response.json()) as Record<string, unknown>,
  };
}

function httpBody(owner: Owner, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const suffix = uniqueSuffix();
  return {
    providerId: 'provider-edge-http',
    externalTransactionId: `external-${suffix}`,
    playerId: owner.playerId,
    walletId: owner.id,
    roundId: `round-${suffix}`,
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '10.00', currency: 'BRL' },
    ...overrides,
  };
}

describe('reversão com referência ainda não aplicada', () => {
  test('ROLLBACK de um REFUND ainda em PENDING_REFERENCE espera a cadeia inteira, em vez de ser rejeitado', async () => {
    const wallet = await openWallet('100.00');
    const roundId = `round-${uniqueSuffix()}`;
    const betExternalId = `bet-${uniqueSuffix()}`;
    const refundExternalId = `refund-${uniqueSuffix()}`;

    const refund = await app.submitWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Refund,
        roundId,
        externalTransactionId: refundExternalId,
        idempotencyKey: `key-${refundExternalId}`,
        referenceExternalTransactionId: betExternalId,
        money: { amount: '10.00', currency: 'BRL' },
      }),
    );
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);

    const rollbackExternalId = `rollback-${uniqueSuffix()}`;
    const rollback = await app.submitWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Rollback,
        roundId,
        externalTransactionId: rollbackExternalId,
        idempotencyKey: `key-${rollbackExternalId}`,
        referenceExternalTransactionId: refundExternalId,
        money: { amount: '10.00', currency: 'BRL' },
      }),
    );

    expect(rollback.status).toBe(WagerTransactionStatus.PendingReference);

    await app.submitWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Bet,
        roundId,
        externalTransactionId: betExternalId,
        idempotencyKey: `key-${betExternalId}`,
        money: { amount: '10.00', currency: 'BRL' },
      }),
    );

    app.clock.advance(10_000);
    expect(await drainPendingReference(refund.transactionId)).toBe(
      WagerTransactionStatus.Processed,
    );
    app.clock.advance(10_000);
    expect(await drainPendingReference(rollback.transactionId)).toBe(
      WagerTransactionStatus.Processed,
    );

    expect(await balanceOf(wallet.id)).toBe('90.00');
  });

  test('segundo REFUND da BET é aplicado depois de o primeiro ser revertido, porque a vaga reabre', async () => {
    const wallet = await openWallet('100.00');
    const roundId = `round-${uniqueSuffix()}`;
    const betExternalId = `bet-${uniqueSuffix()}`;
    const firstRefundId = `refund-${uniqueSuffix()}`;

    await app.submitWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Bet,
        roundId,
        externalTransactionId: betExternalId,
        idempotencyKey: `key-${betExternalId}`,
        money: { amount: '10.00', currency: 'BRL' },
      }),
    );
    await app.submitWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Refund,
        roundId,
        externalTransactionId: firstRefundId,
        idempotencyKey: `key-${firstRefundId}`,
        referenceExternalTransactionId: betExternalId,
        money: { amount: '10.00', currency: 'BRL' },
      }),
    );

    const rollbackId = `rollback-${uniqueSuffix()}`;
    await app.submitWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Rollback,
        roundId,
        externalTransactionId: rollbackId,
        idempotencyKey: `key-${rollbackId}`,
        referenceExternalTransactionId: firstRefundId,
        money: { amount: '10.00', currency: 'BRL' },
      }),
    );
    expect(await balanceOf(wallet.id)).toBe('90.00');

    const secondRefundId = `refund-${uniqueSuffix()}`;
    const second = await app.submitWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Refund,
        roundId,
        externalTransactionId: secondRefundId,
        idempotencyKey: `key-${secondRefundId}`,
        referenceExternalTransactionId: betExternalId,
        money: { amount: '10.00', currency: 'BRL' },
      }),
    );

    expect(second.status).toBe(WagerTransactionStatus.Processed);
    expect(second.failureCode).toBeUndefined();
    expect(await balanceOf(wallet.id)).toBe('100.00');
  });
});

describe('dupla reversão da mesma referência por tipos diferentes', () => {
  test('a BET aceita a primeira reversão e recusa a segunda, seja qual for o tipo', async () => {
    const wallet = await openWallet('100.00');
    const roundId = `round-${uniqueSuffix()}`;
    const betExternalId = `bet-${uniqueSuffix()}`;

    await app.submitWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Bet,
        roundId,
        externalTransactionId: betExternalId,
        idempotencyKey: `key-${betExternalId}`,
        money: { amount: '10.00', currency: 'BRL' },
      }),
    );

    const applied = [];
    for (const kind of [WagerTransactionKind.Refund, WagerTransactionKind.Rollback]) {
      const externalId = `${kind}-${uniqueSuffix()}`;
      const reversal = await app.submitWager.execute(
        command(wallet, {
          kind,
          roundId,
          externalTransactionId: externalId,
          idempotencyKey: `key-${externalId}`,
          referenceExternalTransactionId: betExternalId,
          money: { amount: '10.00', currency: 'BRL' },
        }),
      );
      applied.push(reversal);
    }

    expect(applied[0]?.status).toBe(WagerTransactionStatus.Processed);
    expect(applied[1]?.status).toBe(WagerTransactionStatus.Rejected);
    expect(applied[1]?.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(await balanceOf(wallet.id)).toBe('100.00');

    const report = await app.reconcileWallet.execute(wallet.id);
    expect(report.consistent).toBe(true);
  });

  test('REFUND e ROLLBACK concorrentes da mesma BET são serializados, e só o primeiro credita', async () => {
    const wallet = await openWallet('100.00');
    const roundId = `round-${uniqueSuffix()}`;
    const betExternalId = `bet-${uniqueSuffix()}`;

    await app.submitWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Bet,
        roundId,
        externalTransactionId: betExternalId,
        idempotencyKey: `key-${betExternalId}`,
        money: { amount: '10.00', currency: 'BRL' },
      }),
    );

    const reverse = (kind: WagerTransactionKind): Promise<{ status: string }> => {
      const externalId = `${kind}-${uniqueSuffix()}`;
      return app.submitWager.execute(
        command(wallet, {
          kind,
          roundId,
          externalTransactionId: externalId,
          idempotencyKey: `key-${externalId}`,
          referenceExternalTransactionId: betExternalId,
          money: { amount: '10.00', currency: 'BRL' },
        }),
      );
    };

    const outcomes = await Promise.all([
      reverse(WagerTransactionKind.Refund),
      reverse(WagerTransactionKind.Rollback),
    ]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
    ]);
    expect(await balanceOf(wallet.id)).toBe('100.00');
  });
});

describe('classificação de falha na fronteira', () => {
  test('campo textual com byte nulo é payload inválido, não indisponibilidade', async () => {
    const wallet = await openWallet('100.00');
    const poisoned = httpBody(wallet, {
      roundId: `round-${String.fromCharCode(0)}-${uniqueSuffix()}`,
    });
    const key = `poison-${uniqueSuffix()}`;

    const first = await httpWager(poisoned, {
      'content-type': 'application/json',
      'idempotency-key': key,
    });
    const retry = await httpWager(poisoned, {
      'content-type': 'application/json',
      'idempotency-key': key,
    });

    for (const attempt of [first, retry]) {
      expect(attempt.status).toBe(400);
      expect(attempt.retryAfter).toBeNull();
      expect((attempt.body['error'] as { code: string }).code).toBe('INVALID_PAYLOAD');
    }
  });

  test('erro de domínio determinístico é permanente para o consumidor, não uma nova tentativa', async () => {
    const wallet = await openWallet('100.00');
    const unknownCurrency = command(wallet, { money: { amount: '1.00', currency: 'ZZZ' } });

    const outcome = await app.consumeWagerMessage.consume(
      {
        consumerName: CONSUMER_NAME,
        providerId: unknownCurrency.providerId,
        messageId: `message-${uniqueSuffix()}`,
        payloadHash: 'f'.repeat(64),
      },
      unknownCurrency,
    );

    expect(outcome.kind).toBe('permanent');
  });

  test('crédito acima do teto é rejeição de negócio no consumidor, e a inbox commita', async () => {
    const wallet = await openWallet('999999999999999999.99');
    const overflow = command(wallet, {
      kind: WagerTransactionKind.Win,
      money: { amount: '0.01', currency: 'BRL' },
    });

    const outcome = await app.consumeWagerMessage.consume(
      {
        consumerName: CONSUMER_NAME,
        providerId: overflow.providerId,
        messageId: `message-${uniqueSuffix()}`,
        payloadHash: payloadHashOf({ ...overflow, money: Money.from(overflow.money) }),
      },
      overflow,
    );

    expect(outcome).toMatchObject({
      kind: 'processed',
      result: {
        status: WagerTransactionStatus.Rejected,
        failureCode: FailureCode.BalanceLimitExceeded,
      },
    });
  });
});

describe('carimbo de tempo do movimento', () => {
  test('relógio local atrás do createdAt da wallet aplica a aposta, porque as instâncias não sincronizam relógio', async () => {
    const wallet = await openWallet('100.00');

    app.clock.advance(-60_000);
    const applied = await app.submitWager.execute(
      command(wallet, { money: { amount: '10.00', currency: 'BRL' } }),
    );
    app.clock.advance(60_000);

    expect(applied.status).toBe(WagerTransactionStatus.Processed);
    expect(await balanceOf(wallet.id)).toBe('90.00');
  });
});

describe('teto da faixa monetária', () => {
  test('crédito acima do teto de numeric(20,2) é rejeição auditável com BALANCE_LIMIT_EXCEEDED', async () => {
    const wallet = await openWallet('999999999999999999.99');

    const overflow = await httpWager(
      httpBody(wallet, { kind: 'WIN', money: { amount: '0.01', currency: 'BRL' } }),
      { 'content-type': 'application/json', 'idempotency-key': `overflow-${uniqueSuffix()}` },
    );

    expect(overflow.status).toBe(422);
    expect(overflow.body['status']).toBe(WagerTransactionStatus.Rejected);
    expect(overflow.body['failureCode']).toBe(FailureCode.BalanceLimitExceeded);

    const rows = (await sql`
      SELECT status::text AS status, failure_code::text AS failure_code
      FROM wager_transaction WHERE wallet_id = ${wallet.id}::uuid AND kind = 'WIN'
    `) as { status: string; failure_code: string }[];
    expect(rows).toEqual([{ status: 'REJECTED', failure_code: 'BALANCE_LIMIT_EXCEEDED' }]);
  });
});

describe('identidade textual da submissão', () => {
  test('externalTransactionId em NFC e em NFD são identidades distintas, não replay', async () => {
    const wallet = await openWallet('100.00');
    const composed = `café-${uniqueSuffix()}`;
    const decomposed = composed.normalize('NFD');

    expect(composed).not.toBe(decomposed);
    expect(composed.normalize('NFC')).toBe(decomposed.normalize('NFC'));

    const first = await app.submitWager.execute(
      command(wallet, {
        externalTransactionId: composed,
        idempotencyKey: composed,
        money: { amount: '10.00', currency: 'BRL' },
      }),
    );
    const second = await app.submitWager.execute(
      command(wallet, {
        externalTransactionId: decomposed,
        idempotencyKey: decomposed,
        money: { amount: '10.00', currency: 'BRL' },
      }),
    );

    expect(second.transactionId).not.toBe(first.transactionId);
    expect(second.idempotentReplay).toBe(false);
    expect(await balanceOf(wallet.id)).toBe('80.00');
  });

  test('Idempotency-Key repetido no header é payload inválido, e não uma chave concatenada', async () => {
    const wallet = await openWallet('100.00');
    const key = `duplicated-${uniqueSuffix()}`;
    const body = httpBody(wallet);

    const duplicated = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: [
        ['content-type', 'application/json'],
        ['idempotency-key', key],
        ['idempotency-key', key],
      ],
      body: JSON.stringify(body),
    });
    expect(duplicated.status).toBe(400);

    const stored = (await sql`
      SELECT count(*)::int AS rows FROM wager_transaction
      WHERE provider_id = ${body['providerId'] as string}
        AND external_transaction_id = ${body['externalTransactionId'] as string}
    `) as { rows: number }[];
    expect(stored[0]?.rows).toBe(0);

    const singleHeader = await httpWager(body, {
      'content-type': 'application/json',
      'idempotency-key': key,
    });
    expect(singleHeader.status).toBe(201);
    expect(singleHeader.body['idempotentReplay']).toBe(false);
  });
});

describe('saldo histórico nas rejeições', () => {
  test('nenhuma rejeição sobre wallet alheia devolve saldo, seja ela inexistente ou de outro player', async () => {
    const victim = await openWallet('4321.99');
    const stranger = await openWallet('0.00');

    const probe = await httpWager(
      { ...httpBody(stranger), walletId: victim.id, money: { amount: '1.00', currency: 'BRL' } },
      { 'content-type': 'application/json', 'idempotency-key': `probe-${uniqueSuffix()}` },
    );

    expect(probe.status).toBe(422);
    expect(probe.body['failureCode']).toBe(FailureCode.WalletPlayerMismatch);
    expect(probe.body['balance']).toBeUndefined();

    const unknownWallet = await httpWager(
      { ...httpBody(stranger), walletId: crypto.randomUUID() },
      { 'content-type': 'application/json', 'idempotency-key': `probe-${uniqueSuffix()}` },
    );

    expect(unknownWallet.body['failureCode']).toBe(FailureCode.WalletNotFound);
    expect(unknownWallet.body['balance']).toBeUndefined();
  });
});

describe('consultas de transação', () => {
  test('a consulta por transactionId é escopada pelo provider que se identifica', async () => {
    const wallet = await openWallet('100.00');
    const body = httpBody(wallet, { providerId: 'provider-confidencial' });
    const created = await httpWager(body, {
      'content-type': 'application/json',
      'idempotency-key': `scope-${uniqueSuffix()}`,
    });
    expect(created.status).toBe(201);

    const url = `${baseUrl}/wagering/transactions/${created.body['transactionId']}`;

    const anonymous = await fetch(url);
    expect(anonymous.status).toBe(400);

    const stranger = await fetch(url, { headers: { 'x-provider-id': 'provider-curioso' } });
    expect(stranger.status).toBe(404);

    const owner = await fetch(url, { headers: { 'x-provider-id': 'provider-confidencial' } });
    const view = (await owner.json()) as Record<string, unknown>;
    expect(owner.status).toBe(200);
    expect(view['walletId']).toBe(wallet.id);
  });
});

describe('bordas do contrato', () => {
  test('uma reversão que aponta para o próprio externalTransactionId é rejeitada, não vira auto-referência no banco', async () => {
    const wallet = await openWallet('100.00');
    const selfRefund = `self-refund-${uniqueSuffix()}`;
    const refund = await app.submitWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Refund,
        externalTransactionId: selfRefund,
        idempotencyKey: `key-${selfRefund}`,
        referenceExternalTransactionId: selfRefund,
        money: { amount: '1.00', currency: 'BRL' },
      }),
    );
    expect(refund.failureCode).toBe(FailureCode.ReferenceKindNotReversible);

    const selfWin = `self-win-${uniqueSuffix()}`;
    const win = await app.submitWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Win,
        externalTransactionId: selfWin,
        idempotencyKey: `key-${selfWin}`,
        referenceExternalTransactionId: selfWin,
        money: { amount: '1.00', currency: 'BRL' },
      }),
    );
    expect(win.failureCode).toBe(FailureCode.ReferenceMismatch);
    expect(await balanceOf(wallet.id)).toBe('100.00');
  });

  test('a paginação do ledger não pula nem repete quando todos os lançamentos têm o mesmo created_at', async () => {
    const wallet = await openWallet('100.00');
    for (let index = 0; index < 5; index += 1) {
      await app.submitWager.execute(
        command(wallet, {
          kind: WagerTransactionKind.Win,
          money: { amount: '1.00', currency: 'BRL' },
        }),
      );
    }

    const instants = (await sql`
      SELECT count(DISTINCT created_at)::int AS instants, count(*)::int AS entries
      FROM wallet_ledger_entry WHERE wallet_id = ${wallet.id}::uuid
    `) as { instants: number; entries: number }[];
    expect(instants[0]?.instants).toBe(1);

    const seen: string[] = [];
    let cursor: { createdAt: Date; id: string } | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await app.unitOfWork.readOnly(async (repositories) => {
        const found = await repositories.wallets.findById(wallet.id);
        if (found === undefined) {
          throw new Error('wallet sumiu no meio da paginação');
        }
        return repositories.ledger.page(found, 2, cursor);
      });
      seen.push(...result.entries.map((entry) => entry.id));
      const last = result.entries.at(-1);
      if (!result.hasMore || last === undefined) {
        break;
      }
      cursor = { createdAt: last.createdAt, id: last.id };
    }

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(instants[0]?.entries ?? 0);
  });

  test('-0.00 é aceito no contrato e nunca chega ao banco nem à resposta com sinal', async () => {
    const negativeZero = Money.from({ amount: '-0.00', currency: 'BRL' });
    expect(negativeZero.toString()).toBe('0.00');
    expect(negativeZero.isNegative()).toBe(false);

    const wallet = await app.createWallet.execute({
      playerId: `player-${uniqueSuffix()}`,
      initialBalance: { amount: '-0.00', currency: 'BRL' },
      correlationId: `correlation-${uniqueSuffix()}`,
    });
    touched.push(wallet.id);

    expect(wallet.balance.amount).toBe('0.00');
    expect(await balanceOf(wallet.id)).toBe('0.00');
  });
});
