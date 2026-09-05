import type { EntityManager } from '@mikro-orm/postgresql';

import type {
  LedgerCursor,
  LedgerPage,
  LedgerRepository,
  ReconstructedBalance,
} from '@/application/ports';
import { Money } from '@/domain/money';
import type { Wallet } from '@/domain/wallet';
import type { WalletLedgerEntry } from '@/domain/wallet-ledger-entry';
import { toLedgerEntry, toLedgerEntryRow } from './mappers';
import { walletLedgerEntrySchema } from './rows';

interface ReconstructionRow {
  balance: string;
  entries: string;
}

function reconstructedMoney(amount: string, currency: string): Money {
  return amount.startsWith('-')
    ? Money.from({ amount: amount.slice(1), currency }).negate()
    : Money.from({ amount, currency });
}

export class MikroLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(walletLedgerEntrySchema, toLedgerEntryRow(entry));
  }

  // Keyset over (created_at, id) descending, matching ledger_wallet_keyset_ix.
  // OFFSET would drift as new entries land while the client walks the pages.
  async page(wallet: Wallet, limit: number, after?: LedgerCursor): Promise<LedgerPage> {
    const rows = await this.em.find(
      walletLedgerEntrySchema,
      {
        walletId: wallet.id,
        ...(after === undefined
          ? {}
          : {
              $or: [
                { createdAt: { $lt: after.createdAt } },
                { createdAt: after.createdAt, id: { $lt: after.id } },
              ],
            }),
      },
      { orderBy: { createdAt: 'desc', id: 'desc' }, limit: limit + 1, refresh: true },
    );

    return {
      entries: rows.slice(0, limit).map((row) => toLedgerEntry(row)),
      hasMore: rows.length > limit,
    };
  }

  // Raw SQL computes the signed net before Money enforces numeric(20,2)'s range.
  // Gross lifetime turnover may exceed that range even when the valid net does not.
  async reconstructBalance(wallet: Wallet): Promise<ReconstructedBalance> {
    const [row] = await this.em.getConnection().execute<ReconstructionRow[]>(
      `SELECT
         COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::text
           AS balance,
         COUNT(*)::text AS entries
       FROM wallet_ledger_entry
       WHERE wallet_id = ?`,
      [wallet.id],
      'all',
      this.em.getTransactionContext(),
    );

    return {
      // Money.from intentionally rejects negative input contracts. Reconciliation
      // must retain a negative net as diagnostic evidence, so negate a valid
      // magnitude instead of discarding or clamping it.
      balance: reconstructedMoney(row?.balance ?? '0', wallet.currency),
      entries: Number.parseInt(row?.entries ?? '0', 10),
    };
  }
}
