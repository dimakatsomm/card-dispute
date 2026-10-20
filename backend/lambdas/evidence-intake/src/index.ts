import { createLogger, loadConfig } from '@cd/shared/lambda';
import { configSchema } from './config.ts';
import { awsRuntime, compose } from './main.ts';

const config = loadConfig(configSchema);
const log = createLogger({ level: config.LOG_LEVEL });

export const handler = await compose(config, awsRuntime(config, log));
