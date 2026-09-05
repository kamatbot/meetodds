/** A stopped microphone is not proof that audio has been persisted. */
export interface CaptureStatus {
  phase: 'idle' | 'recording' | 'paused' | 'finishing' | 'stopped';
  saved: 'unconfirmed' | 'audio-and-text' | 'text-only';
  failure: string | null;
  dismissed: boolean;
}
export type CaptureStatusEvent =
  | { type: 'started' | 'paused' | 'resumed' | 'finishing' | 'stopped' | 'dismissed' }
  | { type: 'saved'; audioRetained: boolean }
  | { type: 'failed' };
export const initialCaptureStatus: CaptureStatus = { phase: 'idle', saved: 'unconfirmed', failure: null, dismissed: false };
export function reduceCaptureStatus(state: CaptureStatus, event: CaptureStatusEvent): CaptureStatus {
  switch (event.type) {
    case 'started': return { ...state, phase: 'recording', saved: 'unconfirmed', dismissed: false };
    case 'paused': return { ...state, phase: 'paused' };
    case 'resumed': return { ...state, phase: 'recording' };
    case 'finishing': return { ...state, phase: 'finishing', dismissed: false };
    case 'stopped': return { ...state, phase: 'stopped' };
    case 'saved': return { ...state, saved: event.audioRetained ? 'audio-and-text' : 'text-only' };
    case 'failed': return { ...state, failure: 'The recording could not be fully saved. Keep its recovery folder and review the recording before closing MeetOdds.', dismissed: false };
    case 'dismissed': return { ...state, dismissed: true, failure: null };
  }
}
export function captureStatusCopy(state: CaptureStatus): { title: string; detail: string; warning: boolean } | null {
  if (state.dismissed) return null;
  if (state.failure) return { title: 'Recording save needs attention', detail: state.failure, warning: true };
  if (state.phase !== 'finishing' && state.phase !== 'stopped') return null;
  if (state.saved === 'audio-and-text') return {
    title: 'Audio and transcript files saved',
    detail: 'Your local recording files are saved. Library indexing or summary generation may still be finishing.', warning: false,
  };
  if (state.saved === 'text-only') return {
    title: 'Transcript files saved · no audio retained',
    detail: 'This recording has no saved audio for playback or re-transcription. Summary generation is separate.', warning: false,
  };
  return { title: state.phase === 'stopped' ? 'Capture stopped · save not yet confirmed' : 'Finishing the recording',
    detail: 'Keep MeetOdds open until its local save is confirmed. A completed summary is not required.', warning: false };
}
export function retainedAudioFromReceipt(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const receipt = payload as Record<string, unknown>;
  if (typeof receipt.audio_retained === 'boolean') return receipt.audio_retained;
  // Existing releases have only audio_file. Never infer retained audio from a stop event.
  return typeof receipt.audio_file === 'string' && Boolean(receipt.audio_file.trim());
}
