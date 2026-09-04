import { ApplicationError, ErrorCode } from '@/application/errors';
import type { MoneyProps } from '@/domain/money';
import { INTERNAL_PROVIDER_ID, WagerTransactionKind } from '@/domain/wager-transaction';

export function invalid(message: string): never {
  throw new ApplicationError(ErrorCode.InvalidPayload, message);
}

export function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    invalid('body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

export function requiredString(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  if (typeof value !== 'string' || value.trim() === '') {
    invalid(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(source: Record<string, unknown>, field: string): string | undefined {
  const value = source[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    invalid(`${field} must be a non-empty string when present`);
  }
  return value;
}

function money(source: Record<string, unknown>, field: string): MoneyProps {
  const value = source[field];
  if (typeof value !== 'object' || value === null) {
    invalid(`${field} must be an object with amount and currency`);
  }
  const props = value as Record<string, unknown>;
  if (typeof props['amount'] !== 'string') {
    invalid(`${field}.amount must be a decimal string`);
  }
  if (typeof props['currency'] !== 'string') {
    invalid(`${field}.currency must be a string`);
  }
  return { amount: props['amount'], currency: props['currency'] };
}

export interface CreateWalletBody {
  readonly playerId: string;
  readonly initialBalance: MoneyProps;
}

export function parseCreateWallet(body: unknown): CreateWalletBody {
  const source = asRecord(body);
  return {
    playerId: requiredString(source, 'playerId'),
    initialBalance: money(source, 'initialBalance'),
  };
}

export interface SubmitWagerBody {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId: string | undefined;
}

const SUBMITTABLE_KINDS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;

export function parseSubmitWager(body: unknown): SubmitWagerBody {
  const source = asRecord(body);
  const kind = requiredString(source, 'kind');

  if (!SUBMITTABLE_KINDS.includes(kind as (typeof SUBMITTABLE_KINDS)[number])) {
    invalid(`kind must be one of ${SUBMITTABLE_KINDS.join(', ')}`);
  }

  const providerId = requiredString(source, 'providerId');
  if (providerId === INTERNAL_PROVIDER_ID) {
    throw new ApplicationError(
      ErrorCode.ReservedProviderId,
      `${INTERNAL_PROVIDER_ID} is reserved for internal transactions`,
    );
  }

  const parsed: SubmitWagerBody = {
    providerId,
    externalTransactionId: requiredString(source, 'externalTransactionId'),
    playerId: requiredString(source, 'playerId'),
    walletId: requiredString(source, 'walletId'),
    roundId: requiredString(source, 'roundId'),
    gameId: requiredString(source, 'gameId'),
    kind: kind as WagerTransactionKind,
    money: money(source, 'money'),
    referenceExternalTransactionId: optionalString(source, 'referenceExternalTransactionId'),
  };

  const needsReference =
    parsed.kind === WagerTransactionKind.Refund || parsed.kind === WagerTransactionKind.Rollback;
  if (needsReference && parsed.referenceExternalTransactionId === undefined) {
    throw new ApplicationError(
      ErrorCode.ReferenceRequired,
      `${parsed.kind} requires referenceExternalTransactionId`,
    );
  }

  return parsed;
}

export function requireIdempotencyKey(header: unknown): string {
  if (typeof header !== 'string' || header.trim() === '') {
    throw new ApplicationError(
      ErrorCode.MissingIdempotencyKey,
      'the Idempotency-Key header is required',
    );
  }
  return header;
}
