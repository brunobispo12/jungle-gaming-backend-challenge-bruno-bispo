import { MikroORM } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';

import type { Clock, IdGenerator, MetricsPort, UnitOfWork } from '@/application/ports';
import { CreateWalletUseCase } from '@/application/use-cases/create-wallet';
import { ReconcileWalletUseCase } from '@/application/use-cases/reconcile-wallet';
import { SubmitWagerTransactionUseCase } from '@/application/use-cases/submit-wager-transaction';
import { SystemClock, UuidV7Generator } from '@/infrastructure/adapters';
import { MikroUnitOfWork } from '@/infrastructure/persistence/unit-of-work';
import { TrustedProviderIdentityAdapter } from '@/infrastructure/security/trusted-provider-identity';
import {
  APP_ENV,
  CLOCK,
  ID_GENERATOR,
  METRICS,
  ORM,
  PROVIDER_IDENTITY,
  UNIT_OF_WORK,
} from '@/infrastructure/tokens';
import type { AppEnv } from '@/bootstrap/env';
import { ApiRoleGuard } from './api-role.guard';
import { MetricsController } from './metrics.controller';
import { WageringController } from './wagering.controller';

@Module({
  controllers: [MetricsController, WageringController],
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
    { provide: PROVIDER_IDENTITY, useClass: TrustedProviderIdentityAdapter },
    ApiRoleGuard,
    {
      provide: UNIT_OF_WORK,
      inject: [ORM, METRICS, APP_ENV],
      useFactory: (orm: MikroORM, metrics: MetricsPort, env: AppEnv): UnitOfWork =>
        new MikroUnitOfWork(orm, env.walletLockTimeoutMs, metrics),
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
