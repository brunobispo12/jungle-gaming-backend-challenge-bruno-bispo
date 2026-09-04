import { MikroORM } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';

import type { Clock, IdGenerator, MetricsPort, UnitOfWork } from '@/application/ports';
import { CreateWalletUseCase } from '@/application/use-cases/create-wallet';
import { ReconcileWalletUseCase } from '@/application/use-cases/reconcile-wallet';
import { SubmitWagerTransactionUseCase } from '@/application/use-cases/submit-wager-transaction';
import { SystemClock, UuidV7Generator } from '@/infrastructure/adapters';
import { MikroUnitOfWork } from '@/infrastructure/persistence/unit-of-work';
import { CLOCK, ID_GENERATOR, METRICS, ORM, UNIT_OF_WORK } from '@/infrastructure/tokens';
import { MetricsController } from './metrics.controller';
import { WageringController } from './wagering.controller';

// Kept below the 60 s SQS visibility timeout so a contended wallet fails as a
// transient error with room left to finish the message.
const LOCK_TIMEOUT_MS = 20_000;

@Module({
  controllers: [MetricsController, WageringController],
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
    {
      provide: UNIT_OF_WORK,
      inject: [ORM, METRICS],
      useFactory: (orm: MikroORM, metrics: MetricsPort): UnitOfWork =>
        new MikroUnitOfWork(orm, LOCK_TIMEOUT_MS, metrics),
    },
    {
      provide: CreateWalletUseCase,
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK],
      useFactory: (unitOfWork: UnitOfWork, ids: IdGenerator, clock: Clock): CreateWalletUseCase =>
        new CreateWalletUseCase(unitOfWork, ids, clock),
    },
    {
      provide: ReconcileWalletUseCase,
      inject: [UNIT_OF_WORK, METRICS],
      useFactory: (unitOfWork: UnitOfWork, metrics: MetricsPort): ReconcileWalletUseCase =>
        new ReconcileWalletUseCase(unitOfWork, metrics),
    },
    {
      provide: SubmitWagerTransactionUseCase,
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK, METRICS],
      useFactory: (
        unitOfWork: UnitOfWork,
        ids: IdGenerator,
        clock: Clock,
        metrics: MetricsPort,
      ): SubmitWagerTransactionUseCase =>
        new SubmitWagerTransactionUseCase(unitOfWork, ids, clock, metrics),
    },
  ],
  exports: [UNIT_OF_WORK, CLOCK, ID_GENERATOR, SubmitWagerTransactionUseCase],
})
export class WageringModule {}
