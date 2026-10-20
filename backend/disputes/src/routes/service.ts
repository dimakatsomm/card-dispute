import type { ServiceRoute } from '@cd/auth-client';
import { notImplemented } from '../errors.ts';

// Placeholder until P-03.
export const serviceRoutes = (): ReadonlyArray<ServiceRoute> => [
  { method: 'GET', url: '/disputes', scope: 'disputes/read', handler: notImplemented },
];
