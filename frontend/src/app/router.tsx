import { createBrowserRouter, type RouteObject } from 'react-router';
import { AgentAuthCallback, AuthCallback } from '../auth/AuthProvider';
import { AccountScreen } from '../screens/account';
import { AddEvidenceScreen } from '../screens/add-evidence';
import { AgentDisputeScreen } from '../screens/agent-dispute';
import { AgentQueueScreen } from '../screens/agent-queue';
import { CardScreen } from '../screens/card';
import { DisputeDetailScreen } from '../screens/dispute-detail';
import { DisputeFormScreen } from '../screens/dispute-form';
import { DisputesScreen } from '../screens/disputes';
import { HomeScreen } from '../screens/home';
import { AgentShell } from './AgentShell';
import { AppShell } from './AppShell';
import { AgentOnly, CustomerOnly } from './areas';
import { NotFoundPage } from './pages';
import { agentRoutes } from './routes';

export type RoutePaths = {
  readonly callbackPath: string;
  // null when the back office is not configured: no agent route exists at all.
  readonly agentCallbackPath: string | null;
};

const agentArea = (agentCallbackPath: string): RouteObject[] => [
  { path: agentCallbackPath, element: <AgentAuthCallback retryPath={agentRoutes.queue()} /> },
  {
    path: agentRoutes.queue(),
    element: (
      <AgentOnly>
        <AgentShell />
      </AgentOnly>
    ),
    children: [
      { index: true, element: <AgentQueueScreen /> },
      { path: 'disputes/:transactionId', element: <AgentDisputeScreen /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export const appRoutes = ({ callbackPath, agentCallbackPath }: RoutePaths): RouteObject[] => [
  { path: callbackPath, element: <AuthCallback /> },
  ...(agentCallbackPath ? agentArea(agentCallbackPath) : []),
  {
    element: (
      <CustomerOnly>
        <AppShell />
      </CustomerOnly>
    ),
    children: [
      { index: true, element: <HomeScreen /> },
      { path: 'accounts/:accountId', element: <AccountScreen /> },
      { path: 'cards/:cardId', element: <CardScreen /> },
      { path: 'transactions/:transactionId/dispute', element: <DisputeFormScreen /> },
      { path: 'disputes', element: <DisputesScreen /> },
      { path: 'disputes/:transactionId', element: <DisputeDetailScreen /> },
      { path: 'disputes/:transactionId/evidence', element: <AddEvidenceScreen /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export const createAppRouter = (paths: RoutePaths) => createBrowserRouter(appRoutes(paths));
