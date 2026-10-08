import { buildApp } from './app';
import { dbPath, loadConfig } from './config';
import { closeDb, openDb } from './db/connection';

const config = loadConfig();
const db = openDb(dbPath(config));
const app = await buildApp({ db, config });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.close().finally(() => {
      closeDb(db);
      process.exit(0);
    });
  });
}

await app.listen({ host: config.host, port: config.port });
