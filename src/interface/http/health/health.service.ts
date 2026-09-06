import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Inject, Injectable } from '@nestjs/common';

import type { AppEnv } from '@/bootstrap/env';
import { APP_ENV, ORM, SQS_CLIENT } from '@/infrastructure/tokens';

// No error text: README §9 keeps this endpoint unauthenticated, and a driver
// message names the role and the host it failed to reach.
export interface DependencyCheck {
  readonly status: 'up' | 'down';
  readonly latencyMs: number;
}

export interface ReadinessReport {
  readonly status: 'ok' | 'degraded';
  readonly checks: {
    readonly postgres: DependencyCheck;
    readonly sqs: DependencyCheck;
  };
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(ORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  liveness(): { status: 'ok'; instanceId: string; uptimeSeconds: number } {
    return {
      status: 'ok',
      instanceId: this.env.instanceId,
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }

  async readiness(): Promise<ReadinessReport> {
    const [postgres, sqs] = await Promise.all([this.checkPostgres(), this.checkSqs()]);

    return {
      status: postgres.status === 'up' && sqs.status === 'up' ? 'ok' : 'degraded',
      checks: { postgres, sqs },
    };
  }

  private async checkPostgres(): Promise<DependencyCheck> {
    return timed(async () => {
      await this.orm.em.getConnection('read').execute('select 1');
    });
  }

  private async checkSqs(): Promise<DependencyCheck> {
    return timed(async () => {
      await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.env.queues.input }));
    });
  }
}

async function timed(probe: () => Promise<void>): Promise<DependencyCheck> {
  const startedAt = performance.now();
  try {
    await probe();
    return { status: 'up', latencyMs: Math.round(performance.now() - startedAt) };
  } catch {
    return { status: 'down', latencyMs: Math.round(performance.now() - startedAt) };
  }
}
