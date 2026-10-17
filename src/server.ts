import { AuthService } from './auth/authService.js';
import { ensureAuthCollections } from './auth/collections.js';
import { ConfigError, loadConfig } from './config/env.js';
import { ensureInfrastructureCollections } from './db/collections.js';
import { connectToDatabase, DatabaseConnectionError, type Database } from './db/mongo.js';
import { createApp } from './http/app.js';
import { createLogger } from './logger.js';
import { ensureMasterDataCollections } from './masterData/definitions.js';
import { MasterDataService } from './masterData/masterDataService.js';
import { RecordStore } from './records/recordStore.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\nSee .env.example for the required variables.\n`);
      process.exit(1);
    }
    throw error;
  }

  const logger = createLogger(config.logLevel);
  let database: Database;
  try {
    database = await connectToDatabase(config.mongodb, logger);
    await ensureInfrastructureCollections(database.db);
    await ensureAuthCollections(database.db);
    await ensureMasterDataCollections(database.db);
  } catch (error) {
    const message =
      error instanceof DatabaseConnectionError ? error.message : 'Database initialisation failed';
    logger.fatal({ errName: error instanceof Error ? error.name : 'UnknownError' }, message);
    process.exit(1);
  }

  const authService = new AuthService(database, config.auth);
  const masterDataService = new MasterDataService(database, new RecordStore(database));
  const app = createApp({ config, logger, database, authService, masterDataService });
  const server = app.listen(config.port, config.host, () => {
    logger.info({ host: config.host, port: config.port, env: config.nodeEnv }, 'API listening');
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      database
        .close()
        .catch(() => undefined)
        .finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main();
