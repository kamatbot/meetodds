const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('live desk keeps the transcript left and notes right through saving', () => {
  const page = read('src/app/page.tsx');
  const transcript = page.indexOf('<section className="live-transcript-pane"');
  const notes = page.indexOf('<aside className="live-notes-pane"');
  const mainEnd = page.indexOf('</main>', transcript);
  const controls = page.indexOf('<LiveMeetingBar', mainEnd);

  assert.ok(transcript >= 0 && notes > transcript, 'transcript precedes notes in the desk');
  assert.ok(mainEnd > notes && controls > mainEnd, 'recorder controls stay outside the scrollable desk');
  assert.match(page, /<TranscriptDrawer presentation="workspace"/);
  assert.match(page, /const showLiveDesk =[^;]*isFinishingMeeting/);
  assert.match(page, /const isSavingMeeting = status === RecordingStatus\.SAVING/);
  assert.match(page, /live-recording-layout w-full/);

  const css = read('src/components/Meeting/live-meeting.css');
  assert.match(css, /\.live-recording-layout\{display:grid;grid-template-columns:minmax\(0,1\.15fr\) minmax\(320px,\.85fr\)/);
  assert.match(css, /\.live-transcript-pane\{min-width:0;min-height:0/);
  assert.match(css, /\.live-notes-pane\{min-width:0;min-height:0/);
  assert.match(css, /\.live-recorder-dock\{height:64px;flex-shrink:0/);
  assert.match(css, /\.meetodds-live-workspace\.is-workspace\{[^}]*border:0;border-radius:0/);
  assert.doesNotMatch(read('src/components/Meeting/TranscriptDrawer.tsx'), /THE CONVERSATION/);
});

test('pause and stop keep the existing native handlers and surface failures', () => {
  const page = read('src/app/page.tsx');
  const bar = read('src/components/Meeting/LiveMeetingBar.tsx');

  assert.match(page, /invoke\(recordingState\.isPaused \? 'resume_recording' : 'pause_recording'\)/);
  assert.match(page, /Could not \$\{recordingState\.isPaused \? 'resume' : 'pause'\} recording/);
  assert.match(page, /invoke\('stop_recording', \{ args: \{ save_path:/);
  assert.match(page, /await handleRecordingStop\(true\)/);
  assert.match(page, /toast\.error\('Could not stop recording'/);
  assert.match(bar, /aria-label=\{isFinishing\?'Stop recording, finalization in progress':'Stop recording'\}/);
  assert.match(bar, />Stop<\/button>/);
  assert.match(page, /isStarting=\{isStartingMeeting\}/);
  assert.match(page, /isBusy=\{isHomeControlBusy \|\| isStartingMeeting \|\| isFinishingMeeting\}/);
  assert.match(bar, /isStarting\?'Starting recording…'/);
  assert.match(bar, /onClick=\{onPauseResume\} disabled=\{isBusy\}/);
  assert.match(bar, /onClick=\{onStop\} disabled=\{isBusy\}/);
  assert.doesNotMatch(bar, /live-input-state/);
});

test('captions remain the native preference and workspace ignores the old drawer toggle', () => {
  const page = read('src/app/page.tsx');
  const drawer = read('src/components/Meeting/TranscriptDrawer.tsx');
  const context = read('src/contexts/TranscriptContext.tsx');

  assert.match(page, /onToggleCaptions=\{\(\) => setCaptionsVisible\(!captionsVisible\)\}/);
  assert.match(context, /setLivePreviewPreference\(value\)/);
  assert.match(drawer, /if \(!visible && !isWorkspace\)/);
  assert.match(drawer, /presentation\?: 'drawer' \| 'workspace'/);
});

test('idle meetings stay reachable with inline recovery and secondary advanced features', () => {
  const home = read('src/components/Home/HomeDashboard.tsx');
  assert.match(home, /useMeetingList\(\{ query: '', sort: 'newest', starredOnly: false \}\)/);
  assert.match(home, /items\.map\(item => <MeetingRow/);
  assert.match(home, /onClick=\{\(\) => void loadMore\(\)\}/);
  assert.match(home, /interrupted meeting can be recovered/);
  assert.match(home, /onClick=\{props\.onReviewRecovery\}/);
  assert.match(home, /<details className="mt-8/);
  assert.match(home, /<CalendarAgendaCard/);
  assert.match(home, /<ActionInboxPreview/);
});

test('zero microphone inventory explains the unavailable start and offers retry/settings', () => {
  const home = read('src/components/Home/HomeDashboard.tsx');
  const page = read('src/app/page.tsx');

  assert.match(page, /hasMicrophone, isChecking: isCheckingMicrophone, error: permissionError, checkPermissions/);
  assert.match(page, /onRetryMicrophoneCheck=\{\(\) => \{ void checkPermissions\(\); \}\}/);
  assert.match(home, /props\.isCheckingMicrophone \?/);
  assert.match(home, /Checking microphone availability…/);
  assert.match(home, /props\.permissionError \|\| !props\.hasMicrophone/);
  assert.match(home, /props\.permissionError \? 'Microphone availability could not be checked\.' : 'No microphone detected\.'/);
  assert.match(home, /props\.onRetryMicrophoneCheck/);
  assert.match(home, /onClick=\{props\.onOpenSettings\}[^>]*>Settings/);
  assert.match(page, /newMeetingDisabled=\{!hasMicrophone \|\| isRecordingDisabled \|\| recordingBusy\}/);
  assert.match(home, /Microphone availability could not be checked\./);
});

test('notes retain autosave, recovery, and transcript-linked note requests without duration polling', () => {
  const notes = read('src/components/Meeting/LiveMeetingNotes.tsx');
  assert.match(notes, /useNoteDraft\(`meeting:\$\{meetingId\}`/);
  assert.match(notes, /await saveManualNotes\(meetingId, next\.markdown, base\.markdown\)/);
  assert.match(notes, /draft\.error && <div role="alert"/);
  assert.match(notes, /onClick=\{draft\.retry\}/);
  assert.match(notes, /Optional context for your summary · Original transcript unchanged/);
  assert.doesNotMatch(notes, /Included in the meeting summary|meetingTitle/);
  assert.match(notes, /window\.addEventListener\(LIVE_NOTE_REQUEST_EVENT/);
  assert.doesNotMatch(notes, /useRecordingState|activeDuration|setInterval\(/);
});
