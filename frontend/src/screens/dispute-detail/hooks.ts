import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useApi } from '../../api/ApiProvider';
import type { Result } from '../../app/result';
import { loadDispute, type DisputeDetail, type LoadError, type LoadedDispute } from './api';
import { describeChanges, hasPendingEvidence, isStillChecking, pollDelay } from './core';

type Loaded = Result<LoadedDispute, LoadError>;

const pendingIn = (data: Loaded | undefined): boolean => (data?.ok ? hasPendingEvidence(data.value.dispute.evidence) : false);

export const useDispute = (transactionId: string) => {
  const api = useApi();
  const queryClient = useQueryClient();
  const queryKey = ['dispute', transactionId];
  // A ref, not state, so refetchInterval sees the count of the fetch that just finished.
  const checks = useRef(0);
  const [stillChecking, setStillChecking] = useState(false);

  const query = useQuery({
    queryKey,
    queryFn: async (): Promise<Loaded> => {
      const result = await loadDispute(api)(transactionId);
      const previous = queryClient.getQueryData<Loaded>(queryKey);
      // A failed background refresh keeps the loaded dispute so open drafts and dialogs survive.
      const next = !result.ok && previous?.ok ? previous : result;
      checks.current = pendingIn(next) ? checks.current + 1 : 0;
      setStillChecking(isStillChecking({ pending: pendingIn(next), polls: checks.current }));
      return next;
    },
    // Off-screen tabs are skipped by react-query's default refetchIntervalInBackground: false.
    refetchInterval: (q) => pollDelay({ pending: pendingIn(q.state.data), polls: checks.current }),
  });

  const recheck = () => {
    checks.current = 0;
    setStillChecking(false);
    void query.refetch();
  };

  return { query, stillChecking, recheck };
};

export const useChangeAnnouncement = (dispute: DisputeDetail): string => {
  const previous = useRef(dispute);
  const [message, setMessage] = useState('');
  useEffect(() => {
    const text = describeChanges(previous.current, dispute);
    previous.current = dispute;
    if (text) setMessage(text);
  }, [dispute]);
  return message;
};
