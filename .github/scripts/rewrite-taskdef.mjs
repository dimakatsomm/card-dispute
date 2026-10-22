import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Fields RegisterTaskDefinition accepts; everything else in a describe output is read-only.
const REGISTERABLE = [
  'family',
  'taskRoleArn',
  'executionRoleArn',
  'networkMode',
  'containerDefinitions',
  'volumes',
  'placementConstraints',
  'requiresCompatibilities',
  'cpu',
  'memory',
  'pidMode',
  'ipcMode',
  'proxyConfiguration',
  'inferenceAccelerators',
  'ephemeralStorage',
  'runtimePlatform',
  'enableFaultInjection',
];

const repositoryOf = (image) => image.replace(/@.*$/, '').replace(/:[^:/]*$/, '');

export const rewriteTaskDefinition = (described, image) => {
  const def = described?.taskDefinition ?? described;
  if (!def || !Array.isArray(def.containerDefinitions)) {
    return { ok: false, error: 'input has no containerDefinitions' };
  }
  const repository = repositoryOf(image);
  let swapped = 0;
  const containerDefinitions = def.containerDefinitions.map((c) => {
    if (repositoryOf(c.image) !== repository) return c;
    swapped += 1;
    return { ...c, image };
  });
  if (swapped === 0) {
    return { ok: false, error: `no container uses repository ${repository}` };
  }
  const value = Object.fromEntries(
    REGISTERABLE.filter((k) => def[k] !== undefined).map((k) => [k, def[k]]),
  );
  return { ok: true, value: { ...value, containerDefinitions } };
};

const main = () => {
  const [file, image] = process.argv.slice(2);
  if (!file || !image) {
    console.error('usage: rewrite-taskdef.mjs <describe-task-definition.json> <image>');
    process.exit(2);
  }
  const result = rewriteTaskDefinition(JSON.parse(readFileSync(file, 'utf8')), image);
  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(result.value));
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
