import { FailureCode } from './failure-code';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
  type WagerTransaction,
} from './wager-transaction';

function bindingFailure(
  operation: WagerTransaction,
  reference: WagerTransaction,
): FailureCode | undefined {
  if (reference.status !== WagerTransactionStatus.Processed) {
    return FailureCode.ReferenceNotProcessed;
  }
  if (
    reference.providerId !== operation.providerId ||
    reference.playerId !== operation.playerId ||
    reference.walletId !== operation.walletId ||
    reference.roundId !== operation.roundId
  ) {
    return FailureCode.ReferenceMismatch;
  }
  if (reference.money.currency !== operation.money.currency) {
    return FailureCode.CurrencyMismatch;
  }
  return undefined;
}

export function referenceIsSettled(reference: WagerTransaction): boolean {
  return reference.isTerminal();
}

export function reversalFailure(
  reversal: WagerTransaction,
  reference: WagerTransaction,
): FailureCode | undefined {
  if (!reversal.reversibleKinds().includes(reference.kind)) {
    return FailureCode.ReferenceKindNotReversible;
  }

  const binding = bindingFailure(reversal, reference);
  if (binding) {
    return binding;
  }

  if (!reference.money.equals(reversal.money)) {
    return FailureCode.ReversalAmountMismatch;
  }
  return undefined;
}

// A WIN may reference the BET of its round (README §7). The link is optional,
// but once the reference resolves it is validated like any other: amounts are
// free to differ, everything binding it to the round is not.
export function winReferenceFailure(
  win: WagerTransaction,
  reference: WagerTransaction,
): FailureCode | undefined {
  if (reference.kind !== WagerTransactionKind.Bet) {
    return FailureCode.ReferenceMismatch;
  }
  return bindingFailure(win, reference);
}
