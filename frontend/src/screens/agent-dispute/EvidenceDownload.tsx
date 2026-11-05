import { useRef, useState } from 'react';
import { useApi } from '../../api/ApiProvider';
import { Button, errorClass } from '../../components/ui';
import { getEvidenceDownloadUrl, type DownloadError } from './api';
import { POPUP_BLOCKED_MESSAGE, downloadErrorMessage } from './core';

type State = { readonly kind: 'idle' } | { readonly kind: 'pending' } | { readonly kind: 'error'; readonly message: string };

// Stays mounted after a reload makes the item non-STORED so its error is still shown.
export const EvidenceDownload = ({
  transactionId,
  evidenceId,
  fileName,
  downloadable,
  onStale,
}: {
  readonly transactionId: string;
  readonly evidenceId: string;
  readonly fileName: string;
  readonly downloadable: boolean;
  readonly onStale: () => void;
}) => {
  const api = useApi();
  const [state, setState] = useState<State>({ kind: 'idle' });
  // Guards the gap before React re-renders the button as disabled.
  const inFlight = useRef(false);
  const errorId = `evidence-download-error-${evidenceId}`;

  const fail = (error: DownloadError) => {
    setState({ kind: 'error', message: downloadErrorMessage(error) });
    if (error.kind === 'NOT_FOUND' || error.kind === 'NOT_STORED') onStale();
  };

  const onClick = async () => {
    if (inFlight.current) return;
    // Opened before any await so popup blockers allow it; if blocked we skip the API, as each call is audited.
    const tab = window.open('', '_blank');
    if (!tab) {
      setState({ kind: 'error', message: POPUP_BLOCKED_MESSAGE });
      return;
    }
    tab.opener = null;
    inFlight.current = true;
    setState({ kind: 'pending' });
    const result = await getEvidenceDownloadUrl(api)({ transactionId, evidenceId });
    inFlight.current = false;
    if (result.ok) {
      tab.location.replace(result.value);
      setState({ kind: 'idle' });
      return;
    }
    tab.close();
    fail(result.error);
  };

  if (!downloadable && state.kind !== 'error') return null;
  return (
    <span className="inline-flex flex-col gap-1 align-middle">
      {downloadable ? (
        <Button
          size="sm"
          variant="secondary"
          aria-label={`Download ${fileName}`}
          aria-describedby={state.kind === 'error' ? errorId : undefined}
          disabled={state.kind === 'pending'}
          onClick={() => void onClick()}
        >
          {state.kind === 'pending' ? 'Preparing…' : 'Download'}
        </Button>
      ) : null}
      {state.kind === 'error' ? (
        <span id={errorId} role="alert" className={errorClass}>
          {state.message}
        </span>
      ) : null}
    </span>
  );
};
