from pathlib import Path

def edit(path, old, new, count=1):
    p=Path(path); s=p.read_text()
    if s.count(old)!=count: raise RuntimeError(f'{path}: expected {count}, found {s.count(old)}: {old[:90]}')
    p.write_text(s.replace(old,new))
def region(path, first, last, replacement):
    p=Path(path); s=p.read_text()
    if s.count(first)!=1: raise RuntimeError(f'{path}: ambiguous start')
    start=s.index(first); end=s.index(last,start); p.write_text(s[:start]+replacement+s[end:])

p='frontend/src-tauri/src/audio/mod.rs'
edit(p,'pub mod capture_preflight;', 'pub mod capture_preflight;\npub mod recovery_catalog;')
p='frontend/src-tauri/src/lib.rs'
edit(p,'            audio::capture_preflight::run_capture_preflight,', '            audio::capture_preflight::run_capture_preflight,\n            audio::recovery_catalog::list_recoverable_captures,\n            audio::recovery_catalog::read_capture_recovery_transcripts,\n            audio::recovery_catalog::recover_capture,\n            audio::recovery_catalog::discard_capture_recovery,')
p='frontend/src/hooks/useTranscriptRecovery.ts'
edit(p,"import { useState, useCallback } from 'react';", "import { useState, useCallback, useRef } from 'react';")
edit(p,'  const [isRecovering, setIsRecovering] = useState(false);', '  const [isRecovering, setIsRecovering] = useState(false);\n  const diskEntries = useRef(new Map<string, MeetingMetadata>());\n  const recovering = useRef(false);')
region(p, '      const meetings = await indexedDBService.getAllMeetings();', '      setRecoverableMeetings(meetingsWithAudioStatus);', '''      const [browserResult, diskResult] = await Promise.allSettled([
        indexedDBService.getAllMeetings(),
        invoke<MeetingMetadata[]>('list_recoverable_captures'),
      ]);
      const browser = browserResult.status === 'fulfilled' ? browserResult.value : [];
      const disk = diskResult.status === 'fulfilled' ? diskResult.value : [];
      if (browserResult.status === 'rejected' || diskResult.status === 'rejected') {
        toast.warning('Recovery scan is incomplete', { description: 'Some recovery storage could not be read. Existing recordings were not removed.' });
      }
      diskEntries.current = new Map(disk.map(entry => [entry.meetingId, entry]));
      const folders = new Set(disk.map(entry => entry.folderPath));
      const meetingsWithAudioStatus = [...disk, ...browser.filter(entry => !entry.savedToSQLite && entry.lastUpdated < Date.now() - 2000 && !folders.has(entry.folderPath))];
''')
edit(p,'      const transcripts = await indexedDBService.getTranscripts(meetingId);', "      const disk = diskEntries.current.get(meetingId);\n      const transcripts = disk?.folderPath\n        ? await invoke<StoredTranscript[]>('read_capture_recovery_transcripts', { meetingFolder: disk.folderPath })\n        : await indexedDBService.getTranscripts(meetingId);")
edit(p,'    setIsRecovering(true);\n    try {', '    if (recovering.current) throw new Error("Recovery is already running");\n    recovering.current = true;\n    setIsRecovering(true);\n    try {')
edit(p,'      const metadata = await indexedDBService.getMeetingMetadata(meetingId);', '      const metadata = diskEntries.current.get(meetingId) ?? await indexedDBService.getMeetingMetadata(meetingId);')
edit(p, '      // 2. Load all transcripts', '''      if (metadata.folderPath) {
        const recovered = await invoke<{ success: boolean; meetingId: string; audioRecoveryStatus: AudioRecoveryStatus }>('recover_capture', { meetingFolder: metadata.folderPath });
        // Native recovery is transactional/idempotent by folder; no synthetic transcript is needed.
        const browser = await indexedDBService.getAllMeetings().catch(() => []);
        for (const entry of browser.filter(entry => entry.folderPath === metadata.folderPath)) {
          await indexedDBService.markMeetingSaved(entry.meetingId).catch(() => undefined);
        }
        diskEntries.current.delete(meetingId);
        setRecoverableMeetings(previous => previous.filter(entry => entry.meetingId !== meetingId && entry.folderPath !== metadata.folderPath));
        return { success: recovered.success, meetingId: recovered.meetingId, audioRecoveryStatus: recovered.audioRecoveryStatus };
      }

      // 2. Load all transcripts''')
edit(p,'    } finally {\n      setIsRecovering(false);', '    } finally {\n      recovering.current = false;\n      setIsRecovering(false);')
edit(p, '      await indexedDBService.deleteMeeting(meetingId);', '''      const disk = diskEntries.current.get(meetingId);
      if (disk?.folderPath) {
        if (!window.confirm('Permanently delete this interrupted recording, its audio checkpoints, and transcript files? This cannot be undone.')) return;
        await invoke('discard_capture_recovery', { meetingFolder: disk.folderPath });
        diskEntries.current.delete(meetingId);
      } else {
        await indexedDBService.deleteMeeting(meetingId);
      }''')
p='frontend/src/app/page.tsx'
edit(p,"description: result.audioRecoveryStatus?.status === 'success'", "description: result.audioRecoveryStatus?.audio_file_path")

p='tools/recovery/verify-core.py'
edit(p,'once_cell = "1"', 'once_cell = "1"\nchrono = "0.4"')
edit(p, '    pub mod save_worker;\n', '    pub mod save_worker;\n    pub mod recovery_catalog;\n')
anchor='summary = root/\'frontend/src-tauri/src/summary\''
edit(p, anchor, '''catalog = (audio/'recovery_catalog.rs').read_text()
core_catalog = catalog[:catalog.index('async fn roots<')]+catalog[catalog.index('#[cfg(test)]'):]
core_catalog = core_catalog.replace('use tauri::{AppHandle, Runtime, State};\\n', '').replace('use crate::state::AppState;\\n', '')
(crate/'src/audio/recovery_catalog.rs').write_text(core_catalog)
'''+anchor)

p='frontend/src-tauri/src/audio/incremental_saver.rs'
s=Path(p).read_text(); pos=s.rfind('\n}')
s=s[:pos]+'''
    #[tokio::test]
    async fn real_codec_finalization_keeps_journal_until_metadata_commit() {
        let temp = tempfile::tempdir().unwrap(); let folder = temp.path();
        std::fs::create_dir(folder.join(".checkpoints")).unwrap();
        let mut saver = IncrementalAudioSaver::new(folder.to_path_buf(), 48_000).unwrap();
        saver.add_chunk(AudioChunk { data: vec![0.1; 12_000], sample_rate: 48_000, timestamp: 0.0, chunk_id: 0,
            device_type: super::super::recording_state::DeviceType::Microphone }).unwrap();
        let path = saver.finalize().await.unwrap();
        assert!(std::fs::metadata(&path).unwrap().len() > 32);
        assert!(folder.join(".checkpoints/audio.pcmj").exists());
        std::fs::write(folder.join("transcripts.json"), b"{\\"segments\\":[]}").unwrap();
        std::fs::write(folder.join("metadata.json"), br#"{"status":"completed","audio_file":"audio.mp4"}"#).unwrap();
        saver.finish_commit().unwrap();
        assert!(!folder.join(".checkpoints").exists());
        assert!(path.exists());
    }
'''+s[pos:];Path(p).write_text(s)
print('Integrated disk recovery independent of IndexedDB, including audio-only recordings.')
