import { Module } from '@nestjs/common';

import { InfrastructureModule } from '@/infrastructure/infrastructure.module';
import { HealthController } from '@/interface/http/health/health.controller';
import { HealthService } from '@/interface/http/health/health.service';

@Module({
  imports: [InfrastructureModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class AppModule {}
