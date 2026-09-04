import type { JsonLogger } from '@/infrastructure/observability/json-logger';

export interface PollingLoopOptions {
  readonly enabled: boolean;
  readonly idleDelayMs: number;
  readonly errorDelayMs: number;
}

// A step returns whether it did work: the loop drains at full speed while there
// is work and only pays the idle delay once the queue runs dry.
export class PollingLoop {
  private running = false;
  private drained: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly name: string,
    private readonly step: () => Promise<boolean>,
    private readonly logger: JsonLogger,
    private readonly options: PollingLoopOptions,
  ) {}

  start(): void {
    if (!this.options.enabled || this.running) {
      return;
    }
    this.running = true;
    this.drained = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.drained;
    this.drained = undefined;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        if (!(await this.step())) {
          await this.idle(this.options.idleDelayMs);
        }
      } catch (error: unknown) {
        this.logger.write('error', `${this.name} tick failed`, {
          errorType: error instanceof Error ? error.name : typeof error,
        });
        await this.idle(this.options.errorDelayMs);
      }
    }
  }

  // Resolves early on shutdown so SIGTERM does not wait out a full idle window.
  // The guard closes the window where stop() fires between the step and the
  // sleep: there is no await between it and the assignment of wake.
  private async idle(delayMs: number): Promise<void> {
    if (!this.running) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      this.wake = (): void => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.wake = undefined;
  }
}
