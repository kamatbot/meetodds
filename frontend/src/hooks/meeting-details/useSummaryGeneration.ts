import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import type { Transcript, Summary } from '@/types';
import type { ModelConfig } from '@/components/ModelSettingsModal';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { withSpeakerPrefix } from '@/lib/speaker-labels';
import { flushOpenNotes, getMomentNotesSummary } from '@/services/momentNotesService';
import { approveSummaryInput, parseSummaryData, sameSummaryTarget, summaryFailureMessage, summaryTarget, type SummaryReviewInput } from '@/lib/summary-input';
import { claimAutomaticSummary, POST_MEETING_INSTRUCTIONS, readAutoSummaryApproval } from '@/lib/post-meeting-flow';
import { detectAndCacheSummaryLanguage, readMeetingSummaryLanguage, readCachedDetectedSummaryLanguage } from '@/lib/summary-language-preferences';

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
interface PendingRequest { abort: AbortController; dispatched: boolean; accepted: boolean; cancelRequested: boolean; token: symbol; meetingId: string }
const submissionLocks = new Map<string, symbol>();
function automaticEnabled(): boolean {
  try { return localStorage.getItem('isAutoSummary') === 'true'; } catch { return false; }
}
const running = (status: string) => ['pending', 'processing', 'summarizing', 'regenerating'].includes(status.toLowerCase());

async function resolveSummaryLanguage(meetingId: string, texts: string[]): Promise<string | null> {
  try { const explicit = await readMeetingSummaryLanguage(meetingId); if (explicit.language) return explicit.language; }
  catch { toast.warning('Could not load saved summary language', { description: 'Using Auto for this generation.' }); }
  try { const cached = await readCachedDetectedSummaryLanguage(meetingId); if (cached) return cached; } catch { /* Local detection below. */ }
  try { return (await detectAndCacheSummaryLanguage(meetingId, texts)).language; } catch { return null; }
}
async function savedTarget() {
  // Read the persisted provider, not ConfigContext's temporary startup defaults.
  const config = await invoke<ModelConfig | null>('api_get_model_config');
  if (!config?.provider || !config.model?.trim()) throw new Error('No summary model is configured.');
  const custom = config.provider === 'custom-openai'
    ? await invoke<{ endpoint: string; model?: string } | null>('api_get_custom_openai_config') : null;
  return summaryTarget(config.provider, custom?.model || config.model, custom?.endpoint || config.ollamaEndpoint);
}
async function allTranscripts(meetingId: string): Promise<Transcript[]> {
  type Page = { transcripts: Transcript[]; total_count: number; has_more: boolean };
  const first = await invoke<Page>('api_get_meeting_transcripts', { meetingId, limit: 1, offset: 0 });
  if (!first.total_count) return [];
  const result = await invoke<Page>('api_get_meeting_transcripts', { meetingId, limit: first.total_count, offset: 0 });
  if (result.has_more || result.transcripts.length !== result.total_count) throw new Error('Transcript snapshot is incomplete. Finish recording and retry.');
  return result.transcripts;
}
function transcriptText(turns: Transcript[]): string {
  return turns.map(turn => {
    const seconds = turn.audio_start_time;
    const stamp = typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
      ? `[${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}]` : turn.timestamp;
    return `${stamp} ${withSpeakerPrefix(turn, turn.text)}`;
  }).join('\n');
}

export function useSummaryGeneration(props: UseSummaryGenerationProps) {
  const [summaryStatus, setSummaryStatus] = useState<SummaryStatus>('idle');
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [isCheckingSummary, setIsCheckingSummary] = useState(true);
  const sidebar = useSidebar();
  const sidebarRef = useRef(sidebar); sidebarRef.current = sidebar;
  const propsRef = useRef(props); propsRef.current = props;
  const activeMeeting = useRef(props.meeting.id);
  const request = useRef<PendingRequest | null>(null);
  const probeVersion = useRef(0);

  const restore = useCallback(async (id: string) => {
    const saved = await invoke<SummaryEnvelope>('api_get_summary', { meetingId: id });
    const parsed = parseSummaryData(saved.data);
    if (parsed && activeMeeting.current === id) propsRef.current.setAiSummary(parsed as unknown as Summary);
    return Boolean(parsed);
  }, []);

  const applyResult = useCallback(async (id: string, result: SummaryEnvelope, ownsView: () => boolean) => {
    const status = result.status.toLowerCase();
    if (running(status)) { if (ownsView()) setSummaryStatus('summarizing'); return false; }
    if (!['completed', 'cancelled', 'failed', 'error'].includes(status)) return false;
    if (status === 'completed') {
      const parsed = parseSummaryData(result.data);
      if (!parsed) {
        if (ownsView()) { setSummaryStatus('error'); setSummaryError('The AI returned an empty or unreadable summary. Retry generation; no actions were created.'); }
        return true;
      }
      // Project only the saved AI result. This also runs when the originating page
      // is no longer visible; Actions can independently repair it on the next read.
      try {
        await invoke('api_refresh_meeting_intelligence', { meetingId: id });
        window.dispatchEvent(new CustomEvent('meetodds:meeting-intelligence-updated', { detail: { meetingId: id } }));
      } catch {
        if (ownsView()) toast.warning('Summary saved; actions could not be loaded yet', { description: 'Use Refresh in the outcome panel to retry. Your AI summary is safe.' });
      }
      if (ownsView()) {
        propsRef.current.setAiSummary(parsed as unknown as Summary);
        setSummaryStatus('completed'); setSummaryError(null);
        const title = parsed.MeetingName ?? result.meetingName;
        if (typeof title === 'string' && title.trim()) propsRef.current.updateMeetingTitle(title);
        try { await propsRef.current.onMeetingUpdated?.(); } catch { /* Saved result is authoritative. */ }
      }
    } else if (ownsView()) {
      let restored = false;
      try { restored = await restore(id); } catch { /* Leave the previous document in the view. */ }
      if (ownsView()) {
        setSummaryStatus(restored ? 'completed' : status === 'cancelled' ? 'idle' : 'error');
        setSummaryError(status === 'cancelled' ? null : summaryFailureMessage(result.error));
      }
    }
    return true;
  }, [restore]);

  useEffect(() => {
    const id = props.meeting.id;
    activeMeeting.current = id;
    const version = ++probeVersion.current;
    let disposed = false;
    setIsCheckingSummary(true); setSummaryStatus('idle'); setSummaryError(null);
    const owns = () => !disposed && activeMeeting.current === id && version === probeVersion.current;
    void invoke<SummaryEnvelope>('api_get_summary', { meetingId: id }).then(async saved => {
      if (!owns()) return;
      const parsed = parseSummaryData(saved.data);
      if (parsed) propsRef.current.setAiSummary(parsed as unknown as Summary);
      if (running(saved.status)) {
        setSummaryStatus('summarizing');
        // Resume observation, never resubmit an already-running native job.
        sidebarRef.current.startSummaryPolling(id, 'resume-saved-job', result => { void applyResult(id, result, owns); });
      } else if (saved.status.toLowerCase() === 'completed' && parsed) {
        setSummaryStatus('completed');
      } else if (['failed', 'error'].includes(saved.status.toLowerCase())) {
        setSummaryStatus(parsed ? 'completed' : 'error'); setSummaryError(summaryFailureMessage(saved.error));
      }
    }).catch(() => {
      if (owns()) { setSummaryStatus('error'); setSummaryError('Could not read the saved summary status. Retry before starting a new AI request.'); }
    }).finally(() => { if (owns()) setIsCheckingSummary(false); });
    return () => {
      disposed = true;
      activeMeeting.current = '';
      const pending = request.current;
      if (pending && !pending.dispatched) pending.abort.abort();
      if (pending && submissionLocks.get(id) === pending.token) submissionLocks.delete(id);
      request.current = null;
    };
  }, [props.meeting.id, applyResult]);

  const begin = useCallback(async (regeneration: boolean, customPrompt = '', automatic = false) => {
    const current = propsRef.current;
    const id = current.meeting.id;
    if (current.isModelConfigLoading || isCheckingSummary || submissionLocks.has(id) || (automatic && !automaticEnabled())) return;
    const token = Symbol(id); const abort = new AbortController();
    submissionLocks.set(id, token);
    request.current = { token, abort, dispatched: false, accepted: false, cancelRequested: false, meetingId: id };
    const visible = () => activeMeeting.current === id && request.current?.token === token;
    const release = () => { if (submissionLocks.get(id) === token) submissionLocks.delete(id); if (request.current?.token === token) request.current = null; };
    const previousStatus = summaryStatus;
    setSummaryStatus('processing'); setSummaryError(null);
    try {
      // A route reload or competing window may already have started this job.
      const existing = await invoke<SummaryEnvelope>('api_get_summary', { meetingId: id });
      if (!visible() || abort.signal.aborted) { release(); return; }
      if (running(existing.status)) {
        request.current!.dispatched = true; request.current!.accepted = true;
        setSummaryStatus('summarizing');
        sidebarRef.current.startSummaryPolling(id, 'resume-existing-job', async poll => { if (await applyResult(id, poll, visible)) release(); });
        return;
      }
      const previousSummary = parseSummaryData(existing.data);
      if (automatic && (previousSummary || ['failed', 'error', 'cancelled'].includes(existing.status.toLowerCase()))) {
        setSummaryStatus(previousSummary ? 'completed' : previousStatus); release(); return;
      }
      const target = await savedTarget();
      if (target.local && await invoke<boolean>('is_recording')) throw new Error('Finish recording before starting a local summary.');
      if (target.provider === 'builtin-ai' && !await invoke<boolean>('builtin_ai_is_model_ready', { modelName: target.model, refresh: true })) {
        current.onOpenModelSettings?.(); throw new Error('The selected built-in model is not ready.');
      }
      const turns = await allTranscripts(id);
      if (!turns.length) { if (visible()) setSummaryStatus(previousStatus); release(); return; }
      if (automatic && (!automaticEnabled() || !claimAutomaticSummary(localStorage, id))) { if (visible()) setSummaryStatus(previousStatus); release(); return; }
      await flushOpenNotes();
      let notes = ''; let notesUnavailable = false;
      try { notes = (await invoke<{ notesMarkdown: string }>('api_get_meeting_notes', { meetingId: id })).notesMarkdown; } catch { notesUnavailable = true; }
      let manualNotes = '';
      try {
        const manual = await invoke<{ content: string }>('api_get_manual_notes', { meetingId: id });
        const linked = await getMomentNotesSummary(id);
        manualNotes = [manual.content, linked.content].filter(text => text.trim()).join('\n\n');
      } catch { throw new Error('NOTES_NOT_SAVED: Meeting notes could not be read. Reopen the notebook and retry. Nothing was sent.'); }
      const input: SummaryReviewInput = {
        target, transcript: transcriptText(turns), notes, notesUnavailable, manualNotes,
        prompt: [customPrompt.trim(), POST_MEETING_INSTRUCTIONS].filter(Boolean).join('\n\n'), template: current.selectedTemplate,
      };
      if (automatic && !automaticEnabled()) { if (visible()) setSummaryStatus(previousStatus); release(); return; }
      const approval = automatic ? readAutoSummaryApproval(localStorage, target) : null;
      const approved = approval
        ? approveSummaryInput(input, false, '', approval.includeManualNotes)
        : await (await import('@/components/Meeting/SummaryInputReview')).reviewSummaryInput(input, abort.signal);
      if (!approved || abort.signal.aborted || !visible()) { if (visible()) setSummaryStatus(previousStatus); release(); return; }
      const latestTarget = await savedTarget();
      if (!sameSummaryTarget(target, latestTarget)) {
        toast.warning('Summary settings changed', { description: 'Review the new provider and model. Nothing was sent.' });
        if (visible()) setSummaryStatus(previousStatus); release(); return;
      }
      const language = await resolveSummaryLanguage(id, turns.map(turn => turn.text));
      if (abort.signal.aborted || !visible()) { release(); return; }
      // Recheck remembered consent after every asynchronous preparation step.
      // Turning automatic generation off (or excluding notes) must revoke bypass.
      const currentApproval = approval ? readAutoSummaryApproval(localStorage, target) : null;
      if (automatic && (!automaticEnabled() || (approval && (!currentApproval || currentApproval.includeManualNotes !== approval.includeManualNotes)))) {
        setSummaryStatus(previousStatus); release(); return;
      }
      request.current!.dispatched = true;
      setSummaryStatus(regeneration || previousSummary ? 'regenerating' : 'summarizing');
      const result = await invoke<{ process_id: string }>('api_process_transcript', {
        text: approved.text, model: target.provider, modelName: target.model, meetingId: id,
        approvedTarget: { provider: target.provider, model: target.model, destination: target.destination },
        chunkSize: 40000, overlap: 1000, customPrompt: approved.customPrompt, templateId: current.selectedTemplate, summaryLanguage: language,
      });
      if (request.current?.token === token) request.current.accepted = true;
      sidebarRef.current.startSummaryPolling(id, result.process_id, async poll => { if (await applyResult(id, poll, visible)) release(); });
      if (request.current?.token === token && request.current.cancelRequested) await invoke('api_cancel_summary', { meetingId: id });
    } catch (error) {
      if (visible()) { setSummaryStatus('error'); setSummaryError(summaryFailureMessage(error)); }
      release();
    }
  }, [applyResult, isCheckingSummary, summaryStatus]);

  const handleGenerateSummary = useCallback((prompt = '', options?: { automatic?: boolean }) => begin(false, prompt, options?.automatic === true), [begin]);
  const handleRegenerateSummary = useCallback(() => begin(true), [begin]);
  const handleStopGeneration = useCallback(async () => {
    const id = propsRef.current.meeting.id; const pending = request.current;
    if (pending && !pending.dispatched) { pending.abort.abort(); return; }
    if (pending && !pending.accepted) { pending.cancelRequested = true; toast.info('Cancel requested; waiting for the job acknowledgement.'); return; }
    try {
      const cancellation = await invoke<{ message: string }>('api_cancel_summary', { meetingId: id });
      if (/no active/i.test(cancellation.message)) {
        const result = await invoke<SummaryEnvelope>('api_get_summary', { meetingId: id });
        if (running(result.status)) { toast.warning('Cancellation could not be confirmed. Retry Cancel.'); return; }
      }
      sidebarRef.current.stopSummaryPolling(id);
      const restored = await restore(id);
      if (activeMeeting.current === id) { setSummaryStatus(restored ? 'completed' : 'idle'); setSummaryError(null); }
      if (pending && submissionLocks.get(id) === pending.token) submissionLocks.delete(id);
      request.current = null;
    } catch { toast.error('Cancellation could not be confirmed', { description: 'The summary may still be running. Retry Cancel.' }); }
  }, [restore]);
  const getSummaryStatusMessage = useCallback((status: SummaryStatus) => ({
    idle: '', processing: 'Preparing the saved transcript and your approved notes…',
    summarizing: 'Your chosen AI is writing the summary and next steps…',
    regenerating: 'Updating the AI summary and unreviewed suggestions…', completed: 'Summary and actions ready', error: 'Summary needs attention',
  }[status]), []);
  return { summaryStatus, summaryError, isCheckingSummary, handleGenerateSummary, handleRegenerateSummary, handleStopGeneration, getSummaryStatusMessage };
}
