import { describe, expect, test } from 'bun:test';

import {
  PublishOutboxMessageUseCase,
  type OutboxPublishOutcome,
} from '@/application/use-cases/publish-outbox-message';
import { OutboxPublisherWorker } from '@/infrastructure/messaging/outbox-publisher.worker';
import { JsonLogger, type LogFields, type LogLevel } from '@/infrastructure/observability/json-logger';

class ScriptedPublisher extends PublishOutboxMessageUseCase {
  calls = 0;

  constructor(private readonly script: ReadonlyArray<OutboxPublishOutcome | Error>) {
    super(
      {
        claim: async () => undefined,
        markPublished: async () => false,
        reschedule: async () => false,
      },
      { publish: async () => undefined },
      { now: () => new Date() },
      { publisherId: 'test', leaseMs: 1 },
      () => 0,
    );
  }

  override async run(): Promise<OutboxPublishOutcome> {
    const step = this.script[this.calls] ?? 'idle';
    this.calls += 1;
    if (step instanceof Error) {
      throw step;
    }
    return step;
  }
}

class CapturingLogger extends JsonLogger {
  readonly lines: Array<{ level: LogLevel; message: string }> = [];

  constructor() {
    super({});
  }

  override write(level: LogLevel, message: string, _fields: LogFields = {}): void {
    this.lines.push({ level, message });
  }
}

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('condição não atingida dentro do tempo');
    }
    await Bun.sleep(1);
  }
}

function workerOf(
  publisher: ScriptedPublisher,
  logger: CapturingLogger,
  overrides: { idleDelayMs?: number; enabled?: boolean } = {},
): OutboxPublisherWorker {
  return new OutboxPublisherWorker(publisher, logger, {
    enabled: overrides.enabled ?? true,
    idleDelayMs: overrides.idleDelayMs ?? 5,
    errorDelayMs: 5,
  });
}

describe('OutboxPublisherWorker', () => {
  test('drena mensagens em sequência enquanto houver o que publicar', async () => {
    const publisher = new ScriptedPublisher(['published', 'published', 'published']);
    const worker = workerOf(publisher, new CapturingLogger());

    worker.onApplicationBootstrap();
    await until(() => publisher.calls >= 3);
    await worker.onApplicationShutdown();

    expect(publisher.calls).toBeGreaterThanOrEqual(3);
  });

  test('continua o loop depois de um erro inesperado', async () => {
    const publisher = new ScriptedPublisher([new Error('conexão perdida')]);
    const logger = new CapturingLogger();
    const worker = workerOf(publisher, logger);

    worker.onApplicationBootstrap();
    await until(() => publisher.calls >= 2);
    await worker.onApplicationShutdown();

    expect(logger.lines.some((line) => line.level === 'error')).toBe(true);
  });

  test('o desligamento interrompe a espera ociosa em vez de aguardá-la', async () => {
    const publisher = new ScriptedPublisher([]);
    const worker = workerOf(publisher, new CapturingLogger(), { idleDelayMs: 30_000 });

    worker.onApplicationBootstrap();
    await until(() => publisher.calls >= 1);

    const startedAt = Date.now();
    await worker.onApplicationShutdown();

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test('não roda quando o papel não está habilitado nesta instância', async () => {
    const publisher = new ScriptedPublisher(['published']);
    const worker = workerOf(publisher, new CapturingLogger(), { enabled: false });

    worker.onApplicationBootstrap();
    await Bun.sleep(20);
    await worker.onApplicationShutdown();

    expect(publisher.calls).toBe(0);
  });
});
