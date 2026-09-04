import { IsolationLevel, MikroORM, type EntityManager } from '@mikro-orm/postgresql';

import {
  NOOP_METRICS,
  type MetricsPort,
  type Repositories,
  type UnitOfWork,
} from '@/application/ports';
import { MikroInboxRepository } from './inbox.repository';
import { MikroLedgerRepository } from './ledger.repository';
import { MikroOutboxRepository } from './outbox.repository';
import { MikroWagerTransactionRepository } from './wager-transaction.repository';
import { MikroWalletRepository } from './wallet.repository';

function repositoriesFor(em: EntityManager, metrics: MetricsPort): Repositories {
  return {
    wallets: new MikroWalletRepository(em, metrics),
    wagerTransactions: new MikroWagerTransactionRepository(em),
    ledger: new MikroLedgerRepository(em),
    inbox: new MikroInboxRepository(em),
    outbox: new MikroOutboxRepository(em),
  };
}

function runInTransaction(em: EntityManager, statement: string): Promise<unknown> {
  return em.getConnection().execute(statement, [], 'run', em.getTransactionContext());
}

export class MikroUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly lockTimeoutMs: number,
    private readonly metrics: MetricsPort = NOOP_METRICS,
  ) {}

  // REPEATABLE READ READ ONLY so a reconciliation reads the wallet balance and the
  // ledger sum in one snapshot; a single-statement query is correct here too.
  async readOnly<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return this.orm.em.fork().transactional(
      async (em) => {
        await runInTransaction(em, 'SET TRANSACTION READ ONLY');
        return work(repositoriesFor(em, this.metrics));
      },
      { isolationLevel: IsolationLevel.REPEATABLE_READ },
    );
  }

  async transactional<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return this.orm.em.fork().transactional(async (em) => {
      // Bounds the wallet lock below the caller's deadline, so contention surfaces
      // as a transient failure instead of holding a connection indefinitely.
      await runInTransaction(em, `SET LOCAL lock_timeout = '${this.lockTimeoutMs}ms'`);

      return work(repositoriesFor(em, this.metrics));
    });
  }
}
