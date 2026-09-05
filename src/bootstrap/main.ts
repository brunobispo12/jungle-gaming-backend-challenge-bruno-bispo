import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { JsonLogger } from '@/infrastructure/observability/json-logger';
import { AppModule } from './app.module';
import { loadEnv } from './env';

const env = loadEnv();
const logger = new JsonLogger({ instanceId: env.instanceId, roles: env.roles });

const app = await NestFactory.create(AppModule, { logger, bufferLogs: false });

app.enableShutdownHooks();

// Every role opens the port, because health and metrics have to be reachable on
// a consumer or a publisher too. Only the api role serves the business routes.
await app.listen(env.port, '0.0.0.0');

logger.write('info', 'application started', { port: env.port, nodeEnv: env.nodeEnv });
