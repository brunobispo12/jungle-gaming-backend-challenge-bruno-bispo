import { describe, expect, test } from 'bun:test';

import {
  isTransientDatabaseFailure,
  lockConflictReason,
} from '@/infrastructure/persistence/postgres-errors';

function driverException(sqlState: string): Error {
  const previous = Object.assign(new Error('driver failure'), { code: sqlState });
  return Object.assign(new Error('wrapped by the ORM'), { previous });
}

describe('classificação de falha transitória', () => {
  test.each([
    ['lock_timeout expirado', '55P03'],
    ['deadlock', '40P01'],
    ['serialization failure', '40001'],
    ['conexões esgotadas', '53300'],
    ['shutdown administrativo', '57P01'],
    ['classe 08 de conexão', '08006'],
  ])('%s é transitório', (_label, sqlState) => {
    expect(isTransientDatabaseFailure(driverException(sqlState))).toBe(true);
  });

  test.each([
    ['55P03', 'lock_timeout'],
    ['40P01', 'deadlock'],
  ] as const)('classifica %s como conflito de lock %s', (sqlState, reason) => {
    expect(lockConflictReason(driverException(sqlState))).toBe(reason);
  });

  test.each([
    ['violação de unique', '23505'],
    ['violação de check', '23514'],
    ['violação de foreign key', '23503'],
    ['privilégio insuficiente', '42501'],
    ['guarda de imutabilidade', '0A000'],
  ])('%s não é transitório: reenviar não ajuda', (_label, sqlState) => {
    expect(isTransientDatabaseFailure(driverException(sqlState))).toBe(false);
  });

  test('lê o SQLSTATE no campo errno usado pelo cliente do Bun', () => {
    expect(isTransientDatabaseFailure(Object.assign(new Error('x'), { errno: '40P01' }))).toBe(true);
  });

  test.each([
    ['conexão resetada pelo servidor', 'ECONNRESET'],
    ['servidor recusando conexão', 'ECONNREFUSED'],
    ['socket estourou o tempo', 'ETIMEDOUT'],
    ['dns temporariamente indisponível', 'EAI_AGAIN'],
  ])('%s é transitório mesmo sem SQLSTATE', (_label, socketCode) => {
    const previous = Object.assign(new Error('socket failure'), { code: socketCode });
    expect(isTransientDatabaseFailure(Object.assign(new Error('wrapped'), { previous }))).toBe(true);
  });

  test.each([
    ['Connection terminated unexpectedly'],
    ['socket hang up'],
    ['timeout exceeded when trying to connect'],
  ])('perda de conexão reconhecida pela mensagem: %s', (message) => {
    expect(isTransientDatabaseFailure(new Error(message))).toBe(true);
  });

  test('perda de conexão sem SQLSTATE não vira falha determinística', () => {
    const previous = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    const wrapped = Object.assign(new Error('query failed'), { previous });

    expect(isTransientDatabaseFailure(wrapped)).toBe(true);
    expect(lockConflictReason(wrapped)).toBeUndefined();
  });

  test('erro comum e ciclo na cadeia de causas não travam a classificação', () => {
    expect(isTransientDatabaseFailure(new Error('boom'))).toBe(false);
    expect(isTransientDatabaseFailure(undefined)).toBe(false);

    const cyclic = new Error('a') as Error & { previous?: unknown };
    cyclic.previous = cyclic;
    expect(isTransientDatabaseFailure(cyclic)).toBe(false);
  });
});
