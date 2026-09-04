import type { SQL } from 'bun';
import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { migrationOrmConfig } from '@/infrastructure/persistence/orm.config';
import { connect, MIGRATOR_URL } from './support/database';

const TABLES = [
  'wallet',
  'wager_transaction',
  'wallet_ledger_entry',
  'inbox_message',
  'outbox_message',
] as const;

const ENUM_TYPES = [
  'wager_transaction_kind',
  'wager_transaction_status',
  'ledger_direction',
  'wager_failure_code',
] as const;

const CONSTRAINTS = [
  'wallet_player_currency_uq',
  'wallet_id_currency_uq',
  'wallet_balance_non_negative_ck',
  'wallet_version_min_ck',
  'wager_provider_idempotency_uq',
  'wager_provider_external_uq',
  'wager_reference_fk',
  'wager_result_balance_wallet_fk',
  'wager_amount_positive_ck',
  'wager_failure_code_states_ck',
  'wager_infrastructure_failure_ck',
  'wager_processed_at_states_ck',
  'wager_result_balance_pair_ck',
  'wager_result_balance_presence_ck',
  'wager_result_balance_currency_ck',
  'wager_reference_external_by_kind_ck',
  'wager_reference_resolved_ck',
  'wager_pending_reference_ck',
  'ledger_transaction_wallet_uq',
  'ledger_wallet_fk',
  'ledger_transaction_fk',
  'ledger_amount_positive_ck',
  'ledger_arithmetic_ck',
  'ledger_balance_before_non_negative_ck',
  'ledger_balance_after_non_negative_ck',
  'inbox_message_pk',
  'inbox_processed_after_received_ck',
  'outbox_event_id_uq',
  'outbox_claim_pair_ck',
  'outbox_attempts_non_negative_ck',
] as const;

const INDEXES = [
  'wager_reversal_once_per_kind_uq',
  'wager_pending_due_ix',
  'ledger_wallet_keyset_ix',
  'outbox_pending_ix',
] as const;

const TRIGGERS = [
  'wallet_ledger_entry_immutable_tg',
  'wallet_ledger_entry_no_truncate_tg',
  'wager_transaction_guard_tg',
  'inbox_message_guard_tg',
] as const;

let orm: MikroORM;
let sql: SQL;

beforeAll(async () => {
  orm = await MikroORM.init(migrationOrmConfig(MIGRATOR_URL));
  sql = connect(MIGRATOR_URL);
});

afterAll(async () => {
  await orm.getMigrator().up();
  await orm.close(true);
  await sql.end();
});

async function tableNames(): Promise<string[]> {
  const rows = (await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
  `) as { table_name: string }[];
  return rows.map((row) => row.table_name);
}

async function enumTypeNames(): Promise<string[]> {
  const rows = (await sql`
    SELECT typname FROM pg_type
    WHERE typnamespace = 'public'::regnamespace AND typtype = 'e'
  `) as { typname: string }[];
  return rows.map((row) => row.typname);
}

describe('TST-021 migrations aplicam e revertem', () => {
  test('down remove tabelas, tipos, funções e triggers', async () => {
    await orm.getMigrator().up();
    await orm.getMigrator().down({ to: 0 });

    const tables = await tableNames();
    for (const table of TABLES) {
      expect(tables).not.toContain(table);
    }

    const types = await enumTypeNames();
    for (const type of ENUM_TYPES) {
      expect(types).not.toContain(type);
    }

    const functions = (await sql`
      SELECT proname FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND proname IN ('wallet_ledger_entry_guard', 'wager_transaction_guard', 'inbox_message_guard')
    `) as { proname: string }[];
    expect(functions).toHaveLength(0);
  });

  test('up recria o schema completo', async () => {
    await orm.getMigrator().up();

    const tables = await tableNames();
    for (const table of TABLES) {
      expect(tables).toContain(table);
    }

    const types = await enumTypeNames();
    for (const type of ENUM_TYPES) {
      expect(types).toContain(type);
    }
  });

  test('todas as constraints nomeadas existem', async () => {
    await orm.getMigrator().up();

    const rows = (await sql`
      SELECT conname FROM pg_constraint WHERE connamespace = 'public'::regnamespace
    `) as { conname: string }[];
    const present = new Set(rows.map((row) => row.conname));

    const missing = CONSTRAINTS.filter((name) => !present.has(name));
    expect(missing).toEqual([]);
  });

  test('índices parciais e de paginação existem', async () => {
    await orm.getMigrator().up();

    const rows = (await sql`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
    `) as { indexname: string }[];
    const present = new Set(rows.map((row) => row.indexname));

    const missing = INDEXES.filter((name) => !present.has(name));
    expect(missing).toEqual([]);
  });

  test('triggers de imutabilidade existem', async () => {
    await orm.getMigrator().up();

    const rows = (await sql`
      SELECT tgname FROM pg_trigger WHERE NOT tgisinternal
    `) as { tgname: string }[];
    const present = new Set(rows.map((row) => row.tgname));

    const missing = TRIGGERS.filter((name) => !present.has(name));
    expect(missing).toEqual([]);
  });

  test('a role de runtime não recebe DELETE em nenhuma tabela', async () => {
    await orm.getMigrator().up();

    const rows = (await sql`
      SELECT table_name, privilege_type
      FROM information_schema.table_privileges
      WHERE grantee = 'wagering_app' AND privilege_type IN ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
    `) as { table_name: string; privilege_type: string }[];

    expect(rows).toEqual([]);
  });

  test('a role de runtime não recebe UPDATE no ledger', async () => {
    await orm.getMigrator().up();

    const rows = (await sql`
      SELECT privilege_type FROM information_schema.table_privileges
      WHERE grantee = 'wagering_app' AND table_name = 'wallet_ledger_entry'
    `) as { privilege_type: string }[];

    const granted = rows.map((row) => row.privilege_type).sort();
    expect(granted).toEqual(['INSERT', 'SELECT']);
  });

  test('UPDATE da role de runtime é restrito às colunas mutáveis de cada lifecycle', async () => {
    await orm.getMigrator().up();

    const rows = (await sql`
      SELECT table_name, column_name
      FROM information_schema.column_privileges
      WHERE grantee = 'wagering_app' AND privilege_type = 'UPDATE'
      ORDER BY table_name, column_name
    `) as { table_name: string; column_name: string }[];

    const byTable = new Map<string, string[]>();
    for (const row of rows) {
      byTable.set(row.table_name, [...(byTable.get(row.table_name) ?? []), row.column_name]);
    }

    expect(byTable.get('wallet')).toEqual(['balance', 'updated_at', 'version']);
    expect(byTable.get('inbox_message')).toEqual(['processed_at']);
    expect(byTable.get('wager_transaction')).toEqual([
      'attempts',
      'expires_at',
      'failure_code',
      'next_attempt_at',
      'processed_at',
      'reference_transaction_id',
      'result_balance_amount',
      'result_balance_currency',
      'status',
    ]);
    expect(byTable.get('outbox_message')).toEqual([
      'attempts',
      'claimed_by',
      'claimed_until',
      'last_error',
      'next_attempt_at',
      'published_at',
    ]);
    expect(byTable.get('wallet_ledger_entry')).toBeUndefined();
  });

  test('toda coluna monetária é numeric(20,2)', async () => {
    await orm.getMigrator().up();

    const rows = (await sql`
      SELECT table_name || '.' || column_name AS column_ref,
             data_type, numeric_precision, numeric_scale
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name || '.' || column_name IN (
          'wallet.balance',
          'wager_transaction.amount',
          'wager_transaction.result_balance_amount',
          'wallet_ledger_entry.amount',
          'wallet_ledger_entry.balance_before',
          'wallet_ledger_entry.balance_after'
        )
      ORDER BY 1
    `) as {
      column_ref: string;
      data_type: string;
      numeric_precision: number;
      numeric_scale: number;
    }[];

    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect([row.column_ref, row.data_type, row.numeric_precision, row.numeric_scale]).toEqual([
        row.column_ref,
        'numeric',
        20,
        2,
      ]);
    }
  });

  test('não existe coluna de ponto flutuante em nenhuma tabela', async () => {
    await orm.getMigrator().up();

    const rows = (await sql`
      SELECT table_name || '.' || column_name AS column_ref, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND data_type IN ('real', 'double precision', 'float')
    `) as { column_ref: string; data_type: string }[];

    expect(rows).toEqual([]);
  });
});
