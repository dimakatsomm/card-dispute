export const routes = {
  home: () => '/',
  account: (accountId: string) => `/accounts/${encodeURIComponent(accountId)}`,
  card: (cardId: string) => `/cards/${encodeURIComponent(cardId)}`,
  disputeForm: (transactionId: string) => `/transactions/${encodeURIComponent(transactionId)}/dispute`,
  disputes: () => '/disputes',
  disputeDetail: (transactionId: string) => `/disputes/${encodeURIComponent(transactionId)}`,
} as const;
