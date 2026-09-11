'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Captions, Pause, Play, Square } from 'lucide-react';
import { useTranscriptSession } from '@/contexts/TranscriptContext';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import './live-meeting.css';

interface LiveMeetingBarProps { isPaused: boolean; isBusy: boolean; captionsVisible: boolean; onPauseResume: () => void; onStop: () => void; onToggleCaptions: () => void }
function ElapsedTime() { const { activeDuration } = useRecordingState(); const seconds = Math.floor(Math.max(0, activeDuration || 0)); const h=Math.floor(seconds/3600); const m=Math.floor(seconds/60)%60; return <span className="live-dock-time" aria-label="Recording duration">{h>0?`${h}:`:''}{String(m).padStart(2,'0')}:{String(seconds%60).padStart(2,'0')}</span> }

export default function LiveMeetingBar({ isPaused, isBusy, captionsVisible, onPauseResume, onStop, onToggleCaptions }: LiveMeetingBarProps) {
  const { meetingTitle } = useTranscriptSession();
  const [centerHost,setCenterHost]=useState<Element|null>(null); const [trailingHost,setTrailingHost]=useState<Element|null>(null);
  useEffect(()=>{setCenterHost(document.querySelector('[data-meetodds-toolbar-center]'));setTrailingHost(document.querySelector('[data-meetodds-toolbar-trailing]'))},[]);
  const name = meetingTitle === '+ New Call' ? 'Name this meeting…' : meetingTitle;
  return <>
    {centerHost && createPortal(<span data-toolbar-center-active className="max-w-[360px] truncate rounded-[9px] px-3 py-1 text-[12px] font-medium text-2">{name}</span>, centerHost)}
    {trailingHost && createPortal(<div className="flex items-center gap-1.5"><button type="button" onClick={onToggleCaptions} aria-pressed={captionsVisible} className={`inline-flex h-8 items-center gap-1.5 rounded-[9px] px-2.5 text-[11px] font-semibold ${captionsVisible?'bg-accent-soft text-accent':'text-2 hover:bg-[var(--hover)]'}`}><Captions className="h-3.5 w-3.5"/>Captions</button></div>, trailingHost)}
    <footer className="live-recorder-dock" aria-label="Recording controls">
      <div className="live-recorder-state"><span className="live-record-dot" data-paused={isPaused}/><ElapsedTime/><span className="live-recorder-label">{isPaused?'Paused':'Recording locally'}</span></div>
      <div className="live-input-state" aria-hidden="true"><span>MIC</span><i/><i/><i className="active"/><i/><i/><span>SYSTEM</span><i/><i/><i/></div>
      <div className="live-recorder-actions"><button type="button" onClick={onPauseResume} disabled={isBusy} className="live-dock-button">{isPaused?<Play className="h-3.5 w-3.5"/>:<Pause className="h-3.5 w-3.5"/>}{isPaused?'Resume':'Pause'}</button><button type="button" onClick={onStop} disabled={isBusy} className="live-dock-button live-stop-button"><Square className="h-3 w-3" fill="currentColor"/>{isBusy?'Finishing…':'Stop'}</button></div>
    </footer>
  </>;
}
