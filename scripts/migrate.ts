import { MikroORM } from '@mikro-orm/postgresql';

import { migrationOrmConfig } from '@/infrastructure/persistence/orm.config';

type Command = 'up' | 'down' | 'fresh' | 'list';

const COMMANDS: readonly Command[] = ['up', 'down', 'fresh', 'list'];

const requested = process.argv[2] ?? 'up';
if (!COMMANDS.includes(requested as Command)) {
  console.error(`comando inválido: ${requested}. Use ${COMMANDS.join(' | ')}.`);
  process.exit(2);
}
const command = requested as Command;

// Migrations only touch PostgreSQL, so this reads the two database variables
// instead of the full application environment: requiring the SQS endpoint here
// would make `migrate:up` fail before it opened a connection.
const databaseUrl =
  nonEmpty(process.env['DATABASE_MIGRATION_URL']) ?? nonEmpty(process.env['DATABASE_URL']);

if (databaseUrl === undefined) {
  console.error('defina DATABASE_MIGRATION_URL ou DATABASE_URL para rodar as migrations.');
  process.exit(2);
}

const orm = await MikroORM.init(migrationOrmConfig(databaseUrl));
const migrator = orm.getMigrator();

try {
  switch (command) {
    case 'up': {
      const applied = await migrator.up();
      console.log(
        applied.length === 0
          ? 'nenhuma migration pendente'
          : `aplicadas: ${applied.map((m) => m.name).join(', ')}`,
      );
      break;
    }
    case 'down': {
      const reverted = await migrator.down();
      console.log(
        reverted.length === 0
          ? 'nenhuma migration para reverter'
          : `revertidas: ${reverted.map((m) => m.name).join(', ')}`,
      );
      break;
    }
    case 'fresh': {
      await migrator.down({ to: 0 });
      const applied = await migrator.up();
      console.log(`schema recriado: ${applied.map((m) => m.name).join(', ')}`);
      break;
    }
    case 'list': {
      const executed = await migrator.getExecutedMigrations();
      const pending = await migrator.getPendingMigrations();
      console.log(`aplicadas: ${executed.map((m) => m.name).join(', ') || '(nenhuma)'}`);
      console.log(`pendentes: ${pending.map((m) => m.name).join(', ') || '(nenhuma)'}`);
      break;
    }
  }
} finally {
  await orm.close(true);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' ? value : undefined;
}
