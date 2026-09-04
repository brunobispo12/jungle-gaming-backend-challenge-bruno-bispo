import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';

import { HealthService, type ReadinessReport } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  live(): { status: 'ok'; instanceId: string; uptimeSeconds: number } {
    return this.health.liveness();
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessReport> {
    const report = await this.health.readiness();
    res.status(report.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }
}
