'use client';

import { Captions, NotebookPen, Pause, Play, Square } from 'lucide-react';
import { useTranscriptSession } from '@/contexts/TranscriptContext';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import './live-meeting.css';

interface LiveMeetingBarProps {
  isPaused: boolean;
  isBusy: boolean;
  captionsVisible: boolean;
  onPauseResume: () => void;
  onStop: () => void;
  onOpenNotes: () => void;
  onToggleCaptions: () => void;
}

function ElapsedTime() {
  const { activeDuration } = useRecordingState();
  const seconds = Math.floor(Math.max(0, activeDuration || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return <span className="meeting-elapsed" aria-label="Recording duration">{hours > 0 ? `${hours}:` : ''}{String(minutes).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}</span>;
}

export default function LiveMeetingBar({ isPaused, isBusy, captionsVisible, onPauseResume, onStop, onOpenNotes, onToggleCaptions }: LiveMeetingBarProps) {
  const { meetingTitle, currentMeetingId } = useTranscriptSession();
  return (
    <header className="meeting-live-bar">
      <div className="meeting-live-identity">
        <span className="meeting-recording-dot" data-paused={isPaused} aria-hidden="true" />
        <div className="meeting-live-title"><strong>{meetingTitle === '+ New Call' ? 'Your meeting' : meetingTitle}</strong><span role="status">{isPaused ? 'Paused' : 'Recording locally'}</span></div>
        <ElapsedTime />
      </div>
      <div className="meeting-live-actions">
        <button type="button" className="meeting-control" data-selected={captionsVisible} onClick={onToggleCaptions} aria-pressed={captionsVisible} aria-label={captionsVisible ? 'Hide floating captions' : 'Show floating captions'}><Captions size={17} /><span>Captions</span></button>
        <button type="button" className="meeting-control" onClick={onOpenNotes} disabled={!currentMeetingId} aria-label="Open linked meeting notes"><NotebookPen size={16} /><span>Notes</span></button>
        <span className="meeting-control-divider" aria-hidden="true" />
        <button type="button" className="meeting-control" onClick={onPauseResume} disabled={isBusy} aria-label={isPaused ? 'Resume recording' : 'Pause recording'}>{isPaused ? <Play size={15} /> : <Pause size={15} />}<span>{isPaused ? 'Resume' : 'Pause'}</span></button>
        <button type="button" className="meeting-control meeting-stop-control" onClick={onStop} disabled={isBusy} aria-label="Stop recording"><Square size={12} fill="currentColor" /><span>{isBusy ? 'Working…' : 'Finish'}</span></button>
      </div>
    </header>
  );
}
