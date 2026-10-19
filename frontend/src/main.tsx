import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createApiClient } from './api/client';
import { App, ConfigErrorScreen } from './app/App';
import { createAuth } from './auth/auth';
import { loadConfig } from './config';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Missing #root element');
const root = createRoot(rootElement);
const config = loadConfig(window);

if (!config.ok) {
  root.render(<ConfigErrorScreen />);
} else {
  const auth = createAuth(
    {
      issuer: config.value.oidcIssuer,
      clientId: config.value.oidcClientId,
      redirectUri: config.value.oidcRedirectUri,
      logoutUrl: config.value.oidcLogoutUrl,
      postLogoutUri: config.value.oidcPostLogoutUri,
    },
    { redirectStateStorage: window.sessionStorage, navigate: (url) => window.location.assign(url) },
  );
  const api = createApiClient({
    apiBase: config.value.apiBase,
    origin: window.location.origin,
    getAccessToken: auth.getAccessToken,
  });
  root.render(
    <StrictMode>
      <App auth={auth} api={api} callbackPath={new URL(config.value.oidcRedirectUri).pathname} />
    </StrictMode>,
  );
}
