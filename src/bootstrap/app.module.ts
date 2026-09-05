import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { InfrastructureModule } from '@/infrastructure/infrastructure.module';
import { MessagingModule } from '@/infrastructure/messaging/messaging.module';
import { WorkersModule } from '@/infrastructure/workers/workers.module';
import { ErrorFilter } from '@/interface/http/error-filter';
import { HttpMetricsMiddleware } from '@/interface/http/http-metrics.middleware';
import { HealthController } from '@/interface/http/health/health.controller';
import { HealthService } from '@/interface/http/health/health.service';
import { RequestContextMiddleware } from '@/interface/http/request-context';
import { WageringModule } from '@/interface/http/wagering.module';
import { SqsModule } from '@/interface/sqs/sqs.module';

@Module({
  // Shutdown hooks fire in module registration order, and InfrastructureModule
  // closes the ORM and the SQS client. It goes last so the workers still have
  // both while they finish in flight work and return message visibility (§10).
  imports: [MessagingModule, WorkersModule, WageringModule, SqsModule, InfrastructureModule],
  controllers: [HealthController],
  providers: [HealthService, { provide: APP_FILTER, useClass: ErrorFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware, HttpMetricsMiddleware).forRoutes('*');
  }
}
