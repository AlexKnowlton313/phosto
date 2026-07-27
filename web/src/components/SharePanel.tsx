import { useEffect, useState } from 'react';
import type { AdminApi, ShareSummary } from '../api';
import { useDialog } from './Dialog';

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/**
 * `expiresAt` is unix seconds. One source of truth for both the word and the
 * greying: computing them separately let a link with 20 minutes left round down
 * to "expired" while still rendering live and still working.
 */
function expiry(expiresAt?: number) {
  // No expiry attribute at all: the link runs until it is revoked.
  if (expiresAt === undefined) return { expired: false, label: 'never' };

  const ms = expiresAt * 1000 - Date.now();
  if (ms <= 0) return { expired: true, label: 'expired' };

  // Ceil, not round: anything still live has to read as live, even at a minute.
  const hours = Math.ceil(ms / 3600_000);
  return {
    expired: false,
    label:
      hours < 48
        ? relative.format(hours, 'hour')
        : relative.format(Math.round(hours / 24), 'day'),
  };
}

const dayMonthYear = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });

interface Props {
  api: AdminApi;
  folderId: string;
  /** Open state lives above: the toolbar button is what toggles this panel. */
  open: boolean;
  onClose: () => void;
}

/**
 * Everything about sharing one roll: the form, the URL it returns once, and the
 * list of links already out there.
 *
 * Mounted per roll (`key={folderId}`), so leaving a roll takes its created link
 * with it — which is the correct behaviour and not a thing to remember to reset:
 * the API returns a URL exactly once and stores only its hash.
 */
export function SharePanel({ api, folderId, open, onClose }: Props) {
  const [form, setForm] = useState({ label: '', days: 30, allowDownload: true });
  const [created, setCreated] = useState<{ url: string; expiresInDays: number }>();
  const [shares, setShares] = useState<ShareSummary[]>();
  const [error, setError] = useState<string>();
  const { confirm, dialog } = useDialog();

  const loadShares = () =>
    api
      .listShares(folderId)
      .then((r) => setShares(r.shares))
      .catch((err: Error) => setError(err.message));

  useEffect(() => {
    loadShares();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId]);

  const create = async () => {
    setError(undefined);
    try {
      setCreated(
        await api.createShare(folderId, {
          expiresInDays: form.days,
          allowDownload: form.allowDownload,
          label: form.label.trim() || undefined,
        }),
      );
      onClose();
      await loadShares();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const revoke = async (link: ShareSummary) => {
    const ok = await confirm({
      title: `Revoke ${link.label ? `“${link.label}”` : 'this link'}?`,
      body:
        'It stops working immediately, but a viewer with the roll already open ' +
        'keeps the signed image URLs it handed them until those expire, up to ' +
        '12 hours.',
      confirmLabel: 'Revoke',
      danger: true,
    });
    if (!ok) return;
    setError(undefined);
    try {
      await api.revokeShare(folderId, link.id);
      setCreated(undefined);
      await loadShares();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <>
      {/* Inline rather than in the dialog: this one has three fields and its
          result — the URL, shown once — has to stay on screen afterwards. */}
      {open && (
        <div className="panel stack">
          <div className="share-form">
            <div className="field">
              <label htmlFor="share-label">Label</label>
              <input
                id="share-label"
                type="text"
                placeholder="for mum"
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
              />
            </div>
            {/* A select, not a number field: it fixes the value to something the
                server accepts, so nothing here needs validating, and it is the
                only place "never" (0 — no TTL, no expiry check) can be picked. */}
            <div className="field">
              <label htmlFor="share-days">Expires</label>
              <select
                id="share-days"
                value={form.days}
                onChange={(e) => setForm({ ...form, days: Number(e.target.value) })}
              >
                <option value={7}>in 7 days</option>
                <option value={30}>in 30 days</option>
                <option value={90}>in 90 days</option>
                <option value={365}>in a year</option>
                <option value={0}>never</option>
              </select>
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={form.allowDownload}
                onChange={(e) => setForm({ ...form, allowDownload: e.target.checked })}
              />
              Allow downloads
            </label>
            <button type="button" className="btn" onClick={create}>
              Create link
            </button>
          </div>
        </div>
      )}

      {/* Hidden while the form is open rather than cleared when it opens: the
          link is real and still live, but sitting under a form for the next one
          it reads as if it were the one being made. */}
      {created && !open && (
        <div className="panel stack">
          <label htmlFor="share-url">
            {created.expiresInDays === 0
              ? 'Share link, never expires'
              : `Share link, expires in ${created.expiresInDays} ` +
                (created.expiresInDays === 1 ? 'day' : 'days')}
          </label>
          <div className="share-link" id="share-url">
            {created.url}
          </div>
          <div>
            <button
              type="button"
              className="btn"
              onClick={() => navigator.clipboard.writeText(created.url)}
            >
              Copy link
            </button>
          </div>
          <p className="note">Copy it now. Only its hash is stored, so this is the
            one time it can be shown.</p>
        </div>
      )}

      {error && <p className="error" style={{ padding: '16px 24px' }}>{error}</p>}

      {/* Collapsed by default: the list is reference material, and a roll with a
          handful of links pushed the contact sheet off the first screen. */}
      {shares && shares.length > 0 && (
        <details className="panel shares-panel">
          <summary>
            {shares.length} share {shares.length === 1 ? 'link' : 'links'}
          </summary>
          <div className="stack">
            <div className="shares-scroll">
              <table className="shares">
                <thead>
                  <tr>
                    <th>Label</th>
                    <th>Created</th>
                    <th>Expires</th>
                    <th>Opens</th>
                    <th>Download</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {shares.map((link) => {
                    // Expired links stay listed rather than filtered out: DynamoDB
                    // TTL deletion lags up to 48h, and a row that quietly vanishes
                    // hours later looks like a bug. Greyed, so the lag is visible.
                    const { expired, label } = expiry(link.expiresAt);
                    return (
                      <tr key={link.id} className={expired ? 'expired' : undefined}>
                        <td>{link.label ?? '·'}</td>
                        <td>{dayMonthYear(link.createdAt)}</td>
                        <td>{label}</td>
                        {/* Shares made before counting existed have no attribute
                            at all; a bare 0 would claim nobody opened them. */}
                        <td
                          title={
                            link.lastViewedAt
                              ? `last ${dayMonthYear(link.lastViewedAt)}`
                              : ''
                          }
                        >
                          {link.views ?? '·'}
                        </td>
                        <td>{link.allowDownload ? 'yes' : 'no'}</td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-danger"
                            onClick={() => revoke(link)}
                          >
                            Revoke
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="note">
              A share URL is shown once, when it is created. Only its SHA-256 is
              stored, so no link can be listed here. Revoke one and make another.
              Opens count page loads, not people — a reload counts again, and a
              link preview in a chat does not count at all.
            </p>
          </div>
        </details>
      )}

      {dialog}
    </>
  );
}
