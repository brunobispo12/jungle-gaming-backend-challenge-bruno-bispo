export const APP_ROLES = ['api', 'consumer', 'pending-worker', 'outbox-publisher'] as const;

export type AppRole = (typeof APP_ROLES)[number];

export interface AwsEnv {
  readonly region: string;
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface QueueEnv {
  readonly input: string;
  readonly dlq: string;
  readonly events: string;
}

export interface AppEnv {
  readonly nodeEnv: string;
  readonly instanceId: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly databaseMigrationUrl: string;
  readonly roles: readonly AppRole[];
  readonly aws: AwsEnv;
  readonly queues: QueueEnv;
}

function read(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value !== undefined && value !== '') {
    return value;
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(`variável de ambiente obrigatória ausente: ${name}`);
}

function readPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} inválida: ${raw}`);
  }
  return parsed;
}

function readRoles(): readonly AppRole[] {
  const raw = read('APP_ROLES', APP_ROLES.join(','));
  const parsed = raw
    .split(',')
    .map((role) => role.trim())
    .filter((role) => role.length > 0);

  const unknown = parsed.filter((role): boolean => !APP_ROLES.includes(role as AppRole));
  if (unknown.length > 0) {
    throw new Error(`APP_ROLES desconhecido: ${unknown.join(', ')}`);
  }
  if (parsed.length === 0) {
    throw new Error('APP_ROLES não pode ser vazio');
  }
  return parsed as AppRole[];
}

export function loadEnv(): AppEnv {
  return {
    nodeEnv: read('NODE_ENV', 'development'),
    instanceId: read('INSTANCE_ID', 'local'),
    port: readPort('PORT', 3000),
    databaseUrl: read('DATABASE_URL'),
    databaseMigrationUrl: read('DATABASE_MIGRATION_URL', read('DATABASE_URL')),
    roles: readRoles(),
    aws: {
      region: read('AWS_REGION', 'us-east-1'),
      endpoint: read('AWS_ENDPOINT_URL'),
      accessKeyId: read('AWS_ACCESS_KEY_ID', 'test'),
      secretAccessKey: read('AWS_SECRET_ACCESS_KEY', 'test'),
    },
    queues: {
      input: read('SQS_INPUT_QUEUE', 'wager-transactions.fifo'),
      dlq: read('SQS_DLQ_QUEUE', 'wager-transactions-dlq.fifo'),
      events: read('SQS_EVENTS_QUEUE', 'wager-events.fifo'),
    },
  };
}
