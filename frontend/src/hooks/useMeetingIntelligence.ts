'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type {
  FollowupDraft,
  MeetingAction,
  MeetingActionUpdate,
  MeetingContext,
  MeetingIntelligence,
  MeetingPreparationResponse,
} from '@/types/intelligence';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useMeetingIntelligence(meetingId: string) {
  const [data, setData] = useState<MeetingIntelligence | null>(null);
  const [preparation, setPreparation] = useState<MeetingPreparationResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const activeMeetingId = useRef(meetingId);
  activeMeetingId.current = meetingId;

  const loadPreparation = useCallback(async () => {
    if (!meetingId) return null;
    try {
      const result = await invoke<MeetingPreparationResponse>('api_get_meeting_preparation', {
        meetingId,
      });
      if (activeMeetingId.current === meetingId) setPreparation(result);
      return result;
    } catch {
      // Preparation is optional until a project/client is linked.
      if (activeMeetingId.current === meetingId) setPreparation(null);
      return null;
    }
  }, [meetingId]);

  const load = useCallback(async () => {
    if (!meetingId) return;
    const request = ++generation.current;
    setIsLoading(true);
    setError(null);
    try {
      const result = await invoke<MeetingIntelligence>('api_get_meeting_intelligence', {
        meetingId,
      });
      if (request !== generation.current) return;
      setData(result);
      void loadPreparation();
    } catch (loadError) {
      if (request !== generation.current) return;
      setError(errorMessage(loadError));
    } finally {
      if (request === generation.current) setIsLoading(false);
    }
  }, [loadPreparation, meetingId]);

  useEffect(() => {
    setData(null);
    setPreparation(null);
    void load();
    return () => { generation.current += 1; };
  }, [load]);

  useEffect(() => {
    const onUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ meetingId?: string }>).detail;
      if (detail?.meetingId === meetingId) void load();
    };
    window.addEventListener('meetodds:meeting-intelligence-updated', onUpdated);
    return () => window.removeEventListener('meetodds:meeting-intelligence-updated', onUpdated);
  }, [load, meetingId]);

  const refresh = useCallback(async () => {
    if (!meetingId || isRefreshing) return;
    setIsRefreshing(true);
    setError(null);
    try {
      const result = await invoke<MeetingIntelligence>('api_refresh_meeting_intelligence', {
        meetingId,
      });
      setData(result);
      await loadPreparation();
    } catch (refreshError) {
      setError(errorMessage(refreshError));
      throw refreshError;
    } finally {
      setIsRefreshing(false);
    }
  }, [isRefreshing, loadPreparation, meetingId]);

  const saveContext = useCallback(async (context: MeetingContext) => {
    const saved = await invoke<MeetingContext>('api_save_meeting_context', {
      meetingId,
      context,
    });
    setData((current) => current ? { ...current, context: saved } : current);
    await loadPreparation();
    return saved;
  }, [loadPreparation, meetingId]);

  const confirmFact = useCallback(async (factId: string) => {
    await invoke<void>('api_set_meeting_fact_confirmed', { factId, confirmed: true });
    setData((current) => {
      if (!current) return current;
      const update = (fact: typeof current.outcome) => fact?.id === factId ? { ...fact, confirmed: true } : fact;
      return {
        ...current,
        outcome: update(current.outcome),
        decisions: current.decisions.map((fact) => fact.id === factId ? { ...fact, confirmed: true } : fact),
        openQuestions: current.openQuestions.map((fact) => fact.id === factId ? { ...fact, confirmed: true } : fact),
      };
    });
  }, []);

  const dismissFact = useCallback(async (factId: string) => {
    await invoke<void>('api_dismiss_meeting_fact', { factId });
    setData((current) => {
      if (!current) return current;
      return {
        ...current,
        outcome: current.outcome?.id === factId ? null : current.outcome,
        decisions: current.decisions.filter((fact) => fact.id !== factId),
        openQuestions: current.openQuestions.filter((fact) => fact.id !== factId),
      };
    });
  }, []);

  const updateAction = useCallback(async (update: MeetingActionUpdate) => {
    const saved = await invoke<MeetingAction>('api_update_meeting_action', { update });
    setData((current) => current ? {
      ...current,
      actions: saved.status === 'dismissed'
        ? current.actions.filter((action) => action.id !== saved.id)
        : current.actions.map((action) => action.id === saved.id ? saved : action),
    } : current);
    return saved;
  }, []);

  const generateFollowup = useCallback(async () => invoke<FollowupDraft>(
    'api_generate_followup_draft',
    { meetingId },
  ), [meetingId]);

  return {
    data,
    preparation,
    isLoading,
    isRefreshing,
    error,
    load,
    refresh,
    saveContext,
    confirmFact,
    dismissFact,
    updateAction,
    generateFollowup,
  };
}
