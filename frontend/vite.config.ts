import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from 'vite';

type Env = Readonly<Record<string, string>>;

const stripApi = (path: string): string => path.replace(/^\/api/, '');

const proxyTo = (target: string): ProxyOptions => ({ target, changeOrigin: true, rewrite: stripApi });

// Mirrors docker-entrypoint.sh so `vite dev` serves the same runtime /config.js the container does.
const runtimeConfigPlugin = (env: Env): Plugin => ({
  name: 'runtime-config',
  configureServer: (server) => {
    server.middlewares.use('/config.js', (_req, res) => {
      const config = {
        apiBase: env['API_BASE'] ?? '/api',
        oidcIssuer: env['OIDC_ISSUER'] ?? '',
        oidcClientId: env['OIDC_CLIENT_ID'] ?? '',
        oidcRedirectUri: env['OIDC_REDIRECT_URI'] ?? 'http://localhost:5173/auth/callback',
        oidcLogoutUrl: env['OIDC_LOGOUT_URL'] ?? '',
        oidcPostLogoutUri: env['OIDC_POST_LOGOUT_URI'] ?? 'http://localhost:5173/',
      };
      res.setHeader('Content-Type', 'text/javascript');
      res.setHeader('Cache-Control', 'no-store');
      res.end(`window.__APP_CONFIG__ = ${JSON.stringify(config)};`);
    });
  },
});

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const fallback = 'http://localhost:8080';
  return {
    plugins: [react(), runtimeConfigPlugin(env)],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api/me': proxyTo(env['DEV_USERS_URL'] ?? fallback),
        '/api/transactions': proxyTo(env['DEV_TRANSACTIONS_URL'] ?? fallback),
        '^/api/disputes?(/|$|\\?)': proxyTo(env['DEV_DISPUTES_URL'] ?? fallback),
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
    },
  };
});
