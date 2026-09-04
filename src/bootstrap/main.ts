import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { JsonLogger } from '@/infrastructure/observability/json-logger';
import { AppModule } from './app.module';
import { loadEnv } from './env';

const env = loadEnv();
const logger = new JsonLogger({ instanceId: env.instanceId, roles: env.roles });

const app = await NestFactory.create(AppModule, { logger, bufferLogs: false });

app.enableShutdownHooks();

await app.listen(env.port, '0.0.0.0');

logger.write('info', 'aplicação iniciada', { port: env.port, nodeEnv: env.nodeEnv });
