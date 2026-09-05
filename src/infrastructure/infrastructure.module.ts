import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';

import { loadEnv, type AppEnv } from '@/bootstrap/env';
import { JsonLogger } from './observability/json-logger';
import { PostgresSqsOperationalMetrics } from './observability/operational-metrics';
import { OperationalMetricsCollector } from './observability/operational-metrics.collector';
import { PrometheusMetrics } from './observability/prometheus-metrics';
import { runtimeOrmConfig } from './persistence/orm.config';
import { APP_ENV, LOGGER, METRICS, ORM, SQS_CLIENT } from './tokens';

@Global()
@Module({
  providers: [
    {
      provide: APP_ENV,
      useFactory: (): AppEnv => loadEnv(),
    },
    {
      provide: LOGGER,
      inject: [APP_ENV],
      useFactory: (env: AppEnv): JsonLogger =>
        new JsonLogger({ instanceId: env.instanceId, roles: env.roles }),
    },
    {
      provide: ORM,
      inject: [APP_ENV],
      useFactory: (env: AppEnv): Promise<MikroORM> =>
        MikroORM.init(runtimeOrmConfig(env.databaseUrl)),
    },
    {
      provide: SQS_CLIENT,
      inject: [APP_ENV],
      useFactory: (env: AppEnv): SQSClient =>
        new SQSClient({
          region: env.aws.region,
          endpoint: env.aws.endpoint,
          credentials: {
            accessKeyId: env.aws.accessKeyId,
            secretAccessKey: env.aws.secretAccessKey,
          },
        }),
    },
    {
      provide: METRICS,
      useFactory: (): PrometheusMetrics => new PrometheusMetrics(),
    },
    {
      provide: OperationalMetricsCollector,
      inject: [ORM, SQS_CLIENT, APP_ENV, METRICS, LOGGER],
      useFactory: (
        orm: MikroORM,
        sqs: SQSClient,
        env: AppEnv,
        metrics: PrometheusMetrics,
        logger: JsonLogger,
      ): OperationalMetricsCollector =>
        new OperationalMetricsCollector(
          new PostgresSqsOperationalMetrics(orm, sqs, env.queues.dlq),
          metrics,
          logger.child({ worker: 'operational-metrics' }),
        ),
    },
  ],
  exports: [APP_ENV, LOGGER, METRICS, ORM, SQS_CLIENT],
})
export class InfrastructureModule implements OnApplicationShutdown {
  constructor(
    @Inject(ORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
    this.sqs.destroy();
  }
}
