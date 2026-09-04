import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';

import type { MetricsExporter } from '@/application/ports';
import { METRICS } from '@/infrastructure/tokens';

@Controller()
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: MetricsExporter) {}

  @Get('metrics')
  async getMetrics(@Res({ passthrough: true }) response: Response): Promise<string> {
    response.setHeader('Content-Type', this.metrics.contentType);
    return this.metrics.exposition();
  }
}
