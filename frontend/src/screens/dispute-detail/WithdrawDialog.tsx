import { useEffect, useId, useRef, type KeyboardEvent } from 'react';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])';

const focusablesIn = (root: HTMLElement): ReadonlyArray<HTMLElement> =>
  Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));

export const WithdrawDialog = ({
  pending,
  onConfirm,
  onCancel,
}: {
  readonly pending: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) => {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => previouslyFocused?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && !pending) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusables = focusablesIn(dialogRef.current);
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      ref={dialogRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onKeyDown={onKeyDown}
    >
      <h2 id={titleId}>Withdraw this dispute?</h2>
      <p id={descriptionId}>
        Withdrawing is final: this transaction can never be disputed again, even if you change your mind.
      </p>
      <button ref={cancelRef} type="button" onClick={onCancel} disabled={pending}>
        Keep my dispute
      </button>
      <button type="button" onClick={onConfirm} disabled={pending}>
        {pending ? 'Withdrawing…' : 'Withdraw dispute'}
      </button>
    </div>
  );
};
