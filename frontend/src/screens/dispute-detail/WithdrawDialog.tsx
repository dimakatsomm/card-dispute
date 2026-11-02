import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
import { Button } from '../../components/ui';

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
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-zinc-900/40 p-4 backdrop-blur-[2px] sm:items-center">
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={onKeyDown}
        className="w-full max-w-md space-y-3 rounded-2xl border border-line bg-surface p-6 shadow-xl"
      >
        <h2 id={titleId} className="text-lg font-semibold tracking-tight text-ink">
          Withdraw this dispute?
        </h2>
        <p id={descriptionId} className="text-sm text-zinc-600">
          Withdrawing is final: this transaction can never be disputed again, even if you change your mind.
        </p>
        <div className="flex flex-wrap justify-end gap-3 pt-3">
          <Button ref={cancelRef} variant="secondary" onClick={onCancel} disabled={pending}>
            Keep my dispute
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={pending}>
            {pending ? 'Withdrawing…' : 'Withdraw dispute'}
          </Button>
        </div>
      </div>
    </div>
  );
};
