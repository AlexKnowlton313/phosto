import { useState } from 'react';
import type { CognitoUser } from 'amazon-cognito-identity-js';
import type { AppConfig } from '../api';
import { completeNewPassword, NewPasswordRequired, signIn } from '../auth';

export function SignIn({
  config,
  onSignedIn,
}: {
  config: AppConfig;
  onSignedIn: () => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [challenge, setChallenge] = useState<CognitoUser>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);

    try {
      if (challenge) {
        await completeNewPassword(challenge, newPassword);
      } else {
        await signIn(config, email, password);
      }
      onSignedIn();
    } catch (err) {
      if (err instanceof NewPasswordRequired) {
        setChallenge(err.user);
        setError(undefined);
      } else {
        setError((err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="shell stack" onSubmit={submit}>
      <div>
        <h1>Phosto</h1>
        <p className="note">
          {challenge
            ? 'Choose a password to finish setting up this account.'
            : 'Sign in to manage your photographs.'}
        </p>
      </div>

      {challenge ? (
        <div className="field">
          <label htmlFor="new-password">New password</label>
          <input
            id="new-password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            minLength={12}
          />
          <span className="note">At least 12 characters, with upper, lower, and a digit.</span>
        </div>
      ) : (
        <>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
        </>
      )}

      {error && <p className="error">{error}</p>}

      <button className="btn" type="submit" disabled={busy}>
        {busy ? 'Working…' : challenge ? 'Set password and sign in' : 'Sign in'}
      </button>
    </form>
  );
}
