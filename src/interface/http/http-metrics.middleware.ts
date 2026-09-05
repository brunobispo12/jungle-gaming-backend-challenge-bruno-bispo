import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import type { MetricsPort } from '@/application/ports';
import { METRICS } from '@/infrastructure/tokens';

// Middleware and not an interceptor: guards and the exception filter answer
// before any interceptor runs, and those responses count too (README §12).
@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(@Inject(METRICS) private readonly metrics: MetricsPort) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const startedAt = performance.now();

    response.once('finish', () => {
      this.metrics.observeHttp(
        request.method,
        matchedRoute(request),
        response.statusCode,
        (performance.now() - startedAt) / 1_000,
      );
    });

    next();
  }
}

function matchedRoute(request: Request): string {
  const route = request.route as { path?: unknown } | undefined;
  return typeof route?.path === 'string' ? route.path : 'unmatched';
}
