/**
 * useTranscriptRecovery Hook
 *
 * Orchestrates transcript recovery operations for interrupted meetings.
 * Provides functionality to detect, preview, and recover meetings from IndexedDB.
 */

import { useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { indexedDBService, MeetingMetadata, StoredTranscript } from '@/services/indexedDBService';
import { storageService } from '@/services/storageService';
import { applyPinnedSummaryLanguageToMeeting } from '@/lib/summary-language-preferences';
import { toast } from 'sonner';

interface AudioRecoveryStatus {
  status: string; // "success" | "partial" | "failed" | "none"
  chunk_count: number;
  estimated_duration_seconds: number;
  audio_file_path?: string;
  message: string;
}

export interface UseTranscriptRecoveryReturn {
  recoverableMeetings: MeetingMetadata[];
  isLoading: boolean;
  isRecovering: boolean;
  checkForRecoverableTranscripts: () => Promise<void>;
  recoverMeeting: (meetingId: string) => Promise<{ success: boolean; audioRecoveryStatus?: AudioRecoveryStatus | null; meetingId?: string }>;
  loadMeetingTranscripts: (meetingId: string) => Promise<StoredTranscript[]>;
  deleteRecoverableMeeting: (meetingId: string) => Promise<void>;
}

export function useTranscriptRecovery(): UseTranscriptRecoveryReturn {
  const [recoverableMeetings, setRecoverableMeetings] = useState<MeetingMetadata[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isRecovering, setIsRecovering] = useState(false);
  const diskEntries = useRef(new Map<string, MeetingMetadata>());
  const recovering = useRef(false);

  /**
   * Check for recoverable meetings in IndexedDB
   */
  const checkForRecoverableTranscripts = useCallback(async () => {
    setIsLoading(true);
    try {
      const [browserResult, diskResult] = await Promise.allSettled([
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
      setRecoverableMeetings(meetingsWithAudioStatus);
    } catch (error) {
      console.error('Failed to check for recoverable transcripts:', error);
      setRecoverableMeetings([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Load transcripts for preview
   */
  const loadMeetingTranscripts = useCallback(async (meetingId: string): Promise<StoredTranscript[]> => {
    try {
      const disk = diskEntries.current.get(meetingId);
      const transcripts = disk?.folderPath
        ? await invoke<StoredTranscript[]>('read_capture_recovery_transcripts', { meetingFolder: disk.folderPath })
        : await indexedDBService.getTranscripts(meetingId);
      // Sort by sequence ID
      transcripts.sort((a, b) => (a.sequenceId || 0) - (b.sequenceId || 0));
      return transcripts;
    } catch (error) {
      console.error('Failed to load meeting transcripts:', error);
      return [];
    }
  }, []);

  /**
   * Recover a meeting from IndexedDB
   */
  const recoverMeeting = useCallback(async (meetingId: string): Promise<{ success: boolean; audioRecoveryStatus?: AudioRecoveryStatus | null; meetingId?: string }> => {
    if (recovering.current) throw new Error("Recovery is already running");
    recovering.current = true;
    setIsRecovering(true);
    try {
      // 1. Load meeting metadata
      const metadata = diskEntries.current.get(meetingId) ?? await indexedDBService.getMeetingMetadata(meetingId);
      if (!metadata) {
        throw new Error('Meeting metadata not found');
      }

      if (metadata.folderPath) {
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

      // 2. Load all transcripts
      const transcripts = await loadMeetingTranscripts(meetingId);
      if (transcripts.length === 0) {
        throw new Error('No transcripts found for this meeting');
      }

      // 3. Check for folder path
      let folderPath = metadata.folderPath;


      // Never borrow a folder from an unrelated live recording.

      // 4. Attempt audio recovery if folder path exists
      let audioRecoveryStatus: AudioRecoveryStatus | null = null;
      if (folderPath) {
        try {
          audioRecoveryStatus = await invoke<AudioRecoveryStatus>(
            'recover_audio_from_checkpoints',
            { meetingFolder: folderPath, sampleRate: 48000 }
          );
        } catch (error) {
          console.error('Audio recovery failed:', error);
          audioRecoveryStatus = {
            status: 'failed',
            chunk_count: 0,
            estimated_duration_seconds: 0,
            message: error instanceof Error ? error.message : 'Unknown error'
          };
        }
      } else {
        audioRecoveryStatus = {
          status: 'none',
          chunk_count: 0,
          estimated_duration_seconds: 0,
          message: 'No folder path available'
        };
      }

      // 5. Convert StoredTranscripts to the format expected by storageService
      const formattedTranscripts = transcripts.map((t, index) => ({
        id: t.id?.toString() || `${Date.now()}-${index}`,
        text: t.text,
        timestamp: t.timestamp,
        sequence_id: t.sequenceId || index,
        chunk_start_time: (t as any).chunk_start_time,
        is_partial: (t as any).is_partial || false,
        confidence: t.confidence,
        audio_start_time: (t as any).audio_start_time,
        audio_end_time: (t as any).audio_end_time,
        duration: (t as any).duration,
        speaker: (t as any).speaker,
        speaker_label: (t as any).speaker_label,
        speaker_source: (t as any).speaker_source,
        speaker_confidence: (t as any).speaker_confidence,
      }));

      // 6. Save to backend database using existing save utilities
      const saveResponse = await storageService.saveMeeting(
        metadata.title,
        formattedTranscripts,
        folderPath ?? null
      );

      const savedMeetingId = saveResponse.meeting_id;

      try {
        await applyPinnedSummaryLanguageToMeeting(savedMeetingId);
      } catch (error) {
        console.warn('Failed to apply pinned summary language to recovered meeting:', error);
        toast.warning('Could not apply default summary language', {
          description: 'The recovered meeting was saved, but the default summary language was not applied.',
        });
      }

      if (audioRecoveryStatus?.status === "failed") {
        toast.warning("Transcript recovered; audio still needs attention", { description: "Original checkpoints were retained. Retry audio recovery before deleting this entry." });
        return { success: true, audioRecoveryStatus, meetingId: savedMeetingId };
      }

      // 7. Mark as saved in IndexedDB
      await indexedDBService.markMeetingSaved(meetingId);


      // Recovery retains source journals until explicitly committed.

      // 9. Remove from recoverable list
      setRecoverableMeetings(prev => prev.filter(m => m.meetingId !== meetingId));

      return {
        success: true,
        audioRecoveryStatus,
        meetingId: savedMeetingId
      };
    } catch (error) {
      console.error('Failed to recover meeting:', error);
      throw error;
    } finally {
      recovering.current = false;
      setIsRecovering(false);
    }
  }, [loadMeetingTranscripts]);

  /**
   * Delete a recoverable meeting
   */
  const deleteRecoverableMeeting = useCallback(async (meetingId: string): Promise<void> => {
    try {
      const disk = diskEntries.current.get(meetingId);
      if (disk?.folderPath) {
        if (!window.confirm('Permanently delete this interrupted recording, its audio checkpoints, and transcript files? This cannot be undone.')) return;
        await invoke('discard_capture_recovery', { meetingFolder: disk.folderPath });
        diskEntries.current.delete(meetingId);
      } else {
        await indexedDBService.deleteMeeting(meetingId);
      }
      setRecoverableMeetings(prev => prev.filter(m => m.meetingId !== meetingId));
    } catch (error) {
      console.error('Failed to delete meeting:', error);
      throw error;
    }
  }, []);

  return {
    recoverableMeetings,
    isLoading,
    isRecovering,
    checkForRecoverableTranscripts,
    recoverMeeting,
    loadMeetingTranscripts,
    deleteRecoverableMeeting
  };
}
