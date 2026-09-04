import type { SQL } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  APP_URL,
  MIGRATOR_URL,
  connect,
  expectSqlFailure,
  seedLedgerEntry,
  seedWager,
  seedWallet,
  uniqueSuffix,
  uuid,
} from './support/database';

let migrator: SQL;
let app: SQL;

beforeAll(() => {
  migrator = connect(MIGRATOR_URL);
  app = connect(APP_URL);
});

afterAll(async () => {
  await migrator.end();
  await app.end();
});

describe('TST-022 unicidade', () => {
  test('duas wallets para o mesmo playerId e moeda colidem no banco', async () => {
    const wallet = await seedWallet(migrator);

    const failure = await expectSqlFailure(
      () => migrator`
        INSERT INTO wallet (id, player_id, currency, balance, version, created_at, updated_at)
        VALUES (${uuid()}::uuid, ${wallet.playerId}, ${wallet.currency}, '0.00'::numeric, 1, now(), now())
      `,
    );

    expect(failure.sqlstate).toBe('23505');
    expect(failure.message).toContain('wallet_player_currency_uq');
  });

  test('o mesmo playerId em outra moeda é wallet legítima', async () => {
    const wallet = await seedWallet(migrator, { currency: 'BRL' });

    await migrator`
      INSERT INTO wallet (id, player_id, currency, balance, version, created_at, updated_at)
      VALUES (${uuid()}::uuid, ${wallet.playerId}, 'USD', '0.00'::numeric, 1, now(), now())
    `;

    const rows = (await migrator`
      SELECT currency FROM wallet WHERE player_id = ${wallet.playerId} ORDER BY currency
    `) as { currency: string }[];
    expect(rows.map((row) => row.currency)).toEqual(['BRL', 'USD']);
  });

  test('a mesma mensagem para o mesmo consumidor colide na inbox', async () => {
    const messageId = `msg-${uniqueSuffix()}`;
    const insert = (): Promise<unknown> => migrator`
      INSERT INTO inbox_message (consumer_name, message_id, payload_hash, received_at)
      VALUES ('wager-transactions-consumer', ${messageId}, ${'b'.repeat(64)}, now())
    `;

    await insert();
    const failure = await expectSqlFailure(insert);

    expect(failure.sqlstate).toBe('23505');
    expect(failure.message).toContain('inbox_message_pk');
  });

  test('um segundo lançamento para a mesma transação e wallet colide', async () => {
    const wallet = await seedWallet(migrator);
    const transactionId = await seedWager(migrator, {
      walletId: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      kind: 'BET',
      status: 'PROCESSED',
      amount: '25.00',
    });

    const entry = {
      walletId: wallet.id,
      transactionId,
      currency: wallet.currency,
      direction: 'DEBIT' as const,
      amount: '25.00',
      balanceBefore: '1000.00',
      balanceAfter: '975.00',
    };

    await seedLedgerEntry(migrator, entry);
    const failure = await expectSqlFailure(() => seedLedgerEntry(migrator, entry));

    expect(failure.sqlstate).toBe('23505');
    expect(failure.message).toContain('ledger_transaction_wallet_uq');
  });

  test('a mesma referência não recebe dois REFUND aplicados', async () => {
    const wallet = await seedWallet(migrator);
    const bet = await seedWager(migrator, {
      walletId: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      kind: 'BET',
      status: 'PROCESSED',
    });

    const refund = (): Promise<string> =>
      seedWager(migrator, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        kind: 'REFUND',
        status: 'PROCESSED',
        referenceExternalTransactionId: `external-ref-${uniqueSuffix()}`,
        referenceTransactionId: bet,
      });

    await refund();
    const failure = await expectSqlFailure(refund);

    expect(failure.sqlstate).toBe('23505');
    expect(failure.message).toContain('wager_reversal_once_per_kind_uq');
  });

  test('opção B: a mesma referência aceita um REFUND e um ROLLBACK', async () => {
    const wallet = await seedWallet(migrator);
    const bet = await seedWager(migrator, {
      walletId: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      kind: 'BET',
      status: 'PROCESSED',
    });

    for (const kind of ['REFUND', 'ROLLBACK'] as const) {
      await seedWager(migrator, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        kind,
        status: 'PROCESSED',
        referenceExternalTransactionId: `external-ref-${uniqueSuffix()}`,
        referenceTransactionId: bet,
      });
    }

    const rows = (await migrator`
      SELECT kind FROM wager_transaction
      WHERE reference_transaction_id = ${bet}::uuid AND status = 'PROCESSED'
      ORDER BY kind
    `) as { kind: string }[];
    expect(rows.map((row) => row.kind).sort()).toEqual(['REFUND', 'ROLLBACK']);
  });
});

describe('TST-022 não-negatividade e aritmética', () => {
  test('saldo negativo é recusado pelo banco', async () => {
    const wallet = await seedWallet(migrator, { balance: '10.00' });

    const failure = await expectSqlFailure(
      () => migrator`UPDATE wallet SET balance = '-1.00'::numeric WHERE id = ${wallet.id}::uuid`,
    );

    expect(failure.sqlstate).toBe('23514');
    expect(failure.message).toContain('wallet_balance_non_negative_ck');
  });

  test('lançamento com aritmética inconsistente é recusado', async () => {
    const wallet = await seedWallet(migrator);
    const transactionId = await seedWager(migrator, {
      walletId: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      kind: 'BET',
      status: 'PROCESSED',
    });

    const failure = await expectSqlFailure(() =>
      seedLedgerEntry(migrator, {
        walletId: wallet.id,
        transactionId,
        currency: wallet.currency,
        direction: 'DEBIT',
        amount: '25.00',
        balanceBefore: '1000.00',
        balanceAfter: '980.00',
      }),
    );

    expect(failure.sqlstate).toBe('23514');
    expect(failure.message).toContain('ledger_arithmetic_ck');
  });

  test('lançamento de valor zero é recusado', async () => {
    const wallet = await seedWallet(migrator);
    const transactionId = await seedWager(migrator, {
      walletId: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      kind: 'BET',
      status: 'PROCESSED',
    });

    const failure = await expectSqlFailure(() =>
      seedLedgerEntry(migrator, {
        walletId: wallet.id,
        transactionId,
        currency: wallet.currency,
        direction: 'CREDIT',
        amount: '0.00',
        balanceBefore: '1000.00',
        balanceAfter: '1000.00',
      }),
    );

    expect(failure.sqlstate).toBe('23514');
    expect(failure.message).toContain('ledger_amount_positive_ck');
  });
});

describe('TST-022 imutabilidade', () => {
  test('UPDATE em lançamento do ledger é bloqueado pelo trigger, mesmo com a credencial de migration', async () => {
    const wallet = await seedWallet(migrator);
    const transactionId = await seedWager(migrator, {
      walletId: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      kind: 'BET',
      status: 'PROCESSED',
    });
    const entryId = await seedLedgerEntry(migrator, {
      walletId: wallet.id,
      transactionId,
      currency: wallet.currency,
      direction: 'DEBIT',
      amount: '25.00',
      balanceBefore: '1000.00',
      balanceAfter: '975.00',
    });

    const failure = await expectSqlFailure(
      () => migrator`UPDATE wallet_ledger_entry SET amount = '1.00'::numeric WHERE id = ${entryId}::uuid`,
    );

    expect(failure.sqlstate).toBe('0A000');
    expect(failure.message).toContain('immutable');
  });

  test('DELETE em lançamento do ledger é bloqueado pelo trigger', async () => {
    const wallet = await seedWallet(migrator);
    const transactionId = await seedWager(migrator, {
      walletId: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      kind: 'BET',
      status: 'PROCESSED',
    });
    const entryId = await seedLedgerEntry(migrator, {
      walletId: wallet.id,
      transactionId,
      currency: wallet.currency,
      direction: 'DEBIT',
      amount: '25.00',
      balanceBefore: '1000.00',
      balanceAfter: '975.00',
    });

    const failure = await expectSqlFailure(
      () => migrator`DELETE FROM wallet_ledger_entry WHERE id = ${entryId}::uuid`,
    );

    expect(failure.sqlstate).toBe('0A000');
  });

  test('TRUNCATE do ledger é bloqueado pelo trigger de statement', async () => {
    const failure = await expectSqlFailure(() =>
      migrator.unsafe('TRUNCATE TABLE wallet_ledger_entry'),
    );

    expect(failure.sqlstate).toBe('0A000');
  });

  test('a role de runtime nem chega ao trigger do ledger: falta privilégio', async () => {
    const failure = await expectSqlFailure(() =>
      app.unsafe(`UPDATE wallet_ledger_entry SET amount = '1.00'`),
    );

    expect(failure.sqlstate).toBe('42501');
  });

  test('a role de runtime não pode apagar lançamento', async () => {
    const failure = await expectSqlFailure(() =>
      app.unsafe('DELETE FROM wallet_ledger_entry'),
    );

    expect(failure.sqlstate).toBe('42501');
  });

  test('transação em estado terminal não volta a mudar', async () => {
    const wallet = await seedWallet(migrator);
    const transactionId = await seedWager(migrator, {
      walletId: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      kind: 'BET',
      status: 'PROCESSED',
    });

    const failure = await expectSqlFailure(
      () => migrator`
        UPDATE wager_transaction SET status = 'REJECTED'::wager_transaction_status
        WHERE id = ${transactionId}::uuid
      `,
    );

    expect(failure.sqlstate).toBe('0A000');
    expect(failure.message).toContain('terminal');
  });

  test('a identidade da inbox não pode ser reescrita', async () => {
    const messageId = `msg-${uniqueSuffix()}`;
    await migrator`
      INSERT INTO inbox_message (consumer_name, message_id, payload_hash, received_at)
      VALUES ('wager-transactions-consumer', ${messageId}, ${'c'.repeat(64)}, now())
    `;

    const failure = await expectSqlFailure(
      () => migrator`
        UPDATE inbox_message SET payload_hash = ${'d'.repeat(64)}
        WHERE consumer_name = 'wager-transactions-consumer' AND message_id = ${messageId}
      `,
    );

    expect(failure.sqlstate).toBe('0A000');
  });
});

describe('TST-022 moeda do saldo histórico', () => {
  test('CURRENCY_MISMATCH persiste operação em USD com saldo histórico em BRL', async () => {
    const wallet = await seedWallet(migrator, { currency: 'BRL', balance: '500.00' });

    const id = await seedWager(migrator, {
      walletId: wallet.id,
      playerId: wallet.playerId,
      currency: 'USD',
      kind: 'BET',
      status: 'REJECTED',
      failureCode: 'CURRENCY_MISMATCH',
      resultBalanceAmount: '500.00',
      resultBalanceCurrency: 'BRL',
    });

    const rows = (await migrator`
      SELECT currency, result_balance_currency, result_balance_amount::text AS result_balance_amount
      FROM wager_transaction WHERE id = ${id}::uuid
    `) as { currency: string; result_balance_currency: string; result_balance_amount: string }[];

    expect(rows[0]).toEqual({
      currency: 'USD',
      result_balance_currency: 'BRL',
      result_balance_amount: '500.00',
    });
  });

  test('sem CURRENCY_MISMATCH a moeda do snapshot precisa ser a da operação', async () => {
    const wallet = await seedWallet(migrator, { currency: 'BRL' });

    const failure = await expectSqlFailure(() =>
      seedWager(migrator, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        currency: 'BRL',
        kind: 'BET',
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
        resultBalanceAmount: '10.00',
        resultBalanceCurrency: 'USD',
      }),
    );

    expect(failure.sqlstate).toBe('23514');
    expect(failure.message).toContain('wager_result_balance_currency_ck');
  });

  test('o snapshot não pode inventar uma moeda que a wallet não tem', async () => {
    const wallet = await seedWallet(migrator, { currency: 'BRL' });

    const failure = await expectSqlFailure(() =>
      seedWager(migrator, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        currency: 'USD',
        kind: 'BET',
        status: 'REJECTED',
        failureCode: 'CURRENCY_MISMATCH',
        resultBalanceAmount: '500.00',
        resultBalanceCurrency: 'EUR',
      }),
    );

    expect(failure.sqlstate).toBe('23503');
    expect(failure.message).toContain('wager_result_balance_wallet_fk');
  });

  test('WALLET_NOT_FOUND permanece auditável sem snapshot e sem wallet existente', async () => {
    const id = await seedWager(migrator, {
      walletId: uuid(),
      playerId: `player-${uniqueSuffix()}`,
      currency: 'BRL',
      kind: 'BET',
      status: 'REJECTED',
      failureCode: 'WALLET_NOT_FOUND',
      resultBalanceAmount: null,
      resultBalanceCurrency: null,
    });

    const rows = (await migrator`
      SELECT failure_code, result_balance_amount FROM wager_transaction WHERE id = ${id}::uuid
    `) as { failure_code: string; result_balance_amount: string | null }[];

    expect(rows[0]?.failure_code).toBe('WALLET_NOT_FOUND');
    expect(rows[0]?.result_balance_amount).toBeNull();
  });
});

describe('TST-022 coerência de estado', () => {
  test('resultado terminal exige processedAt', async () => {
    const wallet = await seedWallet(migrator);

    const failure = await expectSqlFailure(
      () => migrator`
        INSERT INTO wager_transaction (
          id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, amount, currency,
          status, result_balance_amount, result_balance_currency,
          attempts, correlation_id, created_at, processed_at
        ) VALUES (
          ${uuid()}::uuid, 'provider-a', ${`external-${uniqueSuffix()}`}, ${`key-${uniqueSuffix()}`},
          ${'e'.repeat(64)}, ${wallet.id}::uuid, ${wallet.playerId}, 'round-1', 'fortune-chimp',
          'BET'::wager_transaction_kind, '25.00'::numeric, ${wallet.currency},
          'PROCESSED'::wager_transaction_status, '975.00'::numeric, ${wallet.currency},
          0, 'correlation-1', now(), NULL
        )
      `,
    );

    expect(failure.sqlstate).toBe('23514');
    expect(failure.message).toContain('wager_processed_at_states_ck');
  });

  test('INFRASTRUCTURE_FAILURE só acompanha FAILED', async () => {
    const wallet = await seedWallet(migrator);

    const failure = await expectSqlFailure(() =>
      seedWager(migrator, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        kind: 'BET',
        status: 'REJECTED',
        failureCode: 'INFRASTRUCTURE_FAILURE',
      }),
    );

    expect(failure.sqlstate).toBe('23514');
    expect(failure.message).toContain('wager_infrastructure_failure_ck');
  });

  test('PROCESSED não carrega failureCode', async () => {
    const wallet = await seedWallet(migrator);

    const failure = await expectSqlFailure(() =>
      seedWager(migrator, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        kind: 'BET',
        status: 'PROCESSED',
        failureCode: 'INSUFFICIENT_FUNDS',
      }),
    );

    expect(failure.sqlstate).toBe('23514');
    expect(failure.message).toContain('wager_failure_code_states_ck');
  });

  test('REFUND aplicado exige a referência interna resolvida', async () => {
    const wallet = await seedWallet(migrator);

    const failure = await expectSqlFailure(() =>
      seedWager(migrator, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        kind: 'REFUND',
        status: 'PROCESSED',
        referenceExternalTransactionId: 'external-orfa',
        referenceTransactionId: null,
      }),
    );

    expect(failure.sqlstate).toBe('23514');
    expect(failure.message).toContain('wager_reference_resolved_ck');
  });

  test('BET não carrega referência externa', async () => {
    const wallet = await seedWallet(migrator);

    const failure = await expectSqlFailure(() =>
      seedWager(migrator, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        kind: 'BET',
        status: 'PROCESSED',
        referenceExternalTransactionId: 'external-indevida',
      }),
    );

    expect(failure.sqlstate).toBe('23514');
    expect(failure.message).toContain('wager_reference_external_by_kind_ck');
  });

  test('PENDING_REFERENCE só existe para reversão ainda não resolvida', async () => {
    const wallet = await seedWallet(migrator);

    const failure = await expectSqlFailure(() =>
      seedWager(migrator, {
        walletId: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        kind: 'BET',
        status: 'PENDING_REFERENCE',
      }),
    );

    expect(failure.sqlstate).toBe('23514');
    expect(failure.message).toContain('wager_pending_reference_ck');
  });

  test('o mesmo provider não reusa idempotency key nem externalTransactionId', async () => {
    const wallet = await seedWallet(migrator);
    const suffix = uniqueSuffix();

    const insert = (externalId: string, key: string): Promise<unknown> => migrator`
      INSERT INTO wager_transaction (
        id, provider_id, external_transaction_id, idempotency_key, payload_hash,
        wallet_id, player_id, round_id, game_id, kind, amount, currency,
        status, result_balance_amount, result_balance_currency,
        attempts, correlation_id, created_at, processed_at
      ) VALUES (
        ${uuid()}::uuid, 'provider-a', ${externalId}, ${key},
        ${'f'.repeat(64)}, ${wallet.id}::uuid, ${wallet.playerId}, 'round-1', 'fortune-chimp',
        'BET'::wager_transaction_kind, '25.00'::numeric, ${wallet.currency},
        'PROCESSED'::wager_transaction_status, '975.00'::numeric, ${wallet.currency},
        0, 'correlation-1', now(), now()
      )
    `;

    await insert(`external-${suffix}`, `key-${suffix}`);

    const keyConflict = await expectSqlFailure(() =>
      insert(`external-outro-${suffix}`, `key-${suffix}`),
    );
    expect(keyConflict.sqlstate).toBe('23505');
    expect(keyConflict.message).toContain('wager_provider_idempotency_uq');

    const externalConflict = await expectSqlFailure(() =>
      insert(`external-${suffix}`, `key-outro-${suffix}`),
    );
    expect(externalConflict.sqlstate).toBe('23505');
    expect(externalConflict.message).toContain('wager_provider_external_uq');
  });
});
