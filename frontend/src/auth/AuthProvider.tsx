import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Button, Loading, cardClass, cx, pageGutterClass } from '../components/ui';
import type { Auth, AuthUser } from './auth';

const SessionPage = ({ children }: { readonly children: ReactNode }) => (
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

type SessionState =
  | { readonly status: 'checking' }
  | { readonly status: 'signed-in'; readonly user: AuthUser }
  | { readonly status: 'redirecting' };

export const RequireAuth = ({ children }: { readonly children: ReactNode }) => {
  const auth = useAuth();
  const location = useLocation();
  const [session, setSession] = useState<SessionState>({ status: 'checking' });
  const returnTo = `${location.pathname}${location.search}`;

  useEffect(() => {
    const apply = (user: AuthUser | null): void => {
      if (user) {
        setSession({ status: 'signed-in', user });
        return;
      }
      setSession({ status: 'redirecting' });
      void auth.signIn(returnTo);
    };
    const unsubscribe = auth.onChange(apply);
    void auth.currentUser().then(apply);
    return unsubscribe;
  }, [auth, returnTo]);

  switch (session.status) {
    case 'signed-in':
      return <>{children}</>;
    case 'checking':
      return (
        <SessionPage>
          <Loading>Checking your session…</Loading>
        </SessionPage>
      );
    case 'redirecting':
      return (
        <SessionPage>
          <Loading>Redirecting to sign in…</Loading>
        </SessionPage>
      );
  }
};

type CallbackState = { readonly status: 'pending' } | { readonly status: 'failed' };

export const AuthCallback = () => {
  const auth = useAuth();
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
          <Button onClick={() => void auth.signIn('/')}>Try again</Button>
        </div>
      )}
    </SessionPage>
  );
};
