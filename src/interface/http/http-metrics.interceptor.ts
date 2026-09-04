import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';

import type { MetricsPort } from '@/application/ports';
import { METRICS } from '@/infrastructure/tokens';

@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(@Inject(METRICS) private readonly metrics: MetricsPort) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const startedAt = performance.now();

    response.once('finish', () => {
      this.metrics.observeHttp(
        request.method,
        matchedRoute(request),
        response.statusCode,
        (performance.now() - startedAt) / 1_000,
      );
    });

    return next.handle();
  }
}

function matchedRoute(request: Request): string {
  const route = request.route as { path?: unknown } | undefined;
  return typeof route?.path === 'string' ? route.path : 'unmatched';
}
