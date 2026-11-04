import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';

type Grants = Readonly<Record<string, ReadonlyArray<string>>>;

const COGNITO_GRANTS_URL = new URL('../../../infra/terraform/modules/cognito/grants.json', import.meta.url);

const normalise = (grants: Grants): Grants =>
  Object.fromEntries(
    Object.entries(grants)
      .map(([client, scopes]) => [client, [...new Set(scopes)].sort()] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );

const mockGrants = (): Grants =>
  normalise(
    Object.fromEntries(
      loadConfig({
        MOCK_ISSUER_CLIENT_SECRET: 'test-secret',
        MOCK_ISSUER_SPA_REDIRECT_URIS: 'http://localhost:5173/',
      })
        .clients.filter((c) => c.secret !== null)
        .map((c) => [c.clientId, c.allowedScopes]),
    ),
  );

const cognitoGrants = (): Grants => normalise(JSON.parse(readFileSync(COGNITO_GRANTS_URL, 'utf8')) as Grants);

const describeDifferences = (aws: Grants, mock: Grants): string[] =>
  [...new Set([...Object.keys(aws), ...Object.keys(mock)])].sort().flatMap((client) => {
    const a = aws[client];
    const m = mock[client];
    if (!a) return [`${client}: only in mock issuer (${m?.join(', ')})`];
    if (!m) return [`${client}: only in Cognito grants.json (${a.join(', ')})`];
    const onlyAws = a.filter((s) => !m.includes(s));
    const onlyMock = m.filter((s) => !a.includes(s));
    if (!onlyAws.length && !onlyMock.length) return [];
    return [`${client}: only in Cognito [${onlyAws.join(', ')}], only in mock [${onlyMock.join(', ')}]`];
  });

describe('service client scope grants', () => {
  it('Cognito grants.json equals the mock issuer SERVICE_GRANTS exactly', () => {
    expect(describeDifferences(cognitoGrants(), mockGrants())).toEqual([]);
  });
});
