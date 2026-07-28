import { useCallback, useEffect, useState } from 'react';
import { loadConfig, type AppConfig } from './api';
import { currentToken } from './auth';
import { Admin } from './views/Admin';
import { Share } from './views/Share';
import { SignIn } from './views/SignIn';

/** Share links are the only client-side route: /s/<token>. */
const shareToken = () => {
  const match = /^\/s\/([\w-]+)\/?$/.exec(window.location.pathname);
  return match?.[1];
};

export function App() {
  const [config, setConfig] = useState<AppConfig>();
  const [token, setToken] = useState<string | null>();
  const [failed, setFailed] = useState(false);

  const token$ = shareToken();

  useEffect(() => {
    // Guarded because both settles land after an await: a token$ change swaps the
    // effect mid-flight and the stale run must not overwrite the new one's state.
    let live = true;
    loadConfig()
      .then(async (loaded) => {
        // A share viewer never needs Cognito, so don't make them wait on it.
        const next = token$ ? null : await currentToken(loaded);
        if (live) {
          setConfig(loaded);
          setToken(next);
        }
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [token$]);

  /**
   * What every admin request resolves its bearer from. Stable per config, so
   * `Admin`'s effects can key on it. Cognito refreshes the access token silently
   * for 30 days; when even that runs out this returns null, and dropping `token`
   * puts the sign-in form up instead of a page of 401 lines.
   */
  const getToken = useCallback(async () => {
    if (!config) return null;
    const next = await currentToken(config);
    if (!next) setToken(null);
    return next;
  }, [config]);

  if (token$) return <Share token={token$} />;

  if (failed) {
    return (
      <div className="shell">
        <h1>Not configured</h1>
        <p className="note">
          The app could not read its configuration. If this is a fresh deployment,
          the stack may still be finishing.
        </p>
      </div>
    );
  }

  if (!config || token === undefined) {
    return (
      <div className="empty">
        <p className="note">Loading…</p>
      </div>
    );
  }

  if (!token) {
    return (
      <SignIn
        config={config}
        onSignedIn={() => currentToken(config).then(setToken)}
      />
    );
  }

  return <Admin config={config} getToken={getToken} />;
}
