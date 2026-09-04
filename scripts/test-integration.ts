export {};

const COMPOSE_FILE = 'docker-compose.test.yml';

const TEST_ENV = {
  DATABASE_URL: 'postgres://wagering_app:wagering_app@localhost:55432/wagering',
  DATABASE_MIGRATION_URL: 'postgres://wagering_migrator:wagering_migrator@localhost:55432/wagering',
  TEST_DATABASE_URL: 'postgres://wagering_app:wagering_app@localhost:55432/wagering',
  TEST_DATABASE_MIGRATION_URL:
    'postgres://wagering_migrator:wagering_migrator@localhost:55432/wagering',
  AWS_REGION: 'us-east-1',
  AWS_ENDPOINT_URL: 'http://localhost:54566',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
} as const;

async function run(command: string[], label: string): Promise<void> {
  console.log(`\n▸ ${label}`);
  const proc = Bun.spawn(command, {
    stdio: ['inherit', 'inherit', 'inherit'],
    env: { ...process.env, ...TEST_ENV },
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`falhou: ${label} (exit ${code})`);
    process.exit(code);
  }
}

await run(['docker', 'compose', '-f', COMPOSE_FILE, 'up', '-d', '--wait'], 'infraestrutura de teste');

await run(['bun', 'run', 'scripts/migrate.ts', 'fresh'], 'schema recriado');

await run(['bun', 'test', 'test/integration'], 'suíte de integração');
