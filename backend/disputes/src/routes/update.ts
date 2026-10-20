import type { RouteOptions } from 'fastify';
import { notImplemented } from '../errors.ts';

// Placeholder until P-02.
export const updateDisputeRoute = (): RouteOptions => ({
  method: 'PUT',
  url: '/dispute/:transactionId',
  handler: notImplemented,
});
