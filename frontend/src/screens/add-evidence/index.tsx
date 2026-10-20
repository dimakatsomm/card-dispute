import { useMemo } from 'react';
import { useParams } from 'react-router';
import { useApi } from '../../api/ApiProvider';
import { createEvidenceApi, type EvidenceDeps } from '../../components/evidence';
import { sha256Hex, uploadEvidence } from '../../lib/upload';
import { AddEvidenceForm } from './AddEvidenceForm';

export const AddEvidenceScreen = () => {
  const { transactionId } = useParams();
  const client = useApi();
  const deps = useMemo<EvidenceDeps>(
    () => ({
      ...createEvidenceApi(client),
      sha256Hex: (file) => sha256Hex(file),
      uploadEvidence: (instruction, file, onProgress) => uploadEvidence(instruction, file, onProgress),
    }),
    [client],
  );
  if (!transactionId) return <p role="alert">This dispute could not be found.</p>;
  return <AddEvidenceForm key={transactionId} transactionId={transactionId} deps={deps} />;
};
