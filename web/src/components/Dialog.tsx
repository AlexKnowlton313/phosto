import { useEffect, useRef, useState } from 'react';

interface Choice {
  id: string;
  name: string;
  /** Secondary line, e.g. how many of the selection this roll already holds. */
  note?: string;
}

type Ask =
  | { kind: 'confirm'; title: string; body?: string; confirmLabel?: string; danger?: boolean }
  | { kind: 'prompt'; title: string; body?: string; value?: string; confirmLabel?: string }
  | { kind: 'choose'; title: string; body?: string; options: Choice[] };

/**
 * True while a modal dialog owns the screen. `window.confirm` froze the page, so
 * nothing behind it ever saw the Escape that dismissed it; `showModal()` blocks
 * pointer and focus but keydown still reaches window listeners, so one Escape
 * would cancel the dialog *and* clear the selection or close the lightbox under
 * it. Queried from the DOM rather than passed around: any dialog counts.
 */
export const modalOpen = () => Boolean(document.querySelector('dialog[open]'));

/**
 * The three questions this app asks — confirm, prompt, pick a roll — in one
 * `<dialog>` instead of the browser's own, which cannot be styled and renders a
 * chrome-coloured box in the middle of a darkroom.
 *
 * Native `showModal()` rather than a hand-rolled overlay: the focus trap, the
 * inertness of everything behind it, Esc, and the top layer (which is what puts
 * it over the lightbox without a z-index argument) all come from the platform.
 * Only the skin is ours.
 *
 * Promise-based so a call site reads the way `window.confirm` did — the whole
 * point of replacing them was to change how they look, not how they are called.
 */
export function useDialog() {
  const [ask, setAsk] = useState<Ask>();
  const [text, setText] = useState('');
  const node = useRef<HTMLDialogElement>(null);
  // A noop between questions, so a second `close` — Esc landing on a dialog that
  // a button already answered — resolves nothing twice.
  const settle = useRef<(value: unknown) => void>(() => {});

  const open = (next: Ask) =>
    new Promise<unknown>((resolve) => {
      settle.current = resolve;
      setText(next.kind === 'prompt' ? (next.value ?? '') : '');
      setAsk(next);
    });

  const answer = (value: unknown) => {
    settle.current(value);
    settle.current = () => {};
    setAsk(undefined);
  };

  // React 18 does not attach the dialog's non-bubbling `close`, so listen on the
  // element. Cancelling is `false` for a confirm and `null` for the two that
  // return a value — the same shapes the native calls returned.
  useEffect(() => {
    const el = node.current;
    if (!ask || !el) return;
    el.showModal();
    const cancel = () => answer(ask.kind === 'confirm' ? false : null);
    el.addEventListener('close', cancel);
    return () => el.removeEventListener('close', cancel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask]);

  const dialog = ask && (
    <dialog
      className="modal"
      ref={node}
      // The backdrop is part of the dialog element, so a click that lands on the
      // element itself rather than on the panel inside it is a click outside.
      onClick={(e) => {
        if (e.target === node.current) node.current?.close();
      }}
    >
      <form
        className="modal-body"
        onSubmit={(e) => {
          e.preventDefault();
          answer(ask.kind === 'prompt' ? text.trim() || null : true);
        }}
      >
        <h2 className="modal-title">{ask.title}</h2>
        {ask.body && <p className="note">{ask.body}</p>}

        {ask.kind === 'prompt' && (
          <input
            type="text"
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        )}

        {ask.kind === 'choose' && (
          <div className="modal-choices">
            {ask.options.map((option) => (
              <button
                key={option.id}
                type="button"
                className="btn"
                onClick={() => answer(option.id)}
              >
                {option.name}
                {option.note && <span className="modal-note">{option.note}</span>}
              </button>
            ))}
          </div>
        )}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => node.current?.close()}>
            Cancel
          </button>
          {/* A picker's choices are its actions; there is nothing left to OK. */}
          {ask.kind !== 'choose' && (
            <button
              type="submit"
              className={ask.kind === 'confirm' && ask.danger ? 'btn btn-danger' : 'btn'}
            >
              {ask.confirmLabel ?? 'OK'}
            </button>
          )}
        </div>
      </form>
    </dialog>
  );

  return {
    confirm: (a: Omit<Extract<Ask, { kind: 'confirm' }>, 'kind'>) =>
      open({ ...a, kind: 'confirm' }) as Promise<boolean>,
    /** Resolves the trimmed text, or null if cancelled or left blank. */
    prompt: (a: Omit<Extract<Ask, { kind: 'prompt' }>, 'kind'>) =>
      open({ ...a, kind: 'prompt' }) as Promise<string | null>,
    /** Resolves the chosen option's id, or null. */
    choose: (a: Omit<Extract<Ask, { kind: 'choose' }>, 'kind'>) =>
      open({ ...a, kind: 'choose' }) as Promise<string | null>,
    dialog,
  };
}
