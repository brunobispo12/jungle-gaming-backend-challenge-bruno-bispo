import { createHash } from 'node:crypto';

import type { Money } from '@/domain/money';
import type { WagerTransactionKind } from '@/domain/wager-transaction';

export interface BusinessPayload {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string | undefined;
}

export function payloadHashOf(payload: BusinessPayload): string {
  const fields: Record<string, string> = {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    amount: payload.money.toString(),
    currency: payload.money.currency,
  };

  if (payload.referenceExternalTransactionId !== undefined) {
    fields['referenceExternalTransactionId'] = payload.referenceExternalTransactionId;
  }

  return createHash('sha256').update(canonicalize(fields), 'utf8').digest('hex');
}

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }

  const source = value as Record<string, unknown>;
  const entries = Object.keys(source)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(source[key])}`);
  return `{${entries.join(',')}}`;
}
