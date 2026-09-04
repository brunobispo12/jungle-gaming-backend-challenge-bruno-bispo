import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, type Options } from '@mikro-orm/postgresql';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

function baseConfig(clientUrl: string): Options {
  return defineConfig({
    clientUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    debug: false,
    forceUtcTimezone: true,
  });
}

export function runtimeOrmConfig(clientUrl: string): Options {
  return baseConfig(clientUrl);
}

export function migrationOrmConfig(clientUrl: string): Options {
  return {
    ...baseConfig(clientUrl),
    extensions: [Migrator],
    migrations: {
      tableName: 'mikro_orm_migrations',
      path: MIGRATIONS_DIR,
      pathTs: MIGRATIONS_DIR,
      glob: '!(*.d).{js,ts}',
      transactional: true,
      allOrNothing: true,
      // Default do MikroORM é true, o que rodaria a migration com
      // session_replication_role=replica e desligaria nossos triggers.
      disableForeignKeys: false,
      snapshot: false,
      emit: 'ts',
    },
  };
}
