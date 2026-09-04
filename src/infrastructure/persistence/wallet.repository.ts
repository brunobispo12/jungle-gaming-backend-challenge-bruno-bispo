import { LockMode, type EntityManager } from '@mikro-orm/postgresql';

import { NOOP_METRICS, type MetricsPort, type WalletRepository } from '@/application/ports';
import type { Wallet } from '@/domain/wallet';
import { toWallet, toWalletRow } from './mappers';
import { lockConflictReason } from './postgres-errors';
import { StaleWriteError } from './stale-write-error';
import { walletSchema, type WalletRow } from './rows';

export class MikroWalletRepository implements WalletRepository {
  constructor(
    private readonly em: EntityManager,
    private readonly metrics: MetricsPort = NOOP_METRICS,
  ) {}

  async insertIfAbsent(wallet: Wallet): Promise<Wallet | undefined> {
    const inserted = await this.em
      .createQueryBuilder(walletSchema)
      .insert(toWalletRow(wallet))
      .onConflict()
      .ignore()
      .returning('*')
      .execute<WalletRow[]>('all');

    return inserted[0] ? toWallet(inserted[0]) : undefined;
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(walletSchema, { id }, { refresh: true });
    return row ? toWallet(row) : undefined;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(walletSchema, { playerId, currency }, { refresh: true });
    return row ? toWallet(row) : undefined;
  }

  // Blocking FOR UPDATE. Under READ COMMITTED the lock re-reads the row after the
  // holder commits, so the loser of a race decides against the winner's balance.
  async lockById(id: string): Promise<Wallet | undefined> {
    const startedAt = performance.now();
    let outcome: 'acquired' | 'not_found' | 'lock_timeout' | 'deadlock' | 'error' = 'error';

    try {
      const row = await this.em.findOne(
        walletSchema,
        { id },
        { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
      );
      outcome = row ? 'acquired' : 'not_found';
      return row ? toWallet(row) : undefined;
    } catch (error: unknown) {
      const conflict = lockConflictReason(error);
      if (conflict !== undefined) {
        outcome = conflict;
        this.metrics.recordLockConflict(conflict);
      }
      throw error;
    } finally {
      this.metrics.observeWalletLock((performance.now() - startedAt) / 1_000, outcome);
    }
  }

  async update(wallet: Wallet): Promise<void> {
    const row = toWalletRow(wallet);
    const affected = await this.em.nativeUpdate(
      walletSchema,
      { id: row.id },
      { balance: row.balance, version: row.version, updatedAt: row.updatedAt },
    );

    if (affected !== 1) {
      throw new StaleWriteError('wallet', row.id, affected);
    }
  }
}
