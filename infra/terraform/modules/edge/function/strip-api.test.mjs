import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Evaluated as a plain script because cloudfront-js-2.0 has no module system.
const source = readFileSync(new URL('./strip-api.js', import.meta.url), 'utf8');
const { handler, stripApi } = vm.runInNewContext(`${source}\n;({ handler, stripApi })`);

const run = (uri) => handler({ request: { uri, querystring: {}, headers: {} } }).uri;

test('strips the /api prefix', () => {
  assert.equal(run('/api/me'), '/me');
  assert.equal(run('/api/dispute/abc/evidence'), '/dispute/abc/evidence');
  assert.equal(run('/api/'), '/');
});

test('keeps the query part intact', () => {
  assert.equal(stripApi('/api/disputes?x'), '/disputes?x');
});

test('leaves non-/api paths alone', () => {
  assert.equal(run('/'), '/');
  assert.equal(run('/callback'), '/callback');
  assert.equal(run('/apidocs'), '/apidocs');
  assert.equal(run('/assets/api/x.js'), '/assets/api/x.js');
});
