import { createBrowserRouter } from 'react-router';
import { AuthCallback, RequireAuth } from '../auth/AuthProvider';
import { AccountScreen } from '../screens/account';
import { AddEvidenceScreen } from '../screens/add-evidence';
import { CardScreen } from '../screens/card';
import { DisputeDetailScreen } from '../screens/dispute-detail';
import { DisputeFormScreen } from '../screens/dispute-form';
import { DisputesScreen } from '../screens/disputes';
import { HomeScreen } from '../screens/home';
import { AppShell } from './AppShell';
import { NotFoundPage } from './pages';

export const createAppRouter = (callbackPath: string) =>
  createBrowserRouter([
    { path: callbackPath, element: <AuthCallback /> },
    {
      element: (
        <RequireAuth>
          <AppShell />
        </RequireAuth>
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
  ]);
