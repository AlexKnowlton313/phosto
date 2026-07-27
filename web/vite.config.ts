import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const CONFIG = resolve(__dirname, 'public/config.json');

/** Only present locally — CDK writes the real one into the bucket at deploy. */
const deployedDomain = (): string | undefined =>
  existsSync(CONFIG)
    ? (JSON.parse(readFileSync(CONFIG, 'utf8')) as { domain: string }).domain
    : undefined;

export default defineConfig({
  plugins: [react()],
  define: {
    // amazon-cognito-identity-js reaches for the Node `global` in its SRP code.
    // Without this the bundle builds cleanly and then throws "global is not
    // defined" on first import, so the failure only shows up at runtime.
    global: 'globalThis',
  },
  build: {
    // Hashed asset names let the default CloudFront behavior cache aggressively
    // while index.html stays the only file that needs invalidating.
    assetsDir: 'assets',
    sourcemap: true,
  },
  server: {
    port: 5173,
    // The admin UI calls /api and loads /f/* with relative paths, and the image
    // cookies are pinned to `Domain=<site>`. Proxying keeps dev same-origin and
    // rewrites the cookie domain to localhost, which is the only way those
    // cookies survive the hop. Cognito talks to AWS directly and isn't proxied.
    proxy: Object.fromEntries(
      (deployedDomain() ? ['/api', '/f'] : []).map((path) => [
        path,
        {
          target: `https://${deployedDomain()}`,
          changeOrigin: true,
          cookieDomainRewrite: '',
        },
      ]),
    ),
  },
});
