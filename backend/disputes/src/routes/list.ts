import type { RouteOptions } from 'fastify';
import { notImplemented } from '../errors.ts';

// Placeholder until P-03.
export const listDisputesRoute = (): RouteOptions => ({
  method: 'GET',
  url: '/disputes',
  handler: notImplemented,
});
