export const ErrorCode = {
  InvalidPayload: 'INVALID_PAYLOAD',
  PayloadTooLarge: 'PAYLOAD_TOO_LARGE',
  UnsupportedMediaType: 'UNSUPPORTED_MEDIA_TYPE',
  MissingIdempotencyKey: 'MISSING_IDEMPOTENCY_KEY',
  IdempotencyKeyConflict: 'IDEMPOTENCY_KEY_CONFLICT',
  ExternalTransactionIdReused: 'EXTERNAL_TRANSACTION_ID_REUSED',
  ReferenceRequired: 'REFERENCE_REQUIRED',
  AmountNotPositive: 'AMOUNT_NOT_POSITIVE',
  ReservedProviderId: 'RESERVED_PROVIDER_ID',
  WalletAlreadyExists: 'WALLET_ALREADY_EXISTS',
  ResourceNotFound: 'RESOURCE_NOT_FOUND',
  ServiceUnavailable: 'SERVICE_UNAVAILABLE',
  InternalError: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class ApplicationError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}
