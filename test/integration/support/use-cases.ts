import { MikroORM } from '@mikro-orm/postgresql';

import type { Clock, IdGenerator } from '@/application/ports';
import { ConsumeWagerMessageUseCase } from '@/application/use-cases/consume-wager-message';
import { CreateWalletUseCase } from '@/application/use-cases/create-wallet';
import { ReconcileWalletUseCase } from '@/application/use-cases/reconcile-wallet';
import { ResolvePendingReferenceUseCase } from '@/application/use-cases/resolve-pending-reference';
import { SubmitWagerTransactionUseCase } from '@/application/use-cases/submit-wager-transaction';
import { UuidV7Generator } from '@/infrastructure/adapters';
import { runtimeOrmConfig } from '@/infrastructure/persistence/orm.config';
import { isTransientDatabaseFailure } from '@/infrastructure/persistence/postgres-errors';
import { MikroUnitOfWork } from '@/infrastructure/persistence/unit-of-work';
import { MIGRATOR_URL } from './database';

export class FixedClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return this.current;
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

export interface UseCases {
  readonly orm: MikroORM;
  readonly unitOfWork: MikroUnitOfWork;
  readonly createWallet: CreateWalletUseCase;
  readonly submitWager: SubmitWagerTransactionUseCase;
  readonly consumeWagerMessage: ConsumeWagerMessageUseCase;
  readonly resolvePendingReference: ResolvePendingReferenceUseCase;
  readonly reconcileWallet: ReconcileWalletUseCase;
  readonly clock: FixedClock;
  readonly ids: IdGenerator;
  close(): Promise<void>;
}

export async function bootUseCases(at = new Date('2026-07-29T15:00:00.000Z')): Promise<UseCases> {
  const orm = await MikroORM.init(runtimeOrmConfig(MIGRATOR_URL));
  const unitOfWork = new MikroUnitOfWork(orm, 20_000);
  const ids = new UuidV7Generator();
  const clock = new FixedClock(at);
  const submitWager = new SubmitWagerTransactionUseCase(unitOfWork, ids, clock);

  return {
    orm,
    unitOfWork,
    clock,
    ids,
    submitWager,
    createWallet: new CreateWalletUseCase(unitOfWork, ids, clock),
    consumeWagerMessage: new ConsumeWagerMessageUseCase(
      unitOfWork,
      submitWager,
      clock,
      isTransientDatabaseFailure,
    ),
    resolvePendingReference: new ResolvePendingReferenceUseCase(
      unitOfWork,
      submitWager,
      ids,
      clock,
      Math.random,
      isTransientDatabaseFailure,
    ),
    reconcileWallet: new ReconcileWalletUseCase(unitOfWork),
    close: () => orm.close(true),
  };
}
