import type { LoggerService } from '@nestjs/common';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  readonly [key: string]: unknown;
}

// Nunca logar amount, balance, payload financeiro completo ou credencial (README §12).
export class JsonLogger implements LoggerService {
  constructor(private readonly base: LogFields) {}

  write(level: LogLevel, message: string, fields: LogFields = {}): void {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...this.base,
      ...fields,
    });

    if (level === 'error' || level === 'warn') {
      process.stderr.write(`${line}\n`);
      return;
    }
    process.stdout.write(`${line}\n`);
  }

  child(fields: LogFields): JsonLogger {
    return new JsonLogger({ ...this.base, ...fields });
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('info', String(message), contextOf(optionalParams));
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', String(message), contextOf(optionalParams));
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', String(message), contextOf(optionalParams));
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', String(message), contextOf(optionalParams));
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', String(message), contextOf(optionalParams));
  }
}

function contextOf(optionalParams: readonly unknown[]): LogFields {
  const last = optionalParams.at(-1);
  return typeof last === 'string' ? { context: last } : {};
}
