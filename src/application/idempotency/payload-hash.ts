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

export function canonicalize(value: Record<string, string>): string {
  const sorted = Object.keys(value).sort();
  const entries = sorted.map((key) => `${JSON.stringify(key)}:${JSON.stringify(value[key])}`);
  return `{${entries.join(',')}}`;
}
