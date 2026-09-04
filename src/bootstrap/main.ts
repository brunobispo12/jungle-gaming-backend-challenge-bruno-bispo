import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { JsonLogger } from '@/infrastructure/observability/json-logger';
import { AppModule } from './app.module';
import { loadEnv } from './env';

const env = loadEnv();
const logger = new JsonLogger({ instanceId: env.instanceId, roles: env.roles });

const app = await NestFactory.create(AppModule, { logger, bufferLogs: false });

app.enableShutdownHooks();

// Every role shares one binary; only the api role opens a port, the workers just
// need the container wired up and their lifecycle hooks fired.
if (env.roles.includes('api')) {
  await app.listen(env.port, '0.0.0.0');
  logger.write('info', 'application started', { port: env.port, nodeEnv: env.nodeEnv });
} else {
  await app.init();
  logger.write('info', 'application started', { nodeEnv: env.nodeEnv });
}
