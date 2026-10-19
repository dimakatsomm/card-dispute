import { fileURLToPath } from 'node:url';
import { migrate } from '@cd/db';
import { createLogger, loadConfig } from '@cd/shared';
import { migrateConfigSchema } from './config.ts';

const config = loadConfig(migrateConfigSchema);
const log = createLogger({ level: config.LOG_LEVEL });

const run = async (): Promise<number> => {
  const result = await migrate({
    connectionString: config.MIGRATOR_DATABASE_URL,
    schema: 'users',
    dir: fileURLToPath(new URL('../migrations', import.meta.url)),
  });
  if (!result.ok) {
    log.error({ error: result.error }, 'users migration failed');
    return 1;
  }
  log.info({ applied: result.value.applied }, 'users migration complete');
  return 0;
};

process.exitCode = await run().catch((e: unknown) => {
  log.error({ message: e instanceof Error ? e.message : String(e) }, 'users migration crashed');
  return 1;
});
