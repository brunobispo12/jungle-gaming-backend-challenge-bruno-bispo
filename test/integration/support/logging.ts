import { JsonLogger, type LogFields, type LogLevel } from '@/infrastructure/observability/json-logger';

class SilentLogger extends JsonLogger {
  override write(_level: LogLevel, _message: string, _fields: LogFields = {}): void {}

  override child(): SilentLogger {
    return this;
  }
}

export function silentLogger(): JsonLogger {
  return new SilentLogger({});
}
