import { PostgreSqlContainer } from '@testcontainers/postgresql';

export type TestPostgres = {
  readonly connectionString: string;
  readonly stop: () => Promise<void>;
};

export const startTestPostgres = async (): Promise<TestPostgres> => {
  const container = await new PostgreSqlContainer('postgres:18').start();
  return {
    connectionString: container.getConnectionUri(),
    stop: async () => {
      await container.stop();
    },
  };
};
