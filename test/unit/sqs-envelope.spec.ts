import { describe, expect, test } from 'bun:test';

import { ApplicationError, ErrorCode } from '@/application/errors';
import { WagerTransactionKind } from '@/domain/wager-transaction';
import { CONSUMER_NAME, correlationIdOf, parseWagerMessage } from '@/interface/sqs/envelope';

const DATA = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  idempotencyKey: 'provider-a:transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

const ENVELOPE = {
  messageId: 'msg-123',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-07-29T15:00:00.000Z',
  data: DATA,
};

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...ENVELOPE, ...overrides });
}

function failureOf(raw: string): ErrorCode {
  try {
    parseWagerMessage(raw);
  } catch (error: unknown) {
    if (error instanceof ApplicationError) {
      return error.code;
    }
    throw error;
  }
  throw new Error('o envelope deveria ter sido recusado');
}

describe('parseWagerMessage', () => {
  test('traduz o envelope no mesmo comando que o HTTP submete', () => {
    const message = parseWagerMessage(body());

    expect(message.messageId).toBe('msg-123');
    expect(message.occurredAt).toEqual(new Date('2026-07-29T15:00:00.000Z'));
    expect(message.command).toMatchObject({
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      idempotencyKey: 'provider-a:transaction-123',
      playerId: DATA.playerId,
      walletId: DATA.walletId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
    });
  });

  test('deriva o correlationId do consumidor e usa o messageId como causationId', () => {
    const message = parseWagerMessage(body());

    expect(message.command.correlationId).toBe(correlationIdOf(CONSUMER_NAME, 'msg-123'));
    expect(message.command.causationId).toBe('msg-123');
  });

  test('o correlationId é determinístico e cabe na coluna', () => {
    const first = correlationIdOf(CONSUMER_NAME, 'msg-123');

    expect(correlationIdOf(CONSUMER_NAME, 'msg-123')).toBe(first);
    expect(correlationIdOf(CONSUMER_NAME, 'msg-124')).not.toBe(first);
    expect(first).toHaveLength(64);
  });

  test('o hash da inbox não depende da ordem das chaves', () => {
    const reordered = JSON.stringify({
      data: {
        money: { currency: 'BRL', amount: '25.00' },
        kind: DATA.kind,
        gameId: DATA.gameId,
        roundId: DATA.roundId,
        walletId: DATA.walletId,
        playerId: DATA.playerId,
        idempotencyKey: DATA.idempotencyKey,
        externalTransactionId: DATA.externalTransactionId,
        providerId: DATA.providerId,
      },
      occurredAt: ENVELOPE.occurredAt,
      type: ENVELOPE.type,
      messageId: ENVELOPE.messageId,
    });

    expect(parseWagerMessage(reordered).inboxPayloadHash).toBe(
      parseWagerMessage(body()).inboxPayloadHash,
    );
  });

  test('o hash da inbox cobre a idempotencyKey', () => {
    const other = body({ data: { ...DATA, idempotencyKey: 'provider-a:outra' } });

    expect(parseWagerMessage(other).inboxPayloadHash).not.toBe(
      parseWagerMessage(body()).inboxPayloadHash,
    );
  });

  test('o hash da inbox cobre occurredAt', () => {
    const other = body({ occurredAt: '2026-07-29T15:00:01.000Z' });

    expect(parseWagerMessage(other).inboxPayloadHash).not.toBe(
      parseWagerMessage(body()).inboxPayloadHash,
    );
  });

  test('o hash da inbox não depende do messageId, que já é a chave', () => {
    const other = body({ messageId: 'msg-999' });

    expect(parseWagerMessage(other).inboxPayloadHash).toBe(
      parseWagerMessage(body()).inboxPayloadHash,
    );
  });

  test('corpo que não é JSON é payload inválido', () => {
    expect(failureOf('não é json')).toBe(ErrorCode.InvalidPayload);
  });

  test('type diferente do esperado é payload inválido', () => {
    expect(failureOf(body({ type: 'WalletCreated' }))).toBe(ErrorCode.InvalidPayload);
  });

  test('messageId ausente é payload inválido', () => {
    expect(failureOf(JSON.stringify({ ...ENVELOPE, messageId: '' }))).toBe(ErrorCode.InvalidPayload);
  });

  test('occurredAt inválido é payload inválido', () => {
    expect(failureOf(body({ occurredAt: 'ontem' }))).toBe(ErrorCode.InvalidPayload);
  });

  test('data sem idempotencyKey é payload inválido', () => {
    const { idempotencyKey: _removed, ...withoutKey } = DATA;

    expect(failureOf(body({ data: withoutKey }))).toBe(ErrorCode.InvalidPayload);
  });

  test('herda a validação de negócio da entrada HTTP', () => {
    const refundWithoutReference = body({ data: { ...DATA, kind: 'REFUND' } });

    expect(failureOf(refundWithoutReference)).toBe(ErrorCode.ReferenceRequired);
  });

  test('o provider interno continua reservado na entrada por fila', () => {
    expect(failureOf(body({ data: { ...DATA, providerId: 'internal' } }))).toBe(
      ErrorCode.ReservedProviderId,
    );
  });
});
