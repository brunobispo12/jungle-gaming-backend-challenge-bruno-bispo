import { FailureCode } from './failure-code';
import { WagerTransaction, WagerTransactionStatus } from './wager-transaction';

export function reversalFailure(
  reversal: WagerTransaction,
  reference: WagerTransaction,
): FailureCode | undefined {
  if (!reversal.reversibleKinds().includes(reference.kind)) {
    return FailureCode.ReferenceKindNotReversible;
  }
  if (reference.status !== WagerTransactionStatus.Processed) {
    return FailureCode.ReferenceNotProcessed;
  }
  if (
    reference.providerId !== reversal.providerId ||
    reference.playerId !== reversal.playerId ||
    reference.walletId !== reversal.walletId ||
    reference.roundId !== reversal.roundId
  ) {
    return FailureCode.ReferenceMismatch;
  }
  if (reference.money.currency !== reversal.money.currency) {
    return FailureCode.CurrencyMismatch;
  }
  if (!reference.money.equals(reversal.money)) {
    return FailureCode.ReversalAmountMismatch;
  }
  return undefined;
}
