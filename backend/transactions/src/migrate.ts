import { fileURLToPath } from 'node:url';
import { migrate } from '@cd/db';
import { createLogger } from '@cd/shared';

const log = createLogger();

const run = async (): Promise<number> => {
  const connectionString = process.env.MIGRATOR_DATABASE_URL;
  if (!connectionString) {
    log.error({ missing: ['MIGRATOR_DATABASE_URL'] }, 'migrate: missing environment variables');
    return 1;
  }
  const result = await migrate({
    schema: 'transactions',
    dir: fileURLToPath(new URL('../migrations', import.meta.url)),
    connectionString,
  });
  if (!result.ok) {
    log.error({ error: result.error }, 'migrate failed');
    return 1;
  }
  log.info({ applied: result.value.applied }, 'migrate complete');
  return 0;
};

process.exitCode = await run().catch((e: unknown) => {
  log.error({ message: e instanceof Error ? e.message : String(e) }, 'migrate crashed');
  return 1;
});
