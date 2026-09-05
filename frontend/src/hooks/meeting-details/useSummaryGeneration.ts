import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import type { Transcript, Summary } from '@/types';
import type { ModelConfig } from '@/components/ModelSettingsModal';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { withSpeakerPrefix } from '@/lib/speaker-labels';
import { parseSummaryData, sameSummaryTarget, summaryFailureMessage, summaryTarget } from '@/lib/summary-input';
import {
  detectAndCacheSummaryLanguage, readMeetingSummaryLanguage, readCachedDetectedSummaryLanguage,
} from '@/lib/summary-language-preferences';

type SummaryStatus = 'idle' | 'processing' | 'summarizing' | 'regenerating' | 'completed' | 'error';
interface UseSummaryGenerationProps {
  meeting: { id: string; created_at: string };
  transcripts: Transcript[];
  modelConfig: ModelConfig;
  isModelConfigLoading: boolean;
  selectedTemplate: string;
  onMeetingUpdated?: () => Promise<void>;
  updateMeetingTitle: (title: string) => void;
  setAiSummary: (summary: Summary | null) => void;
  onOpenModelSettings?: () => void;
}
interface SummaryEnvelope { status: string; data?: unknown; error?: string | null; meetingName?: string | null }
// Prevent two mounted entry points from submitting the same meeting concurrently.
const submissionLocks = new Map<string, symbol>();

async function resolveSummaryLanguage(meetingId: string, texts: string[]): Promise<string | null> {
  try { const explicit = await readMeetingSummaryLanguage(meetingId); if (explicit.language) return explicit.language; }
  catch { toast.warning('Could not load saved summary language', { description: 'Using Auto for this generation.' }); }
  try { const cached = await readCachedDetectedSummaryLanguage(meetingId); if (cached) return cached; } catch { /* Detection fallback is local. */ }
  try {
    const detected = await detectAndCacheSummaryLanguage(meetingId, texts);
    if (detected.reason === 'tie') toast.warning('Bilingual transcript detected', { description: 'Choose a summary language if Auto selects the wrong one.' });
    return detected.language;
  } catch { return null; }
}

async function readTarget(config: ModelConfig) {
  if (config.provider === 'custom-openai') {
    const stored = await invoke<{ endpoint: string } | null>('api_get_custom_openai_config');
    return summaryTarget(config.provider, config.model, stored?.endpoint);
  }
  if (config.provider === 'ollama') {
    const stored = await invoke<{ ollamaEndpoint?: string | null } | null>('api_get_model_config');
    return summaryTarget(config.provider, config.model, stored?.ollamaEndpoint);
  }
  return summaryTarget(config.provider, config.model);
}

async function allTranscripts(meetingId: string): Promise<Transcript[]> {
  type Page = { transcripts: Transcript[]; total_count: number; has_more: boolean };
  const first = await invoke<Page>('api_get_meeting_transcripts', { meetingId, limit: 1, offset: 0 });
  if (!first.total_count) return [];
  const result = await invoke<Page>('api_get_meeting_transcripts', { meetingId, limit: first.total_count, offset: 0 });
  // Never silently summarize a partial fetch. A recording changing beneath us needs a fresh snapshot.
  if (result.has_more || result.transcripts.length !== result.total_count) throw new Error('Transcript snapshot is incomplete. Finish recording and retry.');
  return result.transcripts;
}

function transcriptText(turns: Transcript[]): string {
  return turns.map((turn) => {
    const seconds = turn.audio_start_time;
    const stamp = typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
      ? `[${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}]`
      : turn.timestamp;
    return `${stamp} ${withSpeakerPrefix(turn, turn.text)}`;
  }).join('\n');
}

export function useSummaryGeneration(props: UseSummaryGenerationProps) {
  const { meeting, modelConfig, isModelConfigLoading, selectedTemplate, onMeetingUpdated, updateMeetingTitle, setAiSummary, onOpenModelSettings } = props;
  const [summaryStatus, setSummaryStatus] = useState<SummaryStatus>('idle');
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const { startSummaryPolling, stopSummaryPolling } = useSidebar();
  const activeMeeting = useRef(meeting.id);
  const request = useRef<{ abort: AbortController; dispatched: boolean; accepted: boolean; cancelRequested: boolean; token: symbol; meetingId: string } | null>(null);
  const currentConfig = useRef(modelConfig);
  currentConfig.current = modelConfig;

  useEffect(() => {
    activeMeeting.current = meeting.id;
    setSummaryStatus('idle'); setSummaryError(null);
    return () => {
      activeMeeting.current = '';
      const pending = request.current;
      if (pending && !pending.dispatched) pending.abort.abort();
      // Native jobs already accepted remain independent of the view. No destructive cancel on navigation.
      if (pending && submissionLocks.get(pending.meetingId) === pending.token) submissionLocks.delete(pending.meetingId);
      request.current = null;
    };
  }, [meeting.id]);

  const restore = useCallback(async (meetingId: string) => {
    try {
      const saved = await invoke<SummaryEnvelope>('api_get_summary', { meetingId });
      const parsed = parseSummaryData(saved.data);
      if (parsed && activeMeeting.current === meetingId) setAiSummary(parsed as unknown as Summary);
      return Boolean(parsed);
    } catch { return false; }
  }, [setAiSummary]);

  const begin = useCallback(async (regeneration: boolean, customPrompt = '') => {
    if (isModelConfigLoading) { toast.info('Summary settings are still loading'); return; }
    const id = meeting.id;
    if (submissionLocks.has(id)) return;
    const token = Symbol(id);
    const abort = new AbortController();
    submissionLocks.set(id, token);
    request.current = { token, abort, dispatched: false, accepted: false, cancelRequested: false, meetingId: id };
    const visible = () => activeMeeting.current === id && request.current?.token === token;
    const release = () => {
      if (submissionLocks.get(id) === token) submissionLocks.delete(id);
      if (request.current?.token === token) request.current = null;
    };
    const previousStatus = summaryStatus;
    setSummaryError(null); setSummaryStatus('processing');
    try {
      const target = await readTarget(modelConfig);
      if (abort.signal.aborted) { release(); return; }
      if (target.local && await invoke<boolean>('is_recording')) {
        toast.info('Keep recording responsive', { description: 'Finish recording before starting a local summary. Your transcript is still being captured.' });
        if (visible()) setSummaryStatus(previousStatus);
        release(); return;
      }
      if (modelConfig.provider === 'builtin-ai' && !await invoke<boolean>('builtin_ai_is_model_ready', { modelName: modelConfig.model, refresh: true })) {
        onOpenModelSettings?.();
        throw new Error('The selected built-in model is not ready.');
      }
      const turns = await allTranscripts(id);
      if (!turns.length) {
        toast.info('No saved transcript yet', { description: 'Finish and save a recording before generating its summary.' });
        if (visible()) setSummaryStatus(previousStatus);
        release(); return;
      }
      let notes = ''; let notesUnavailable = false;
      try { notes = (await invoke<{ notesMarkdown: string }>('api_get_meeting_notes', { meetingId: id })).notesMarkdown; }
      catch { notesUnavailable = true; }
      const { reviewSummaryInput } = await import('@/components/Meeting/SummaryInputReview');
      const approved = await reviewSummaryInput({ target, transcript: transcriptText(turns), notes, notesUnavailable, prompt: customPrompt, template: selectedTemplate }, abort.signal);
      if (!approved || abort.signal.aborted) {
        if (visible()) setSummaryStatus(previousStatus);
        release(); return;
      }
      // Settings can change while the review dialog is open. Never dispatch to a newly selected destination.
      const latestTarget = await readTarget(currentConfig.current);
      if (!sameSummaryTarget(target, latestTarget)) {
        toast.warning('Summary settings changed', { description: 'Review the new provider and model before sending. Nothing was sent.' });
        if (visible()) setSummaryStatus(previousStatus);
        release(); return;
      }
      const language = await resolveSummaryLanguage(id, turns.map(turn => turn.text));
      if (abort.signal.aborted || !visible()) { release(); return; }
      request.current!.dispatched = true;
      setSummaryStatus(regeneration ? 'regenerating' : 'summarizing');
      const result = await invoke<{ process_id: string }>('api_process_transcript', {
        text: approved.text, model: target.provider, modelName: target.model, meetingId: id,
        chunkSize: 40000, overlap: 1000, customPrompt: approved.customPrompt, templateId: selectedTemplate, summaryLanguage: language,
      });
      if (request.current?.token === token) request.current.accepted = true;
      startSummaryPolling(id, result.process_id, async (poll: SummaryEnvelope) => {
        const status = poll.status.toLowerCase();
        if (!['completed', 'cancelled', 'error', 'failed'].includes(status)) return;
        if (!visible()) { release(); return; }
        if (status === 'completed') {
          const parsed = parseSummaryData(poll.data);
          if (parsed) {
            setAiSummary(parsed as unknown as Summary);
            setSummaryStatus('completed'); setSummaryError(null);
            const title = (parsed.MeetingName ?? poll.meetingName);
            if (typeof title === 'string' && title.trim()) updateMeetingTitle(title);
            try { await onMeetingUpdated?.(); } catch { /* Summary is saved; list refresh can retry. */ }
          } else {
            setSummaryStatus('error'); setSummaryError('The provider returned an empty or unreadable summary. Your previous summary has not been overwritten in this view.');
          }
        } else {
          const restored = await restore(id);
          if (visible()) {
            setSummaryStatus(restored ? 'completed' : status === 'cancelled' ? 'idle' : 'error');
            if (status !== 'cancelled') setSummaryError(summaryFailureMessage(poll.error));
          }
        }
        release();
      });
      if (request.current?.token === token && request.current.cancelRequested) {
        const cancellation = await invoke<{ message: string }>('api_cancel_summary', { meetingId: id });
        if (/no active/i.test(cancellation.message)) toast.warning('Cancellation is not confirmed yet', { description: 'The request is still being checked. Retry Cancel.' });
      }
    } catch (error) {
      if (visible()) { setSummaryStatus('error'); setSummaryError(summaryFailureMessage(error)); }
      release();
    }
  }, [meeting.id, modelConfig, isModelConfigLoading, selectedTemplate, summaryStatus, startSummaryPolling, onOpenModelSettings, onMeetingUpdated, restore, setAiSummary, updateMeetingTitle]);

  const handleGenerateSummary = useCallback((prompt = '') => begin(false, prompt), [begin]);
  const handleRegenerateSummary = useCallback(() => begin(true), [begin]);
  const handleStopGeneration = useCallback(async () => {
    const pending = request.current;
    if (pending && !pending.dispatched) { pending.abort.abort(); return; }
    if (pending && !pending.accepted) {
      pending.cancelRequested = true;
      toast.info('Cancel requested', { description: 'Waiting for the summary job to acknowledge the request.' });
      return;
    }
    try {
      const cancellation = await invoke<{ message: string }>('api_cancel_summary', { meetingId: meeting.id });
      if (/no active/i.test(cancellation.message)) {
        const status = await invoke<SummaryEnvelope>('api_get_summary', { meetingId: meeting.id });
        if (!['completed', 'cancelled', 'error', 'failed', 'idle'].includes(status.status.toLowerCase())) {
          toast.warning('Cancellation could not be confirmed', { description: 'The request is still being checked. Retry Cancel.' });
          return;
        }
      }
      stopSummaryPolling(meeting.id);
      const restored = await restore(meeting.id);
      if (activeMeeting.current === meeting.id) { setSummaryStatus(restored ? 'completed' : 'idle'); setSummaryError(null); }
      if (pending && submissionLocks.get(meeting.id) === pending.token) submissionLocks.delete(meeting.id);
      request.current = null;
    } catch {
      // Keep polling; a failed cancel is not evidence that the native job stopped.
      toast.error('Cancellation could not be confirmed', { description: 'The summary may still be running. Retry Cancel.' });
    }
  }, [meeting.id, restore, stopSummaryPolling]);
  const getSummaryStatusMessage = useCallback((status: SummaryStatus) => ({
    idle: '', processing: 'Preparing summary input for review…', summarizing: 'Generating summary…', regenerating: 'Regenerating summary…', completed: 'Summary ready', error: 'Summary needs attention',
  }[status]), []);
  return { summaryStatus, summaryError, handleGenerateSummary, handleRegenerateSummary, handleStopGeneration, getSummaryStatusMessage };
}
