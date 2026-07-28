import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  adminApi,
  LIBRARY_ID,
  TRASH_ID,
  type AppConfig,
  type FolderView,
  type TokenSource,
} from '../api';
import { RollIndex } from './RollIndex';
import { RollView } from './RollView';

/**
 * The open roll lives in location.hash, not in state, so the browser's back
 * button and a reload both land where the user expects. `#<folderId>` rather
 * than a path because /f/* is a CloudFront behaviour, not the SPA. Read through
 * useSyncExternalStore because the hash is exactly that: state owned by
 * something outside React, which a mirrored copy could only ever lag.
 */
const subscribeToHash = (onChange: () => void) => {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
};

const currentHash = () => location.hash.slice(1);

/**
 * The admin shell: the folder list, which roll is open, and nothing else. Both
 * halves below own their own state — see `RollView`, which is mounted per roll.
 */
export function Admin({
  config,
  getToken,
}: {
  config: AppConfig;
  getToken: TokenSource;
}) {
  const api = adminApi(getToken);
  const [folders, setFolders] = useState<FolderView[]>();
  const [error, setError] = useState<string>();
  const folderId = useSyncExternalStore(subscribeToHash, currentHash);

  // "All photos" is a pseudo-roll: it has no folder record, so it can't be
  // renamed, shared or deleted, and there is nothing to detach from. Everything
  // else about it is an ordinary contact sheet.
  const isLibrary = folderId === LIBRARY_ID;
  // Trash is the second one, on the same terms. It reads a different route and
  // its selection does different things, but it is still a contact sheet.
  const isTrash = folderId === TRASH_ID;

  // The signed cookies, not the JWT, are what let the browser load images.
  // Sequential on purpose: cover thumbnails render as soon as the folders land,
  // so the cookie has to exist first or they 403 on a cold load.
  useEffect(() => {
    api
      .startSession()
      .catch(() => setError('Could not start an image session'))
      .then(() => api.listFolders())
      .then((r) => setFolders(r.folders))
      .catch((err: Error) => setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getToken]);

  // The cookie runs on its own clock, not the JWT's, and expires at SESSION_TTL
  // (8h) — after which the sheet fills with 403s that look like broken images.
  // Re-minting at half that means it is never within four hours of lapsing while
  // a tab is alive. Swallowed: a failed renewal must not take a working page
  // down, and the next tick tries again.
  useEffect(() => {
    const id = setInterval(() => void api.startSession().catch(() => {}), 4 * 3600_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getToken]);

  const reloadFolders = useCallback(async () => {
    setFolders((await api.listFolders()).folders);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getToken]);

  // Synthesised so the roll view can read `folder.name` without branching on
  // every line. Its `photoCount` is the sheet's own length, so it stays 0 here.
  const current: FolderView | undefined = isLibrary
    ? { folderId: LIBRARY_ID, name: 'All photos', createdAt: '', photoCount: 0 }
    : isTrash
      ? { folderId: TRASH_ID, name: 'Trash', createdAt: '', photoCount: 0 }
      : folders?.find((f) => f.folderId === folderId);

  if (!current) {
    // A reload with a hash arrives before the folder list does; don't flash the
    // roll index on the way to the folder the user actually asked for.
    if (folderId && !folders) {
      return (
        <div className="empty">
          <p className="note">Loading…</p>
        </div>
      );
    }

    return (
      <RollIndex
        api={api}
        config={config}
        folders={folders}
        onFolderCreated={(folder) => {
          setFolders((prev) => [folder, ...(prev ?? [])]);
          location.hash = folder.folderId;
        }}
        loadError={error}
      />
    );
  }

  return (
    <RollView
      // Per roll, so leaving one throws its sheet, selection and open frame
      // away rather than unsetting them one at a time on the way out.
      key={current.folderId}
      api={api}
      folder={current}
      isLibrary={isLibrary}
      isTrash={isTrash}
      folders={folders}
      onFolderUpdated={(folder) =>
        setFolders((prev) => prev?.map((f) => (f.folderId === folder.folderId ? folder : f)))
      }
      reloadFolders={reloadFolders}
    />
  );
}
