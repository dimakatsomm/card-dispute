import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { ApiClient } from '../api/client';
import { Button, Loading, cardClass, cx, pageGutterClass } from '../components/ui';
import type { Auth, AuthUser } from './auth';

export const SessionPage = ({ children }: { readonly children: ReactNode }) => (
  <div className={cx(pageGutterClass, 'py-8 sm:py-10')}>{children}</div>
);

const AuthContext = createContext<Auth | null>(null);

export const AuthProvider = ({ auth, children }: { readonly auth: Auth; readonly children: ReactNode }) => (
  <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>
);

export const useAuth = (): Auth => {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error('useAuth must be used inside <AuthProvider>');
  return auth;
};

export type AgentArea = { readonly auth: Auth; readonly api: ApiClient };

const AgentAreaContext = createContext<AgentArea | null>(null);

export const AgentAreaProvider = ({
  agent,
  children,
}: {
  readonly agent: AgentArea | null;
  readonly children: ReactNode;
}) => <AgentAreaContext.Provider value={agent}>{children}</AgentAreaContext.Provider>;

export const useAgentArea = (): AgentArea | null => useContext(AgentAreaContext);

export type Session =
  | { readonly status: 'checking' }
  | { readonly status: 'signed-in'; readonly user: AuthUser }
  | { readonly status: 'signed-out' };

// `recheck` re-reads the session on navigation so an expired one is renewed or dropped.
export const useSession = (auth: Auth | null, recheck: string): Session => {
  const [session, setSession] = useState<Session>(auth ? { status: 'checking' } : { status: 'signed-out' });

  useEffect(() => {
    if (!auth) return undefined;
    let active = true;
    const apply = (user: AuthUser | null): void => {
      if (active) setSession(user ? { status: 'signed-in', user } : { status: 'signed-out' });
    };
    const unsubscribe = auth.onChange(apply);
    void auth.currentUser().then(apply);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [auth, recheck]);

  return session;
};

export const useReturnTo = (): string => {
  const location = useLocation();
  return `${location.pathname}${location.search}`;
};

export const RequireAuth = ({ children }: { readonly children: ReactNode }) => {
  const auth = useAuth();
  const returnTo = useReturnTo();
  const session = useSession(auth, returnTo);

  useEffect(() => {
    if (session.status === 'signed-out') void auth.signIn(returnTo);
  }, [auth, returnTo, session.status]);

  switch (session.status) {
    case 'signed-in':
      return <>{children}</>;
    case 'checking':
      return (
        <SessionPage>
          <Loading>Checking your session…</Loading>
        </SessionPage>
      );
    case 'signed-out':
      return (
        <SessionPage>
          <Loading>Redirecting to sign in…</Loading>
        </SessionPage>
      );
  }
};

type CallbackState = { readonly status: 'pending' } | { readonly status: 'failed' };

const SignInCallback = ({ auth, retryPath }: { readonly auth: Auth; readonly retryPath: string }) => {
  const navigate = useNavigate();
  const [state, setState] = useState<CallbackState>({ status: 'pending' });
  // The authorization code is single-use; StrictMode's double effect must not redeem it twice.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void auth.completeSignIn(window.location.href).then((result) => {
      if (result.ok) {
        void navigate(result.value, { replace: true });
        return;
      }
      // Don't leave the (failed) code and state in the address bar or history.
      window.history.replaceState(null, '', window.location.pathname);
      setState({ status: 'failed' });
    });
  }, [auth, navigate]);

  return (
    <SessionPage>
      {state.status === 'pending' ? (
        <Loading>Signing you in…</Loading>
      ) : (
        <div role="alert" className={cx(cardClass, 'mx-auto max-w-md space-y-4 p-6')}>
          <p className="font-medium">We couldn't sign you in.</p>
          <Button onClick={() => void auth.signIn(retryPath)}>Try again</Button>
        </div>
      )}
    </SessionPage>
  );
};

export const AuthCallback = () => <SignInCallback auth={useAuth()} retryPath="/" />;

export const AgentAuthCallback = ({ retryPath }: { readonly retryPath: string }) => {
  const agent = useAgentArea();
  return agent ? <SignInCallback auth={agent.auth} retryPath={retryPath} /> : null;
};
