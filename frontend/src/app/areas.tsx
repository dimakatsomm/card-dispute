import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { ApiProvider } from '../api/ApiProvider';
import {
  RequireAuth,
  SessionPage,
  useAgentArea,
  useAuth,
  useReturnTo,
  useSession,
  type Session,
} from '../auth/AuthProvider';
import { isAgent } from '../auth/roles';
import { Button, Loading, cardClass, cx, mutedClass } from '../components/ui';
import { NotFoundPage } from './pages';
import { agentRoutes } from './routes';

const Checking = () => (
  <SessionPage>
    <Loading>Checking your session…</Loading>
  </SessionPage>
);

const isChecking = (session: Session): boolean => session.status === 'checking';

// Routing only: an agent session never sees customer screens. The API still checks every token.
export const CustomerOnly = ({ children }: { readonly children: ReactNode }) => {
  const agent = useAgentArea();
  const agentSession = useSession(agent?.auth ?? null, useReturnTo());
  if (isChecking(agentSession)) return <Checking />;
  if (agentSession.status === 'signed-in' && isAgent(agentSession.user)) {
    return <Navigate to={agentRoutes.queue()} replace />;
  }
  return <RequireAuth>{children}</RequireAuth>;
};

const AgentSignIn = ({ onSignIn }: { readonly onSignIn: () => void }) => (
  <SessionPage>
    <section aria-labelledby="agent-sign-in-heading" className={cx(cardClass, 'mx-auto max-w-md space-y-4 p-6')}>
      <h1 id="agent-sign-in-heading" className="text-xl font-semibold tracking-tight text-ink">
        Back office
      </h1>
      <p className={mutedClass}>Sign in with your agent account to review disputes.</p>
      <Button onClick={onSignIn}>Agent sign-in</Button>
    </section>
  </SessionPage>
);

const NotAnAgent = ({ onSignOut }: { readonly onSignOut: () => void }) => (
  <SessionPage>
    <section role="alert" className={cx(cardClass, 'mx-auto max-w-md space-y-4 p-6')}>
      <p className="font-medium">This account is not a back-office agent.</p>
      <Button variant="secondary" onClick={onSignOut}>
        Sign out
      </Button>
    </section>
  </SessionPage>
);

// Agent screens talk to the API with the agent's own token, never the customer's.
export const AgentOnly = ({ children }: { readonly children: ReactNode }) => {
  const agent = useAgentArea();
  const returnTo = useReturnTo();
  const customerSession = useSession(useAuth(), returnTo);
  const agentSession = useSession(agent?.auth ?? null, returnTo);

  if (!agent || customerSession.status === 'signed-in') {
    return (
      <SessionPage>
        <NotFoundPage />
      </SessionPage>
    );
  }
  if (isChecking(customerSession) || isChecking(agentSession)) return <Checking />;
  if (agentSession.status === 'signed-out') return <AgentSignIn onSignIn={() => void agent.auth.signIn(returnTo)} />;
  if (agentSession.status === 'signed-in' && !isAgent(agentSession.user)) {
    return <NotAnAgent onSignOut={() => void agent.auth.signOut()} />;
  }
  return <ApiProvider client={agent.api}>{children}</ApiProvider>;
};
