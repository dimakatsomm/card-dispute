import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig(process.env);
const app = buildApp(config, { now: () => new Date() });

await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`mock-issuer listening on :${config.port} as ${config.issuer} (test hooks: ${config.testHooks})`);
