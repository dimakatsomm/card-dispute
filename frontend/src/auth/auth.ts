import { InMemoryWebStorage, UserManager, WebStorageStateStore, type User } from 'oidc-client-ts';
import { err, ok, type Result } from '../app/result';

export type AuthSettings = {
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly logoutUrl: string;
  readonly postLogoutUri: string;
};

export type AuthDeps = {
  // Holds only the short-lived PKCE verifier/state across the IdP redirect; tokens never go here.
  readonly redirectStateStorage: Storage;
  readonly navigate: (url: string) => void;
};

export type AuthUser = { readonly subject: string };

export type SignInError = 'SIGNIN_FAILED';

export type Auth = {
  readonly signIn: (returnTo: string) => Promise<void>;
  readonly completeSignIn: (callbackUrl: string) => Promise<Result<string, SignInError>>;
  readonly signOut: () => Promise<void>;
  readonly getAccessToken: () => Promise<string | null>;
  readonly currentUser: () => Promise<AuthUser | null>;
  readonly onChange: (listener: (user: AuthUser | null) => void) => () => void;
};

const toAuthUser = (user: User | null): AuthUser | null =>
  user && !user.expired ? { subject: user.profile.sub } : null;

// Only a same-origin path may come back from the redirect state, so it can't become an open redirect.
const SAME_ORIGIN_PATH = /^\/(?![/\\])[^\\]*$/;

export const safeReturnTo = (value: unknown): string =>
  typeof value === 'object' &&
  value !== null &&
  'returnTo' in value &&
  typeof value.returnTo === 'string' &&
  SAME_ORIGIN_PATH.test(value.returnTo)
    ? value.returnTo
    : '/';

// Cognito's /logout is not advertised in discovery (no end_session_endpoint), so it is configured explicitly.
export const logoutUrl = (settings: AuthSettings): string => {
  const url = new URL(settings.logoutUrl);
  url.searchParams.set('client_id', settings.clientId);
  url.searchParams.set('logout_uri', settings.postLogoutUri);
  return url.toString();
};

export const createAuth = (settings: AuthSettings, deps: AuthDeps): Auth => {
  const manager = new UserManager({
    authority: settings.issuer,
    client_id: settings.clientId,
    redirect_uri: settings.redirectUri,
    response_type: 'code',
    scope: 'openid',
    loadUserInfo: false,
    monitorSession: false,
    automaticSilentRenew: true,
    userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
    stateStore: new WebStorageStateStore({ store: deps.redirectStateStorage }),
  });

  // Once signing out starts, nothing may start a new sign-in: the IdP session cookie would log the user straight back in.
  let signingOut = false;
  let renewing: Promise<User | null> | null = null;

  const renew = (): Promise<User | null> => {
    renewing ??= manager
      .signinSilent()
      .catch(() => null)
      .finally(() => {
        renewing = null;
      });
    return renewing;
  };

  const validUser = async (): Promise<User | null> => {
    if (signingOut) return null;
    const user = await manager.getUser();
    if (!user) return null;
    return user.expired ? renew() : user;
  };

  return {
    signIn: async (returnTo) => {
      if (signingOut) return;
      await manager.signinRedirect({ state: { returnTo } });
    },
    completeSignIn: async (callbackUrl) => {
      try {
        const user = await manager.signinRedirectCallback(callbackUrl);
        return ok(safeReturnTo(user.state));
      } catch {
        return err('SIGNIN_FAILED');
      }
    },
    signOut: async () => {
      signingOut = true;
      manager.stopSilentRenew();
      await manager.removeUser();
      deps.navigate(logoutUrl(settings));
    },
    getAccessToken: async () => (await validUser())?.access_token ?? null,
    currentUser: async () => toAuthUser(await validUser()),
    onChange: (listener) => {
      const loaded = (user: User): void => listener(toAuthUser(user));
      const unloaded = (): void => {
        if (!signingOut) listener(null);
      };
      manager.events.addUserLoaded(loaded);
      manager.events.addUserUnloaded(unloaded);
      return () => {
        manager.events.removeUserLoaded(loaded);
        manager.events.removeUserUnloaded(unloaded);
      };
    },
  };
};
