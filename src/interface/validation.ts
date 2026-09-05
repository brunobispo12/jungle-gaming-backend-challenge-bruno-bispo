import { ApplicationError, ErrorCode } from '@/application/errors';
import { InvalidMoneyError } from '@/domain/domain-error';
import { Money, type MoneyProps } from '@/domain/money';
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

export function boundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    invalid(`${field} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    invalid(`${field} must have at most ${maxLength} characters`);
  }
  return value;
}

export function requiredString(
  source: Record<string, unknown>,
  field: string,
  maxLength = Number.MAX_SAFE_INTEGER,
): string {
  const value = source[field];
  return boundedString(value, field, maxLength);
}

function optionalString(
  source: Record<string, unknown>,
  field: string,
  maxLength: number,
): string | undefined {
  const value = source[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  return boundedString(value, field, maxLength);
}

const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_FORMAT.test(value)) {
    invalid(`${field} must be a UUID`);
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
  try {
    return Money.from({ amount: props['amount'], currency: props['currency'] }).toJSON();
  } catch (error: unknown) {
    if (error instanceof InvalidMoneyError) {
      invalid(`${field} is invalid: ${error.message}`);
    }
    throw error;
  }
}

export interface CreateWalletBody {
  readonly playerId: string;
  readonly initialBalance: MoneyProps;
}

export function parseCreateWallet(body: unknown): CreateWalletBody {
  const source = asRecord(body);
  return {
    playerId: requiredString(source, 'playerId', 64),
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

const REFERENCE_BEARING_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
  WagerTransactionKind.Win,
];

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

  const providerId = requiredString(source, 'providerId', 64);
  if (providerId === INTERNAL_PROVIDER_ID) {
    throw new ApplicationError(
      ErrorCode.ReservedProviderId,
      `${INTERNAL_PROVIDER_ID} is reserved for internal transactions`,
    );
  }

  const parsed: SubmitWagerBody = {
    providerId,
    externalTransactionId: requiredString(source, 'externalTransactionId', 128),
    playerId: requiredString(source, 'playerId', 64),
    walletId: requireUuid(source['walletId'], 'walletId'),
    roundId: requiredString(source, 'roundId', 128),
    gameId: requiredString(source, 'gameId', 128),
    kind: kind as WagerTransactionKind,
    money: money(source, 'money'),
    referenceExternalTransactionId: optionalString(
      source,
      'referenceExternalTransactionId',
      128,
    ),
  };

  const needsReference =
    parsed.kind === WagerTransactionKind.Refund || parsed.kind === WagerTransactionKind.Rollback;
  if (needsReference && parsed.referenceExternalTransactionId === undefined) {
    throw new ApplicationError(
      ErrorCode.ReferenceRequired,
      `${parsed.kind} requires referenceExternalTransactionId`,
    );
  }

  // Mirrors wager_reference_external_by_kind_ck: without this the row is refused
  // by the CHECK during the identity reservation, and a payload defect surfaces
  // as an infrastructure error instead of a rejected request (README §9, §10).
  if (
    parsed.referenceExternalTransactionId !== undefined &&
    !REFERENCE_BEARING_KINDS.includes(parsed.kind)
  ) {
    invalid(`${parsed.kind} must not carry referenceExternalTransactionId`);
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
  if (header.length > 255) {
    invalid('Idempotency-Key must have at most 255 characters');
  }
  return header;
}
