export const routes = {
  home: () => '/',
  account: (accountId: string) => `/accounts/${encodeURIComponent(accountId)}`,
  card: (cardId: string) => `/cards/${encodeURIComponent(cardId)}`,
  disputeForm: (transactionId: string) => `/transactions/${encodeURIComponent(transactionId)}/dispute`,
  disputes: () => '/disputes',
  disputeDetail: (transactionId: string) => `/disputes/${encodeURIComponent(transactionId)}`,
  addEvidence: (transactionId: string) => `/disputes/${encodeURIComponent(transactionId)}/evidence`,
} as const;

export const agentRoutes = {
  queue: () => '/agent',
  dispute: (transactionId: string) => `/agent/disputes/${encodeURIComponent(transactionId)}`,
} as const;
