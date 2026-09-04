import { MikroORM } from '@mikro-orm/postgresql';

import { loadEnv } from '@/bootstrap/env';
import { migrationOrmConfig } from '@/infrastructure/persistence/orm.config';

type Command = 'up' | 'down' | 'fresh' | 'list';

const COMMANDS: readonly Command[] = ['up', 'down', 'fresh', 'list'];

const requested = process.argv[2] ?? 'up';
if (!COMMANDS.includes(requested as Command)) {
  console.error(`comando inválido: ${requested}. Use ${COMMANDS.join(' | ')}.`);
  process.exit(2);
}
const command = requested as Command;

const env = loadEnv();
const orm = await MikroORM.init(migrationOrmConfig(env.databaseMigrationUrl));
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
