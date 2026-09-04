import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';

import { InfrastructureModule } from '@/infrastructure/infrastructure.module';
import { MessagingModule } from '@/infrastructure/messaging/messaging.module';
import { WorkersModule } from '@/infrastructure/workers/workers.module';
import { ErrorFilter } from '@/interface/http/error-filter';
import { HttpMetricsInterceptor } from '@/interface/http/http-metrics.interceptor';
import { HealthController } from '@/interface/http/health/health.controller';
import { HealthService } from '@/interface/http/health/health.service';
import { RequestContextMiddleware } from '@/interface/http/request-context';
import { WageringModule } from '@/interface/http/wagering.module';
import { SqsModule } from '@/interface/sqs/sqs.module';

@Module({
  imports: [InfrastructureModule, MessagingModule, WorkersModule, WageringModule, SqsModule],
  controllers: [HealthController],
  providers: [
    HealthService,
    { provide: APP_FILTER, useClass: ErrorFilter },
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
