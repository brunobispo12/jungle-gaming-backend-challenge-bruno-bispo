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
  credited: string;
  debited: string;
  entries: string;
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

  // Raw SQL: the aggregate is the reconciliation definition itself. Both FILTER
  // sums stay non-negative so the subtraction happens in Money, where a negative
  // difference is legitimate and must be reported rather than thrown.
  async reconstructBalance(wallet: Wallet): Promise<ReconstructedBalance> {
    const [row] = await this.em.getConnection().execute<ReconstructionRow[]>(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0)::text AS credited,
         COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0)::text AS debited,
         COUNT(*)::text AS entries
       FROM wallet_ledger_entry
       WHERE wallet_id = ?`,
      [wallet.id],
      'all',
      this.em.getTransactionContext(),
    );

    // An empty ledger has no currency of its own, so it comes from the wallet.
    const asMoney = (amount: string): Money =>
      Money.from({ amount, currency: wallet.currency });

    return {
      balance: asMoney(row?.credited ?? '0').subtract(asMoney(row?.debited ?? '0')),
      entries: Number.parseInt(row?.entries ?? '0', 10),
    };
  }
}
