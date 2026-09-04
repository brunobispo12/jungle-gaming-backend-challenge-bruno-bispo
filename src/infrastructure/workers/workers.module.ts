import { Module } from '@nestjs/common';

import type { Clock, IdGenerator, MetricsPort, UnitOfWork } from '@/application/ports';
import { ResolvePendingReferenceUseCase } from '@/application/use-cases/resolve-pending-reference';
import { SubmitWagerTransactionUseCase } from '@/application/use-cases/submit-wager-transaction';
import type { AppEnv } from '@/bootstrap/env';
import type { JsonLogger } from '@/infrastructure/observability/json-logger';
import { isTransientDatabaseFailure } from '@/infrastructure/persistence/postgres-errors';
import { APP_ENV, CLOCK, ID_GENERATOR, LOGGER, METRICS, UNIT_OF_WORK } from '@/infrastructure/tokens';
import { WageringModule } from '@/interface/http/wagering.module';
import { PendingReferenceWorker } from './pending-reference.worker';

const TICK_DELAY_MS = 5_000;
const ERROR_DELAY_MS = 5_000;

@Module({
  imports: [WageringModule],
  providers: [
    {
      provide: ResolvePendingReferenceUseCase,
      inject: [UNIT_OF_WORK, SubmitWagerTransactionUseCase, ID_GENERATOR, CLOCK, METRICS],
      useFactory: (
        unitOfWork: UnitOfWork,
        submitWager: SubmitWagerTransactionUseCase,
        ids: IdGenerator,
        clock: Clock,
        metrics: MetricsPort,
      ): ResolvePendingReferenceUseCase =>
        new ResolvePendingReferenceUseCase(
          unitOfWork,
          submitWager,
          ids,
          clock,
          Math.random,
          isTransientDatabaseFailure,
          metrics,
        ),
    },
    {
      provide: PendingReferenceWorker,
      inject: [ResolvePendingReferenceUseCase, LOGGER, APP_ENV],
      useFactory: (
        resolve: ResolvePendingReferenceUseCase,
        logger: JsonLogger,
        env: AppEnv,
      ): PendingReferenceWorker =>
        new PendingReferenceWorker(resolve, logger.child({ worker: 'pending-reference' }), {
          enabled: env.roles.includes('pending-worker'),
          tickDelayMs: TICK_DELAY_MS,
          errorDelayMs: ERROR_DELAY_MS,
        }),
    },
  ],
})
export class WorkersModule {}
