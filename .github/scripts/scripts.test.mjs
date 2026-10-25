import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { rewriteTaskDefinition } from './rewrite-taskdef.mjs';
import { evaluateTasks } from './task-result.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const IMAGE = '111111111111.dkr.ecr.eu-north-1.amazonaws.com/cd-svc-users:0123456789abcdef0123456789abcdef01234567';

test('image swap changes only the matching container image', () => {
  const source = fixture('taskdef-service.json');
  const result = rewriteTaskDefinition(source, IMAGE);
  assert.equal(result.ok, true);
  const [main, sidecar] = result.value.containerDefinitions;
  assert.equal(main.image, IMAGE);
  assert.deepEqual({ ...main, image: 'x' }, { ...source.taskDefinition.containerDefinitions[0], image: 'x' });
  assert.deepEqual(sidecar, source.taskDefinition.containerDefinitions[1]);
});

test('output keeps registerable fields and drops read-only ones', () => {
  const source = fixture('taskdef-service.json').taskDefinition;
  const { value } = rewriteTaskDefinition({ taskDefinition: source }, IMAGE);
  for (const k of ['family', 'taskRoleArn', 'executionRoleArn', 'networkMode', 'cpu', 'memory', 'volumes', 'runtimePlatform', 'requiresCompatibilities']) {
    assert.deepEqual(value[k], source[k], k);
  }
  for (const k of ['taskDefinitionArn', 'revision', 'status', 'registeredAt', 'registeredBy', 'compatibilities', 'requiresAttributes']) {
    assert.equal(k in value, false, k);
  }
});

test('migrate task definition keeps its command', () => {
  const { value } = rewriteTaskDefinition(fixture('taskdef-migrate.json'), IMAGE);
  assert.deepEqual(value.containerDefinitions[0].command, ['node', 'migrate.js']);
  assert.equal(value.containerDefinitions[0].image, IMAGE);
});

test('rewrite fails when no container uses the repository', () => {
  const other = '1.dkr.ecr.eu-north-1.amazonaws.com/cd-svc-auth:abc';
  assert.equal(rewriteTaskDefinition(fixture('taskdef-service.json'), other).ok, false);
});

test('rewrite fails on malformed input', () => {
  assert.equal(rewriteTaskDefinition({}, IMAGE).ok, false);
});

test('migrate result: exit 0 passes, non-zero and never-started fail', () => {
  assert.equal(evaluateTasks(fixture('tasks-ok.json')).ok, true);
  assert.equal(evaluateTasks(fixture('tasks-failed.json')).ok, false);
  assert.equal(evaluateTasks(fixture('tasks-never-started.json')).ok, false);
  assert.equal(evaluateTasks(fixture('tasks-no-containers.json')).ok, false);
  assert.equal(evaluateTasks({ tasks: [{}], failures: [] }).ok, false);
  assert.equal(evaluateTasks({ tasks: [], failures: [] }).ok, false);
  assert.equal(evaluateTasks({ tasks: [], failures: [{ reason: 'MISSING' }] }).ok, false);
});
