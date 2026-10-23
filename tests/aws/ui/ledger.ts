import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Same cap and file format as the API suite's ledger (src/http.ts).
const MAX_TRANSACTIONS_PER_RUN = 3;

export const createLedgerIfAbsent = (): (() => void) => {
  const existing = process.env['E2E_AWS_LEDGER'];
  if (existing !== undefined && existing !== '' && existsSync(existing)) return () => undefined;
  const dir = mkdtempSync(join(tmpdir(), 'e2e-aws-ui-'));
  const ledger = join(dir, 'transactions');
  writeFileSync(ledger, '');
  process.env['E2E_AWS_LEDGER'] = ledger;
  return () => rmSync(dir, { recursive: true, force: true });
};

export const claimSlot = (): void => {
  const ledger = process.env['E2E_AWS_LEDGER'];
  if (ledger === undefined || ledger === '')
    throw new Error('e2e-aws-ui: transaction ledger missing (global setup did not run)');
  appendFileSync(ledger, 'x\n');
  if (readFileSync(ledger, 'utf8').length / 2 > MAX_TRANSACTIONS_PER_RUN)
    throw new Error('e2e-aws-ui: transaction budget for this run is spent');
};
