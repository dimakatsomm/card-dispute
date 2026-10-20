import type { RouteOptions } from 'fastify';
import { notImplemented } from '../errors.ts';

// Placeholder until P-03.
export const getDisputeRoute = (): RouteOptions => ({
  method: 'GET',
  url: '/dispute/:transactionId',
  handler: notImplemented,
});
