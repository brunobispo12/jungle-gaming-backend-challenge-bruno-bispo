export const FailureCode = {
  InsufficientFunds: 'INSUFFICIENT_FUNDS',
  ReversalWouldOverdraw: 'REVERSAL_WOULD_OVERDRAW',
  ReferenceNotFound: 'REFERENCE_NOT_FOUND',
  ReferenceNotProcessed: 'REFERENCE_NOT_PROCESSED',
  ReferenceKindNotReversible: 'REFERENCE_KIND_NOT_REVERSIBLE',
  ReferenceMismatch: 'REFERENCE_MISMATCH',
  ReversalAmountMismatch: 'REVERSAL_AMOUNT_MISMATCH',
  ReferenceAlreadyReversed: 'REFERENCE_ALREADY_REVERSED',
  CurrencyMismatch: 'CURRENCY_MISMATCH',
  WalletNotFound: 'WALLET_NOT_FOUND',
  WalletPlayerMismatch: 'WALLET_PLAYER_MISMATCH',
  InfrastructureFailure: 'INFRASTRUCTURE_FAILURE',
} as const;

export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];
