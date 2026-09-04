import { describe, expect, test } from 'bun:test';

import { canonicalize, payloadHashOf, type BusinessPayload } from '@/application/idempotency/payload-hash';
import { Money } from '@/domain/money';
import { WagerTransactionKind } from '@/domain/wager-transaction';

function payload(overrides: Partial<BusinessPayload> = {}): BusinessPayload {
  return {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    playerId: 'player-1',
    walletId: 'wallet-1',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    ...overrides,
  };
}

describe('payloadHash', () => {
  test('é SHA-256 hexadecimal', () => {
    expect(payloadHashOf(payload())).toMatch(/^[0-9a-f]{64}$/);
  });

  test('TST-020 payload divergente produz hash diferente', () => {
    expect(payloadHashOf(payload())).not.toBe(
      payloadHashOf(payload({ money: Money.from({ amount: '30.00', currency: 'BRL' }) })),
    );
  });

  test('ordem das chaves do objeto de origem não muda o hash', () => {
    const direct = payloadHashOf(payload());
    const reordered = payloadHashOf({
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      kind: WagerTransactionKind.Bet,
      gameId: 'fortune-chimp',
      roundId: 'round-987',
      walletId: 'wallet-1',
      playerId: 'player-1',
      externalTransactionId: 'transaction-123',
      providerId: 'provider-a',
    });

    expect(reordered).toBe(direct);
  });

  test('escala e zeros à esquerda são normalizados antes do hash, então não viram conflito', () => {
    const canonical = payloadHashOf(payload());

    for (const amount of ['25', '25.0', '025.00']) {
      expect(payloadHashOf(payload({ money: Money.from({ amount, currency: 'BRL' }) }))).toBe(
        canonical,
      );
    }
  });

  test('a idempotency key e metadados de transporte não entram no hash', () => {
    const canonical = canonicalize({
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      playerId: 'player-1',
      walletId: 'wallet-1',
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      amount: '25.00',
      currency: 'BRL',
    });

    expect(canonical).not.toContain('idempotencyKey');
    expect(canonical).not.toContain('messageId');
    expect(canonical).not.toContain('occurredAt');
  });

  test('referenceExternalTransactionId entra quando existe e é omitido quando não', () => {
    const withReference = payloadHashOf(payload({ referenceExternalTransactionId: 'transaction-0' }));
    const withoutReference = payloadHashOf(payload());

    expect(withReference).not.toBe(withoutReference);
    expect(payloadHashOf(payload({ referenceExternalTransactionId: undefined }))).toBe(
      withoutReference,
    );
  });

  test('canonicalize ordena as chaves por code unit', () => {
    expect(canonicalize({ b: '2', a: '1', C: '3' })).toBe('{"C":"3","a":"1","b":"2"}');
  });
});
