import { describe, expect, test } from 'bun:test';

import { ApplicationError, ErrorCode } from '@/application/errors';
import {
  encodeLedgerCursor,
  parseLedgerQuery,
  LEDGER_DEFAULT_LIMIT,
  LEDGER_MAX_LIMIT,
} from '@/interface/http/ledger-query';

const AT = new Date('2026-07-29T15:00:00.000Z');
const ID = '0192f291-27dd-7d3f-8071-5f8685deef37';

function failureOf(cursor: string | undefined, limit?: string): ErrorCode {
  try {
    parseLedgerQuery(cursor, limit);
  } catch (error: unknown) {
    if (error instanceof ApplicationError) {
      return error.code;
    }
    throw error;
  }
  throw new Error('a query deveria ter sido recusada');
}

describe('encodeLedgerCursor', () => {
  test('é opaco e seguro para URL', () => {
    const cursor = encodeLedgerCursor({ createdAt: AT, id: ID });

    expect(cursor).not.toContain(ID);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test('o mesmo lançamento sempre gera o mesmo cursor', () => {
    expect(encodeLedgerCursor({ createdAt: AT, id: ID })).toBe(
      encodeLedgerCursor({ createdAt: new Date(AT), id: ID }),
    );
  });
});

describe('parseLedgerQuery', () => {
  test('sem parâmetros usa o limite padrão e nenhum cursor', () => {
    expect(parseLedgerQuery(undefined, undefined)).toEqual({ limit: LEDGER_DEFAULT_LIMIT });
  });

  test('devolve o cursor decodificado', () => {
    const parsed = parseLedgerQuery(encodeLedgerCursor({ createdAt: AT, id: ID }), '10');

    expect(parsed).toEqual({ limit: 10, after: { createdAt: AT, id: ID } });
  });

  test('aceita o limite máximo e recusa acima dele', () => {
    expect(parseLedgerQuery(undefined, String(LEDGER_MAX_LIMIT)).limit).toBe(LEDGER_MAX_LIMIT);
    expect(failureOf(undefined, String(LEDGER_MAX_LIMIT + 1))).toBe(ErrorCode.InvalidPayload);
  });

  test('recusa limite abaixo de um, fracionário ou não numérico', () => {
    expect(failureOf(undefined, '0')).toBe(ErrorCode.InvalidPayload);
    expect(failureOf(undefined, '-5')).toBe(ErrorCode.InvalidPayload);
    expect(failureOf(undefined, '1.5')).toBe(ErrorCode.InvalidPayload);
    expect(failureOf(undefined, 'muitos')).toBe(ErrorCode.InvalidPayload);
  });

  test('recusa cursor que não decodifica para lançamento e data', () => {
    expect(failureOf('nao-e-cursor')).toBe(ErrorCode.InvalidPayload);
    expect(failureOf(Buffer.from('sem-separador').toString('base64url'))).toBe(
      ErrorCode.InvalidPayload,
    );
    expect(failureOf(Buffer.from(`ontem|${ID}`).toString('base64url'))).toBe(
      ErrorCode.InvalidPayload,
    );
    expect(failureOf(Buffer.from(`${AT.toISOString()}|`).toString('base64url'))).toBe(
      ErrorCode.InvalidPayload,
    );
  });
});
