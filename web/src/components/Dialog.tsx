import { useEffect, useRef, useState } from 'react';

interface Choice {
  id: string;
  name: string;
  /** Secondary line, e.g. how many of the selection this roll already holds. */
  note?: string;
}

type Ask =
  | { kind: 'confirm'; title: string; body?: string; confirmLabel?: string; danger?: boolean }
  | {
      kind: 'prompt';
      title: string;
      body?: string;
      value?: string;
      confirmLabel?: string;
      /** A paragraph rather than a line — a `<textarea>`, and Enter breaks a
       * line instead of submitting. */
      multiline?: boolean;
      maxLength?: number;
    }
  | { kind: 'choose'; title: string; body?: string; options: Choice[] };

/**
 * True while a modal dialog owns the screen. `window.confirm` froze the page, so
 * nothing behind it ever saw the Escape that dismissed it; `showModal()` blocks
 * pointer and focus but keydown still reaches window listeners, so one Escape
 * would cancel the dialog *and* clear the selection or close the lightbox under
 * it. Queried from the DOM rather than passed around: any dialog counts.
 *
 * `.modal` and not every `dialog[open]`: the lightbox is one too, and it must
 * not report itself as the thing holding the keyboard — its own arrow keys are
 * behind this check.
 */
export const modalOpen = () => Boolean(document.querySelector('dialog.modal[open]'));

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
    // The backdrop is part of the dialog element, so a click that lands on the
    // element itself rather than on the panel inside it is a click outside.
    // Listened for here rather than as a JSX onClick: a <dialog> is not an
    // interactive element, and a click handler on one is invisible to anything
    // that is not a mouse.
    const outside = (event: MouseEvent) => {
      if (event.target === el) el.close();
    };
    el.addEventListener('close', cancel);
    el.addEventListener('click', outside);
    return () => {
      el.removeEventListener('close', cancel);
      el.removeEventListener('click', outside);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask]);

  const dialog = ask && (
    <dialog className="modal" ref={node} aria-label={ask.title}>
      <form
        className="modal-body"
        onSubmit={(e) => {
          e.preventDefault();
          // Submitting a blank field resolves `''`, not null: that is how a
          // note is cleared. Only cancelling gives null, so the callers that
          // must have a value still reject both with one `if (!value)`.
          answer(ask.kind === 'prompt' ? text.trim() : true);
        }}
      >
        <h2 className="modal-title">{ask.title}</h2>
        {ask.body && <p className="note">{ask.body}</p>}

        {ask.kind === 'prompt' &&
          // The title is the question, so it is also this field's label; a
          // visible <label> would repeat it a line lower.
          (ask.multiline ? (
            <textarea
              autoFocus
              rows={4}
              aria-label={ask.title}
              maxLength={ask.maxLength}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          ) : (
            <input
              type="text"
              autoFocus
              aria-label={ask.title}
              maxLength={ask.maxLength}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          ))}

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
    /** Resolves the trimmed text — `''` if submitted blank — or null if cancelled. */
    prompt: (a: Omit<Extract<Ask, { kind: 'prompt' }>, 'kind'>) =>
      open({ ...a, kind: 'prompt' }) as Promise<string | null>,
    /** Resolves the chosen option's id, or null. */
    choose: (a: Omit<Extract<Ask, { kind: 'choose' }>, 'kind'>) =>
      open({ ...a, kind: 'choose' }) as Promise<string | null>,
    dialog,
  };
}
