import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

export interface RequestContext {
  readonly correlationId: string;
  readonly requestId: string;
}

const CORRELATION_HEADER = 'x-correlation-id';
const CONTEXT_KEY = 'requestContext';
const VALID_CORRELATION = /^[\w.:-]{1,128}$/;

export function correlationIdOf(value: unknown): string {
  return typeof value === 'string' && VALID_CORRELATION.test(value) ? value : crypto.randomUUID();
}

// correlationId follows the business operation and is accepted from the provider;
// requestId identifies this delivery and becomes the causationId of the events it
// produces. They are distinct on purpose (README §12).
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const correlationId = correlationIdOf(request.header(CORRELATION_HEADER));

    response.setHeader('X-Correlation-Id', correlationId);
    response.locals[CONTEXT_KEY] = { correlationId, requestId: crypto.randomUUID() };
    next();
  }
}

export function requestContextOf(response: Response): RequestContext {
  const context = response.locals[CONTEXT_KEY] as RequestContext | undefined;
  return context ?? { correlationId: crypto.randomUUID(), requestId: crypto.randomUUID() };
}
