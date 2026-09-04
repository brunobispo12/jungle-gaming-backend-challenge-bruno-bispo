import { describe, expect, test } from 'bun:test';

import type { UnitOfWork } from '@/application/ports';
import {
  ResolvePendingReferenceUseCase,
  type PendingReferenceOutcome,
} from '@/application/use-cases/resolve-pending-reference';
import type { SubmitWagerTransactionUseCase } from '@/application/use-cases/submit-wager-transaction';
import { JsonLogger, type LogFields, type LogLevel } from '@/infrastructure/observability/json-logger';
import { PendingReferenceWorker } from '@/infrastructure/workers/pending-reference.worker';

const SETTLED: PendingReferenceOutcome = {
  kind: 'settled',
  transactionId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  status: 'PROCESSED',
};

class ScriptedResolver extends ResolvePendingReferenceUseCase {
  calls = 0;

  constructor(private readonly script: readonly PendingReferenceOutcome[]) {
    super(
      {} as UnitOfWork,
      {} as SubmitWagerTransactionUseCase,
      { next: () => 'id' },
      { now: () => new Date() },
      () => 0,
      () => false,
    );
  }

  override async run(): Promise<PendingReferenceOutcome> {
    const step = this.script[this.calls] ?? { kind: 'idle' };
    this.calls += 1;
    return step;
  }
}

class SilentLogger extends JsonLogger {
  constructor() {
    super({});
  }

  override write(_level: LogLevel, _message: string, _fields: LogFields = {}): void {}
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

describe('PendingReferenceWorker', () => {
  test('resolve pendências em sequência enquanto houver o que fazer', async () => {
    const resolver = new ScriptedResolver([SETTLED, SETTLED, SETTLED]);
    const worker = new PendingReferenceWorker(resolver, new SilentLogger(), {
      enabled: true,
      tickDelayMs: 5,
      errorDelayMs: 5,
    });

    worker.onApplicationBootstrap();
    await until(() => resolver.calls >= 3);
    await worker.onApplicationShutdown();

    expect(resolver.calls).toBeGreaterThanOrEqual(3);
  });

  test('não roda quando o papel não está habilitado nesta instância', async () => {
    const resolver = new ScriptedResolver([SETTLED]);
    const worker = new PendingReferenceWorker(resolver, new SilentLogger(), {
      enabled: false,
      tickDelayMs: 5,
      errorDelayMs: 5,
    });

    worker.onApplicationBootstrap();
    await Bun.sleep(20);
    await worker.onApplicationShutdown();

    expect(resolver.calls).toBe(0);
  });
});
