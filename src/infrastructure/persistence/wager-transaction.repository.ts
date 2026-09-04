import { LockMode, type EntityManager } from '@mikro-orm/postgresql';

import type { WagerTransactionRepository } from '@/application/ports';
import { WagerTransactionStatus, type WagerTransaction } from '@/domain/wager-transaction';
import { toWagerTransaction, toWagerTransactionRow } from './mappers';
import { StaleWriteError } from './stale-write-error';
import { wagerTransactionSchema, type WagerTransactionRow } from './rows';

export class MikroWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  // No conflict target: either unique identity — the idempotency key or the
  // provider's external id — must make this writer the loser.
  async reserve(transaction: WagerTransaction): Promise<WagerTransaction | undefined> {
    if (transaction.status !== WagerTransactionStatus.Pending) {
      throw new Error(
        `reserve expects a PENDING transaction, got ${transaction.status} (${transaction.id})`,
      );
    }

    const inserted = await this.em
      .createQueryBuilder(wagerTransactionSchema)
      .insert(toWagerTransactionRow(transaction))
      .onConflict()
      .ignore()
      .returning('*')
      .execute<WagerTransactionRow[]>('all');

    return inserted[0] ? toWagerTransaction(inserted[0]) : undefined;
  }

  async findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(
      wagerTransactionSchema,
      { providerId, idempotencyKey },
      { refresh: true },
    );
    return row ? toWagerTransaction(row) : undefined;
  }

  async findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(
      wagerTransactionSchema,
      { providerId, externalTransactionId },
      { refresh: true },
    );
    return row ? toWagerTransaction(row) : undefined;
  }

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(wagerTransactionSchema, { id }, { refresh: true });
    return row ? toWagerTransaction(row) : undefined;
  }

  async hasProcessedReversal(referenceTransactionId: string, kind: string): Promise<boolean> {
    const applied = await this.em.count(wagerTransactionSchema, {
      referenceTransactionId,
      kind,
      status: WagerTransactionStatus.Processed,
    });
    return applied > 0;
  }

  async lockById(id: string): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(
      wagerTransactionSchema,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return row ? toWagerTransaction(row) : undefined;
  }

  // FOR UPDATE SKIP LOCKED and no lease: the whole resolution is database work,
  // so the row lock survives until commit and a dead worker frees it at once.
  async lockDuePendingReference(now: Date): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(
      wagerTransactionSchema,
      { status: WagerTransactionStatus.PendingReference, nextAttemptAt: { $lte: now } },
      {
        orderBy: { nextAttemptAt: 'asc', id: 'asc' },
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        refresh: true,
      },
    );
    return row ? toWagerTransaction(row) : undefined;
  }

  async update(transaction: WagerTransaction): Promise<void> {
    const row = toWagerTransactionRow(transaction);
    const affected = await this.em.nativeUpdate(
      wagerTransactionSchema,
      { id: row.id },
      {
        status: row.status,
        failureCode: row.failureCode,
        processedAt: row.processedAt,
        referenceTransactionId: row.referenceTransactionId,
        resultBalanceAmount: row.resultBalanceAmount,
        resultBalanceCurrency: row.resultBalanceCurrency,
        attempts: row.attempts,
        nextAttemptAt: row.nextAttemptAt,
        expiresAt: row.expiresAt,
      },
    );

    if (affected !== 1) {
      throw new StaleWriteError('wager_transaction', row.id, affected);
    }
  }
}
