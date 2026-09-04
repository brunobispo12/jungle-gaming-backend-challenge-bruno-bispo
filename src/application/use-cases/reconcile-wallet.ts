import { ApplicationError, ErrorCode } from '@/application/errors';
import { NOOP_METRICS, type MetricsPort, type UnitOfWork } from '@/application/ports';
import type { MoneyProps } from '@/domain/money';

export interface ReconciliationReport {
  readonly walletId: string;
  readonly storedBalance: MoneyProps;
  readonly calculatedBalance: MoneyProps;
  readonly difference: MoneyProps;
  readonly consistent: boolean;
  readonly checkedEntries: number;
}

export class ReconcileWalletUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly metrics: MetricsPort = NOOP_METRICS,
  ) {}

  // Read-only on purpose: repairing the balance here would hide the defect and
  // force a choice of which side is right without any operational context.
  async execute(walletId: string): Promise<ReconciliationReport> {
    const report = await this.unitOfWork.readOnly(async (repositories) => {
      const wallet = await repositories.wallets.findById(walletId);
      if (wallet === undefined) {
        throw new ApplicationError(ErrorCode.ResourceNotFound, 'wallet not found');
      }

      const reconstructed = await repositories.ledger.reconstructBalance(wallet);
      const difference = wallet.balance.subtract(reconstructed.balance);

      return {
        walletId: wallet.id,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: reconstructed.balance.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries: reconstructed.entries,
      };
    });
    this.metrics.recordReconciliation(report.consistent);
    return report;
  }
}
