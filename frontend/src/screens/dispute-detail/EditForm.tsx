import { useId, useState, type FormEvent } from 'react';
import { REASON_CODES, type ReasonCode } from '../../lib/dispute-reasons';
import { reasonLabel } from '../disputes/labels';
import type { DisputeChange } from './api';

type Draft = { readonly reasonCode: ReasonCode; readonly description: string };

// EditDispute must carry at least one field, so only changed fields are sent.
export const editChange = (current: Draft, draft: Draft): DisputeChange | null => {
  const reasonChanged = draft.reasonCode !== current.reasonCode;
  const descriptionChanged = draft.description !== current.description;
  if (!reasonChanged && !descriptionChanged) return null;
  return {
    action: 'EDIT',
    ...(reasonChanged ? { reasonCode: draft.reasonCode } : {}),
    ...(descriptionChanged ? { description: draft.description } : {}),
  };
};

export const EditForm = ({
  current,
  pending,
  onSave,
  onCancel,
}: {
  readonly current: Draft;
  readonly pending: boolean;
  readonly onSave: (change: DisputeChange) => void;
  readonly onCancel: () => void;
}) => {
  const reasonId = useId();
  const descriptionId = useId();
  const [draft, setDraft] = useState<Draft>(current);
  const change = editChange(current, draft);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (change) onSave(change);
  };

  return (
    <form aria-label="Edit dispute" onSubmit={onSubmit}>
      <label htmlFor={reasonId}>Reason</label>
      <select
        id={reasonId}
        value={draft.reasonCode}
        onChange={(e) => {
          const code = REASON_CODES.find((r) => r === e.target.value);
          if (code) setDraft({ ...draft, reasonCode: code });
        }}
      >
        {REASON_CODES.map((code) => (
          <option key={code} value={code}>
            {reasonLabel[code]}
          </option>
        ))}
      </select>
      <label htmlFor={descriptionId}>Description</label>
      <textarea
        id={descriptionId}
        required
        value={draft.description}
        onChange={(e) => setDraft({ ...draft, description: e.target.value })}
      />
      <button type="submit" disabled={pending || !change}>
        {pending ? 'Saving…' : 'Save changes'}
      </button>
      <button type="button" onClick={onCancel} disabled={pending}>
        Cancel
      </button>
    </form>
  );
};
