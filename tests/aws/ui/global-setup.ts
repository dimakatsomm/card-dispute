import { uiEnv } from './env.ts';
import { createLedgerIfAbsent } from './ledger.ts';

export default (): (() => void) => {
  uiEnv();
  return createLedgerIfAbsent();
};
