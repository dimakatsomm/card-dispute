import { useId, useState, type FormEvent } from 'react';
import { Button, Field, FieldError, Hint, Label, TextArea, cx, labelClass } from '../../components/ui';
import { codePointLength } from '../../components/evidence';
import type { Outcome } from './api';
import { NOTE_MAX, NOTE_MIN, checkNote, type NoteProblem } from './core';

const noteProblemMessage: Readonly<Record<NoteProblem, string>> = {
  TOO_SHORT: `The note must be at least ${NOTE_MIN} characters.`,
  TOO_LONG: `The note must be at most ${NOTE_MAX} characters.`,
};

const outcomeLabel: Readonly<Record<Outcome, string>> = {
  ACCEPTED: 'Accept: the customer is refunded',
  REJECTED: 'Reject: the charge stands',
};

const OUTCOMES: ReadonlyArray<Outcome> = ['ACCEPTED', 'REJECTED'];

export const ResolveForm = ({
  pending,
  onResolve,
}: {
  readonly pending: boolean;
  readonly onResolve: (input: { readonly outcome: Outcome; readonly note: string }) => void;
}) => {
  const id = useId();
  const ids = { note: `${id}-note`, count: `${id}-count`, noteError: `${id}-note-error`, outcomeError: `${id}-outcome-error` };
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [note, setNote] = useState('');
  const [attempted, setAttempted] = useState(false);

  const noteProblem = checkNote(note);
  const noteError = attempted && noteProblem ? noteProblemMessage[noteProblem] : null;
  const outcomeError = attempted && !outcome ? 'Choose an outcome.' : null;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    if (outcome && !noteProblem) onResolve({ outcome, note });
  };

  return (
    <form aria-label="Resolve dispute" noValidate onSubmit={onSubmit} className="space-y-5 border-t border-line pt-5">
      <fieldset aria-describedby={outcomeError ? ids.outcomeError : undefined}>
        <legend className={cx(labelClass, 'mb-2')}>Outcome</legend>
        <div className="flex flex-col gap-2">
          {OUTCOMES.map((value) => (
            <label key={value} className="flex items-center gap-2 text-sm text-ink">
              <input
                type="radio"
                name={`${id}-outcome`}
                className="size-4 accent-accent"
                checked={outcome === value}
                onChange={() => setOutcome(value)}
              />
              {outcomeLabel[value]}
            </label>
          ))}
        </div>
        {outcomeError ? <FieldError id={ids.outcomeError}>{outcomeError}</FieldError> : null}
      </fieldset>
      <Field>
        <Label htmlFor={ids.note}>Note to the customer</Label>
        <TextArea
          id={ids.note}
          value={note}
          aria-invalid={noteError ? true : undefined}
          aria-describedby={noteError ? `${ids.count} ${ids.noteError}` : ids.count}
          onChange={(e) => setNote(e.target.value)}
        />
        <Hint id={ids.count} className="tabular-nums">
          {codePointLength(note)} / {NOTE_MAX} characters (at least {NOTE_MIN}). The customer sees this note.
        </Hint>
        {noteError ? <FieldError id={ids.noteError}>{noteError}</FieldError> : null}
      </Field>
      <Button type="submit" disabled={pending}>
        {pending ? 'Resolving…' : 'Resolve dispute'}
      </Button>
    </form>
  );
};
