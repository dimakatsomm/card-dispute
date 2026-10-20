import { useMemo } from 'react';
import { useParams } from 'react-router';
import { useApi } from '../../api/ApiProvider';
import { createEvidenceApi } from '../../components/evidence';
import { sha256Hex, uploadEvidence } from '../../lib/upload';
import { createDisputeApi } from './api';
import { DisputeForm } from './DisputeForm';
import type { DisputeFormDeps } from './use-cases';

export const DisputeFormScreen = () => {
  const { transactionId } = useParams();
  const client = useApi();
  const deps = useMemo<DisputeFormDeps>(
    () => ({
      ...createDisputeApi(client),
      ...createEvidenceApi(client),
      sha256Hex: (file) => sha256Hex(file),
      uploadEvidence: (instruction, file, onProgress) => uploadEvidence(instruction, file, onProgress),
    }),
    [client],
  );
  if (!transactionId) return <p role="alert">This transaction could not be found.</p>;
  return <DisputeForm key={transactionId} transactionId={transactionId} deps={deps} />;
};
