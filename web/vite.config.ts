import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const FIXTURE = resolve(__dirname, 'public/__preview/share.json');
const CONFIG = resolve(__dirname, 'public/config.json');

/** Only present locally — CDK writes the real one into the bucket at deploy. */
const deployedDomain = (): string | undefined =>
  existsSync(CONFIG)
    ? (JSON.parse(readFileSync(CONFIG, 'utf8')) as { domain: string }).domain
    : undefined;

/**
 * Serves a share payload from a local fixture so the gallery can be worked on
 * without a deployed stack. Inert unless public/__preview/share.json exists, and
 * dev-only either way — generate the fixture with scripts/make-preview.mjs.
 */
const previewFixture = (): Plugin => ({
  name: 'phosto-preview-fixture',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (!existsSync(FIXTURE)) return next();

      if (req.url?.startsWith('/api/share/')) {
        res.setHeader('content-type', 'application/json');
        res.end(readFileSync(FIXTURE, 'utf8'));
        return;
      }
      next();
    });
  },
});

export default defineConfig({
  plugins: [react(), previewFixture()],
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
