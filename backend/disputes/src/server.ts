import { createLogger } from '@cd/shared';
import { runMigrations, startService } from './main.ts';

const log = createLogger();

const migrateCommand = async (): Promise<number> => {
  const result = await runMigrations(process.env);
  if (!result.ok) {
    log.error({ error: result.error }, 'migration failed');
    return 1;
  }
  log.info({ applied: result.value.applied }, 'migrations applied');
  return 0;
};

const serveCommand = async (): Promise<void> => {
  const service = await startService(process.env);
  const shutdown = (): void => {
    void service.close().finally(() => {
      process.exitCode = 0;
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
};

const fail = (e: unknown): number => {
  log.error({ message: e instanceof Error ? e.message : String(e) }, 'disputes crashed');
  return 1;
};

if (process.argv[2] === 'migrate') {
  process.exitCode = await migrateCommand().catch(fail);
} else {
  await serveCommand().catch((e: unknown) => {
    process.exitCode = fail(e);
  });
}
