import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createApiClient } from './api/client';
import { App, ConfigErrorScreen } from './app/App';
import { createAuth, type AuthDeps, type AuthSettings } from './auth/auth';
import { loadConfig, type AppConfig } from './config';
import './styles.css';

const AGENT_STATE_KEY_PREFIX = 'oidc-agent.';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Missing #root element');
const root = createRoot(rootElement);
const config = loadConfig(window);

const authDeps: AuthDeps = {
  redirectStateStorage: window.sessionStorage,
  navigate: (url) => window.location.assign(url),
};

const sharedSettings = (value: AppConfig): Omit<AuthSettings, 'clientId' | 'redirectUri'> => ({
  issuer: value.oidcIssuer,
  logoutUrl: value.oidcLogoutUrl,
  postLogoutUri: value.oidcPostLogoutUri,
});

const apiFor = (value: AppConfig, getAccessToken: () => Promise<string | null>) =>
  createApiClient({ apiBase: value.apiBase, origin: window.location.origin, getAccessToken });

const agentArea = (value: AppConfig) => {
  if (!value.agentSignIn) return null;
  const auth = createAuth(
    {
      ...sharedSettings(value),
      clientId: value.agentSignIn.clientId,
      redirectUri: value.agentSignIn.redirectUri,
      stateKeyPrefix: AGENT_STATE_KEY_PREFIX,
    },
    authDeps,
  );
  return {
    auth,
    api: apiFor(value, auth.getAccessToken),
    callbackPath: new URL(value.agentSignIn.redirectUri).pathname,
  };
};

if (!config.ok) {
  root.render(<ConfigErrorScreen />);
} else {
  const auth = createAuth(
    { ...sharedSettings(config.value), clientId: config.value.oidcClientId, redirectUri: config.value.oidcRedirectUri },
    authDeps,
  );
  root.render(
    <StrictMode>
      <App
        auth={auth}
        api={apiFor(config.value, auth.getAccessToken)}
        callbackPath={new URL(config.value.oidcRedirectUri).pathname}
        agent={agentArea(config.value)}
      />
    </StrictMode>,
  );
}
