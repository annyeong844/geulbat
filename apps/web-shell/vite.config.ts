import { fileURLToPath } from 'node:url';

import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const DEV_AUTH_COOKIE_NAME = 'geulbat_dev_auth';
const DEV_AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 6;

function createDevAuthCookie(devToken: string): string {
  return [
    `${DEV_AUTH_COOKIE_NAME}=${encodeURIComponent(devToken)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    `Max-Age=${DEV_AUTH_COOKIE_MAX_AGE_SECONDS}`,
  ].join('; ');
}

function appendSetCookieHeader(
  existing: string | string[] | number | undefined,
  value: string,
): string[] {
  const next = Array.isArray(existing)
    ? existing.slice()
    : existing === undefined
      ? []
      : [String(existing)];
  if (!next.includes(value)) {
    next.push(value);
  }
  return next;
}

export default defineConfig(({ mode }) => {
  const appRoot = fileURLToPath(new URL('.', import.meta.url));
  const env = loadEnv(mode, appRoot, 'VITE_');
  const devToken =
    process.env.VITE_GEULBAT_DEV_TOKEN ??
    env.VITE_GEULBAT_DEV_TOKEN ??
    process.env.GEULBAT_DEV_TOKEN ??
    '';

  return {
    plugins: [
      react(),
      {
        name: 'geulbat-dev-auth-cookie',
        configureServer(server) {
          if (!devToken) {
            return;
          }
          const cookie = createDevAuthCookie(devToken);
          server.middlewares.use((_req, res, next) => {
            res.setHeader(
              'Set-Cookie',
              appendSetCookieHeader(res.getHeader('Set-Cookie'), cookie),
            );
            next();
          });
        },
      },
    ],
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:3456',
          changeOrigin: true,
          ws: true,
        },
      },
    },
  };
});
