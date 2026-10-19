import { createBrowserRouter } from 'react-router';
import { AuthCallback, RequireAuth } from '../auth/AuthProvider';
import { AppShell } from './AppShell';
import {
  AccountPage,
  CardPage,
  DisputeDetailPage,
  DisputeFormPage,
  DisputesListPage,
  HomePage,
  NotFoundPage,
} from './pages';

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
        { index: true, element: <HomePage /> },
        { path: 'accounts/:accountId', element: <AccountPage /> },
        { path: 'cards/:cardId', element: <CardPage /> },
        { path: 'transactions/:transactionId/dispute', element: <DisputeFormPage /> },
        { path: 'disputes', element: <DisputesListPage /> },
        { path: 'disputes/:transactionId', element: <DisputeDetailPage /> },
        { path: '*', element: <NotFoundPage /> },
      ],
    },
  ]);
