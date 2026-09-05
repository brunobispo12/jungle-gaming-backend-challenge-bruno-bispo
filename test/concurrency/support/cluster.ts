import type { Subprocess } from 'bun';

const READY_TIMEOUT_MS = 60_000;
const BASE_PORT = 3101;

const INFRA = {
  DATABASE_URL: 'postgres://wagering_app:wagering_app@localhost:55432/wagering',
  DATABASE_MIGRATION_URL: 'postgres://wagering_migrator:wagering_migrator@localhost:55432/wagering',
  AWS_REGION: 'us-east-1',
  AWS_ENDPOINT_URL: 'http://localhost:54566',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  NODE_ENV: 'test',
  // Pinned, not inherited: the roles decide whether the consumer and the workers
  // exist at all, and the scenarios must not depend on the developer's shell.
  APP_ROLES: 'api,consumer,pending-worker,outbox-publisher',
} as const;

export interface Cluster {
  readonly instances: readonly string[];
  /** Round-robins so consecutive requests land on different processes. */
  next(): string;
  stop(index: number): Promise<void>;
  start(index: number): Promise<void>;
  shutdown(): Promise<void>;
}

interface Node {
  readonly url: string;
  readonly port: number;
  readonly id: string;
  process?: Subprocess | undefined;
}

async function waitUntilReady(url: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health/ready`);
      if (response.ok) {
        return;
      }
    } catch {
      // The process is still binding its port.
    }
    await Bun.sleep(200);
  }

  throw new Error(`instance at ${url} never became ready`);
}

function spawn(node: Node): Subprocess {
  return Bun.spawn(['bun', 'run', 'src/bootstrap/main.ts'], {
    env: { ...process.env, ...INFRA, PORT: String(node.port), INSTANCE_ID: node.id },
    stdout: 'ignore',
    stderr: 'ignore',
  });
}

export async function startCluster(size = 3): Promise<Cluster> {
  const nodes: Node[] = Array.from({ length: size }, (_unused, index) => ({
    url: `http://localhost:${BASE_PORT + index}`,
    port: BASE_PORT + index,
    id: `concurrency-${index + 1}`,
  }));

  for (const node of nodes) {
    node.process = spawn(node);
  }
  await Promise.all(nodes.map((node) => waitUntilReady(node.url)));

  let cursor = 0;

  return {
    instances: nodes.map((node) => node.url),
    next: () => {
      const node = nodes[cursor % nodes.length];
      cursor += 1;
      return node?.url ?? nodes[0]!.url;
    },
    stop: async (index) => {
      const node = nodes[index];
      if (!node?.process) {
        return;
      }
      node.process.kill('SIGKILL');
      await node.process.exited;
      node.process = undefined;
    },
    start: async (index) => {
      const node = nodes[index];
      if (!node || node.process) {
        return;
      }
      node.process = spawn(node);
      await waitUntilReady(node.url);
    },
    shutdown: async () => {
      for (const node of nodes) {
        node.process?.kill('SIGKILL');
      }
      await Promise.all(nodes.map((node) => node.process?.exited));
    },
  };
}
