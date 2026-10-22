import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { missingEnv } from '../src/env.ts';

export default async (): Promise<() => void> => {
  const missing = missingEnv();
  if (missing.length > 0) throw new Error(`e2e-aws: unset environment variables: ${missing.join(', ')}`);

  const expected = process.env['AWS_ACCOUNT_ID'] ?? '';
  const identity = await new STSClient({ region: process.env['AWS_REGION'] ?? '' }).send(
    new GetCallerIdentityCommand({}),
  );
  if (identity.Account !== expected)
    throw new Error('e2e-aws: credentials belong to a different account than AWS_ACCOUNT_ID');

  const dir = mkdtempSync(join(tmpdir(), 'e2e-aws-'));
  const ledger = join(dir, 'transactions');
  writeFileSync(ledger, '');
  process.env['E2E_AWS_LEDGER'] = ledger;
  return () => rmSync(dir, { recursive: true, force: true });
};
