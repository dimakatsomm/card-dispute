import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { Auth, AuthUser } from './auth';

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
      return <p role="status">Checking your session…</p>;
    case 'redirecting':
      return <p role="status">Redirecting to sign in…</p>;
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

  return state.status === 'pending' ? (
    <p role="status">Signing you in…</p>
  ) : (
    <div role="alert">
      <p>We couldn't sign you in.</p>
      <button type="button" onClick={() => void auth.signIn('/')}>
        Try again
      </button>
    </div>
  );
};
