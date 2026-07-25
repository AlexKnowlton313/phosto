import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  type CognitoUserSession,
} from 'amazon-cognito-identity-js';
import type { AppConfig } from './api';

let pool: CognitoUserPool | undefined;

export function initPool(config: AppConfig): CognitoUserPool {
  pool ??= new CognitoUserPool({
    UserPoolId: config.userPoolId,
    ClientId: config.userPoolClientId,
  });
  return pool;
}

export class NewPasswordRequired extends Error {
  constructor(readonly user: CognitoUser) {
    super('Set a new password to finish signing in');
  }
}

/**
 * `admin-create-user` leaves the account in FORCE_CHANGE_PASSWORD, so the very
 * first sign-in always hits the newPasswordRequired challenge. Surfacing it as a
 * distinct error lets the form ask for a new password instead of failing with
 * something unhelpful.
 */
export function signIn(
  config: AppConfig,
  email: string,
  password: string,
): Promise<CognitoUserSession> {
  const user = new CognitoUser({ Username: email, Pool: initPool(config) });

  return new Promise((resolve, reject) => {
    user.authenticateUser(
      new AuthenticationDetails({ Username: email, Password: password }),
      {
        onSuccess: resolve,
        onFailure: reject,
        newPasswordRequired: () => reject(new NewPasswordRequired(user)),
      },
    );
  });
}

export function completeNewPassword(
  user: CognitoUser,
  newPassword: string,
): Promise<CognitoUserSession> {
  return new Promise((resolve, reject) => {
    user.completeNewPasswordChallenge(
      newPassword,
      {},
      { onSuccess: resolve, onFailure: reject },
    );
  });
}

/** Returns a valid access token, refreshing silently, or null if signed out. */
export function currentToken(config: AppConfig): Promise<string | null> {
  const user = initPool(config).getCurrentUser();
  if (!user) return Promise.resolve(null);

  return new Promise((resolve) => {
    user.getSession((err: Error | null, session: CognitoUserSession | null) => {
      if (err || !session?.isValid()) return resolve(null);
      resolve(session.getAccessToken().getJwtToken());
    });
  });
}

export function signOut(config: AppConfig): void {
  initPool(config).getCurrentUser()?.signOut();
}
