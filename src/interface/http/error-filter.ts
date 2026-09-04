import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Inject,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { ApplicationError, ErrorCode } from '@/application/errors';
import { DomainError } from '@/domain/domain-error';
import type { JsonLogger } from '@/infrastructure/observability/json-logger';
import { isTransientDatabaseFailure } from '@/infrastructure/persistence/postgres-errors';
import { LOGGER } from '@/infrastructure/tokens';
import { correlationIdOf } from './request-context';

const RETRY_AFTER_SECONDS = '1';

const STATUS: Readonly<Record<ErrorCode, number>> = {
  [ErrorCode.InvalidPayload]: HttpStatus.BAD_REQUEST,
  [ErrorCode.MissingIdempotencyKey]: HttpStatus.BAD_REQUEST,
  [ErrorCode.AmountNotPositive]: HttpStatus.BAD_REQUEST,
  [ErrorCode.ReferenceRequired]: HttpStatus.BAD_REQUEST,
  [ErrorCode.ReservedProviderId]: HttpStatus.BAD_REQUEST,
  [ErrorCode.IdempotencyKeyConflict]: HttpStatus.CONFLICT,
  [ErrorCode.ExternalTransactionIdReused]: HttpStatus.CONFLICT,
  [ErrorCode.WalletAlreadyExists]: HttpStatus.CONFLICT,
  [ErrorCode.ResourceNotFound]: HttpStatus.NOT_FOUND,
  [ErrorCode.ServiceUnavailable]: HttpStatus.SERVICE_UNAVAILABLE,
  [ErrorCode.InternalError]: HttpStatus.INTERNAL_SERVER_ERROR,
};

// A domain error at the boundary means the payload was never valid. A business
// rule rejection is a persisted REJECTED result, never an exception.
@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: JsonLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const correlationId = correlationIdOf(
      response.getHeader('X-Correlation-Id') ?? request.header('x-correlation-id'),
    );
    response.setHeader('X-Correlation-Id', correlationId);

    const { status, code, message, details } = describe(exception);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.write('error', 'http request failed', {
        correlationId,
        method: request.method,
        path: request.path,
        status,
        errorCode: code,
        errorType: exception instanceof Error ? exception.name : typeof exception,
      });
    }

    if (status === HttpStatus.SERVICE_UNAVAILABLE) {
      response.setHeader('Retry-After', RETRY_AFTER_SECONDS);
    }

    response.status(status).json({
      error: { code, message, ...(details ? { details } : {}), correlationId },
    });
  }
}

interface Described {
  readonly status: number;
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

function describe(exception: unknown): Described {
  if (exception instanceof ApplicationError) {
    return {
      status: STATUS[exception.code],
      code: exception.code,
      message: exception.message,
      details: exception.details,
    };
  }

  if (exception instanceof DomainError) {
    return {
      status: HttpStatus.BAD_REQUEST,
      code: ErrorCode.InvalidPayload,
      message: exception.message,
    };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    if (status < HttpStatus.INTERNAL_SERVER_ERROR) {
      const notFound = status === HttpStatus.NOT_FOUND;
      return {
        status,
        code: notFound ? ErrorCode.ResourceNotFound : ErrorCode.InvalidPayload,
        message: notFound ? 'resource not found' : 'invalid request payload',
      };
    }
  }

  if (isTransientDatabaseFailure(exception)) {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: ErrorCode.ServiceUnavailable,
      message: 'the database was temporarily unavailable; retry with the same idempotency key',
    };
  }

  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    code: ErrorCode.InternalError,
    message: 'internal error',
  };
}
