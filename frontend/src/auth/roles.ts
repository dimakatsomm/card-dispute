import type { AuthUser } from './auth';

export const AGENTS_GROUP = 'agents';

// Only picks which screens to route; the API decides access from the access token (ADR-071).
export const isAgent = (user: AuthUser | null): boolean => user?.groups.includes(AGENTS_GROUP) ?? false;
