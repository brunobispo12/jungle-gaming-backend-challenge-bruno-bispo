import type { SQL } from 'bun';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';

import type { SubmitWagerCommand } from '@/application/use-cases/submit-wager-transaction';
import { Money } from '@/domain/money';
import { WagerTransactionKind } from '@/domain/wager-transaction';
import { LedgerDirection, WalletLedgerEntry } from '@/domain/wallet-ledger-entry';
import {
  MIGRATOR_URL,
  connect,
  expectWalletsMatchLedger,
  uniqueSuffix,
  uuid,
} from './support/database';
import { bootUseCases, type UseCases } from './support/use-cases';

const AT = new Date('2026-07-29T15:00:00.000Z');
const CONSUMER = 'atomicity-consumer';

// What opening a wallet with a positive balance leaves behind: the OPENING wager,
// its ledger entry, and the two events that describe it.
const AFTER_OPENING = { balance: '1000.00', wagers: 1, entries: 1, outbox: 2, inbox: 0 };

let app: UseCases;
let sql: SQL;

beforeAll(async () => {
  app = await bootUseCases(AT);
  sql = connect(MIGRATOR_URL);
});

afterAll(async () => {
  await app.close();
  await sql.end();
});

const touched: string[] = [];

afterEach(async () => {
  await expectWalletsMatchLedger(sql, touched.splice(0));
});

async function openWallet(): Promise<{ id: string; playerId: string }> {
  const playerId = `player-${uniqueSuffix()}`;
  const wallet = await app.createWallet.execute({
    playerId,
    initialBalance: { amount: '1000.00', currency: 'BRL' },
    correlationId: `correlation-${uniqueSuffix()}`,
  });
  touched.push(wallet.id);
  return { id: wallet.id, playerId };
}

function command(wallet: { id: string; playerId: string }): SubmitWagerCommand {
  const suffix = uniqueSuffix();
  return {
    providerId: 'provider-a',
    externalTransactionId: `external-${suffix}`,
    idempotencyKey: `provider-a:external-${suffix}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: `round-${suffix}`,
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: { amount: '25.00', currency: 'BRL' },
    correlationId: `correlation-${suffix}`,
  };
}

async function expectRollback(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error: unknown) {
    return (error as { name?: string }).name ?? 'Error';
  }
  throw new Error('a transação deveria ter falhado, mas commitou');
}

interface Residue {
  readonly balance: string;
  readonly wagers: number;
  readonly entries: number;
  readonly outbox: number;
  readonly inbox: number;
}

async function residueOf(walletId: string, messageId: string): Promise<Residue> {
  const rows = (await sql`
    SELECT
      (SELECT balance::text FROM wallet WHERE id = ${walletId}::uuid)            AS balance,
      (SELECT count(*)::int FROM wager_transaction
         WHERE wallet_id = ${walletId}::uuid)                                    AS wagers,
      (SELECT count(*)::int FROM wallet_ledger_entry
         WHERE wallet_id = ${walletId}::uuid)                                    AS entries,
      (SELECT count(*)::int FROM outbox_message
         WHERE payload->'data'->>'walletId' = ${walletId})                       AS outbox,
      (SELECT count(*)::int FROM inbox_message
         WHERE consumer_name = ${CONSUMER} AND message_id = ${messageId})        AS inbox
  `) as Residue[];

  const row = rows[0];
  if (row === undefined) {
    throw new Error(`wallet ${walletId} não existe`);
  }
  return row;
}

describe('TST-023 atomicidade entre wallet, wager, ledger, inbox e outbox', () => {
  test('uma violação real de constraint depois das escritas desfaz o conjunto inteiro', async () => {
    const wallet = await openWallet();
    const messageId = `msg-${uniqueSuffix()}`;

    const failure = await expectRollback(
      app.unitOfWork.transactional(async (repositories) => {
        const result = await app.submitWager.executeWithin(repositories, command(wallet));

        // A second entry for the same transaction and wallet collides with
        // ledger_transaction_wallet_uq: PostgreSQL refuses it, not the test.
        await repositories.ledger.insert(
          WalletLedgerEntry.create({
            id: uuid(),
            walletId: wallet.id,
            transactionId: result.transactionId,
            direction: LedgerDirection.Debit,
            money: Money.from({ amount: '1.00', currency: 'BRL' }),
            balanceBefore: Money.from({ amount: '975.00', currency: 'BRL' }),
            balanceAfter: Money.from({ amount: '974.00', currency: 'BRL' }),
            createdAt: AT,
          }),
        );
      }),
    );

    expect(failure).toBe('UniqueConstraintViolationException');
    expect(await residueOf(wallet.id, messageId)).toEqual(AFTER_OPENING);
  });

  test('uma falha depois das escritas não deixa wager, ledger nem outbox', async () => {
    const wallet = await openWallet();
    const messageId = `msg-${uniqueSuffix()}`;

    const failure = await expectRollback(
      app.unitOfWork.transactional(async (repositories) => {
        await app.submitWager.executeWithin(repositories, command(wallet));
        throw new Error('falha depois de gravar wallet, ledger e outbox');
      }),
    );

    expect(failure).toBe('Error');
    expect(await residueOf(wallet.id, messageId)).toEqual(AFTER_OPENING);
  });

  test('no fluxo SQS a inbox some junto com o efeito financeiro', async () => {
    const wallet = await openWallet();
    const messageId = `msg-${uniqueSuffix()}`;

    await expectRollback(
      app.unitOfWork.transactional(async (repositories) => {
        const reserved = await repositories.inbox.reserve({
          consumerName: CONSUMER,
          messageId,
          payloadHash: 'a'.repeat(64),
          receivedAt: AT,
        });
        expect(reserved).toBeDefined();

        await app.submitWager.executeWithin(repositories, command(wallet));
        await repositories.inbox.markProcessed(CONSUMER, messageId, AT);

        throw new Error('falha depois de reservar a inbox e aplicar o efeito');
      }),
    );

    expect(await residueOf(wallet.id, messageId)).toEqual(AFTER_OPENING);
  });

  test('sem falha, o mesmo conjunto commita inteiro', async () => {
    const wallet = await openWallet();
    const messageId = `msg-${uniqueSuffix()}`;

    await app.unitOfWork.transactional(async (repositories) => {
      await repositories.inbox.reserve({
        consumerName: CONSUMER,
        messageId,
        payloadHash: 'b'.repeat(64),
        receivedAt: AT,
      });
      await app.submitWager.executeWithin(repositories, command(wallet));
      await repositories.inbox.markProcessed(CONSUMER, messageId, AT);
    });

    expect(await residueOf(wallet.id, messageId)).toEqual({
      balance: '975.00',
      wagers: 2,
      entries: 2,
      outbox: 4,
      inbox: 1,
    });
  });
});
