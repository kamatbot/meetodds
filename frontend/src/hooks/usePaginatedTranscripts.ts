import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Transcript, MeetingMetadata, PaginatedTranscriptsResponse, TranscriptSegmentData } from "@/types";

const DEFAULT_PAGE_SIZE = 100;

interface UsePaginatedTranscriptsProps {
    meetingId: string | null;
    /** Optional initial timestamp (in seconds) from URL for loading the correct page */
    initialTimestamp?: number;
    /** Exact persisted transcript selected by an evidence link. */
    initialTranscriptId?: string | null;
}

interface UsePaginatedTranscriptsReturn {
    metadata: MeetingMetadata | null;
    segments: TranscriptSegmentData[];
    transcripts: Transcript[];
    isLoading: boolean;
    isLoadingMore: boolean;
    hasMore: boolean;
    totalCount: number;
    loadedCount: number;
    error: string | null;

    // Actions
    loadMore: () => Promise<void>;
    reset: () => void;
    refetch: () => Promise<void>;
}

/**
 * Convert Transcript array to TranscriptSegmentData for virtualized display
 */
function convertTranscriptsToSegments(transcripts: Transcript[]): TranscriptSegmentData[] {
    return transcripts.map(t => ({
        id: t.id,
        timestamp: t.audio_start_time ?? 0,
        endTime: t.audio_end_time,
        text: t.text,
        confidence: t.confidence,
        speaker: t.speaker,
        speaker_label: t.speaker_label,
        speaker_source: t.speaker_source,
        speaker_confidence: t.speaker_confidence,
    }));
}

export function usePaginatedTranscripts({
    meetingId,
    initialTimestamp,
    initialTranscriptId,
}: UsePaginatedTranscriptsProps): UsePaginatedTranscriptsReturn {
    const [metadata, setMetadata] = useState<MeetingMetadata | null>(null);
    const [transcripts, setTranscripts] = useState<Transcript[]>([]);
    const [totalCount, setTotalCount] = useState(0);
    const [isLoading, setIsLoading] = useState(true);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const offsetRef = useRef(0);
    const loadedMeetingIdRef = useRef<string | null>(null);
    const isLoadingRef = useRef(false);
    const lastLoadTimeRef = useRef(0); // Debounce protection
    const loadedEvidenceKeyRef = useRef<string | null>(null);
    const refreshRevisionRef = useRef(0);
    const currentMeetingIdRef = useRef(meetingId);
    currentMeetingIdRef.current = meetingId;

    // Reset state when meeting changes
    const reset = useCallback(() => {
        refreshRevisionRef.current += 1;
        setMetadata(null);
        setTranscripts([]);
        setTotalCount(0);
        setIsLoading(true);
        setIsLoadingMore(false);
        setHasMore(false);
        setError(null);
        offsetRef.current = 0;
        isLoadingRef.current = false;
    }, []);

    // Load meeting metadata
    const loadMetadata = useCallback(async (): Promise<MeetingMetadata | null> => {
        if (!meetingId) return null;

        try {
            const data = await invoke<MeetingMetadata>('api_get_meeting_metadata', {
                meetingId,
            });
            if (currentMeetingIdRef.current !== meetingId) return null;
            setMetadata(data);
            return data;
        } catch (err) {
            if (currentMeetingIdRef.current !== meetingId) return null;
            console.error('Failed to load meeting metadata:', err);
            setError('Failed to load meeting details');
            return null;
        }
    }, [meetingId]);

    // Load transcripts at specific offset
    const loadTranscriptsAtOffset = useCallback(async (
        offset: number,
        append: boolean = true
    ): Promise<Transcript[]> => {
        if (!meetingId) return [];
        const revision = refreshRevisionRef.current;

        try {
            const response = await invoke<PaginatedTranscriptsResponse>(
                'api_get_meeting_transcripts',
                {
                    meetingId,
                    limit: DEFAULT_PAGE_SIZE,
                    offset,
                }
            );

            const newTranscripts = response.transcripts;
            if (currentMeetingIdRef.current !== meetingId || revision !== refreshRevisionRef.current) return [];

            if (append) {
                setTranscripts(prev => {
                    // Deduplicate by id
                    const existingIds = new Set(prev.map(t => t.id));
                    const uniqueNew = newTranscripts.filter(t => !existingIds.has(t.id));
                    // Sort by audio_start_time
                    return [...prev, ...uniqueNew].sort((a, b) =>
                        (a.audio_start_time ?? 0) - (b.audio_start_time ?? 0)
                    );
                });
            } else {
                setTranscripts(newTranscripts);
            }

            setHasMore(response.has_more);
            setTotalCount(response.total_count);
            offsetRef.current = offset + newTranscripts.length;

            return newTranscripts;
        } catch (err) {
            if (currentMeetingIdRef.current !== meetingId || revision !== refreshRevisionRef.current) return [];
            console.error('Failed to load transcripts:', err);
            setError('Failed to load transcripts');
            return [];
        }
    }, [meetingId]);

    const loadThroughEvidence = useCallback(async (
        transcriptId?: string | null,
        timestamp?: number,
    ) => {
        if (!meetingId) return;
        const revision = refreshRevisionRef.current;
        const collected: Transcript[] = [];
        let offset = 0;
        let lastHasMore = false;
        let total = 0;

        while (true) {
            const response = await invoke<PaginatedTranscriptsResponse>(
                'api_get_meeting_transcripts',
                { meetingId, limit: DEFAULT_PAGE_SIZE, offset },
            );
            if (currentMeetingIdRef.current !== meetingId || revision !== refreshRevisionRef.current) return;
            total = response.total_count;
            lastHasMore = response.has_more;
            collected.push(...response.transcripts);

            const foundId = transcriptId
                ? response.transcripts.some((transcript) => transcript.id === transcriptId)
                : false;
            const foundTime = timestamp != null && Number.isFinite(timestamp)
                ? response.transcripts.some((transcript) => {
                    const start = transcript.audio_start_time;
                    const end = transcript.audio_end_time ?? start;
                    return start != null && end != null && timestamp >= start && timestamp <= end + 1;
                })
                : false;

            if (foundId || foundTime || !response.has_more || response.transcripts.length === 0) {
                break;
            }
            offset += response.transcripts.length;
        }

        const byId = new Map(collected.map((transcript) => [transcript.id, transcript]));
        const ordered = [...byId.values()].sort(
            (left, right) => (left.audio_start_time ?? 0) - (right.audio_start_time ?? 0),
        );
        setTranscripts(ordered);
        setTotalCount(total);
        setHasMore(lastHasMore);
        offsetRef.current = ordered.length;
    }, [meetingId]);

    // Load next page with debounce protection
    const loadMore = useCallback(async () => {
        const now = Date.now();
        // Debounce: require at least 100ms between calls
        if (now - lastLoadTimeRef.current < 100) {
            return;
        }

        if (isLoadingRef.current || !hasMore || !meetingId || isLoading) return;

        lastLoadTimeRef.current = now;
        const revision = refreshRevisionRef.current;
        isLoadingRef.current = true;
        setIsLoadingMore(true);
        try {
            await loadTranscriptsAtOffset(offsetRef.current, true);
        } finally {
            if (currentMeetingIdRef.current === meetingId && revision === refreshRevisionRef.current) {
                setIsLoadingMore(false);
                isLoadingRef.current = false;
            }
        }
    }, [hasMore, meetingId, loadTranscriptsAtOffset, isLoading]);

    // Refresh in place: speaker edits must not unmount the meeting, discard an
    // unsaved summary, close review, or reset the user's loaded transcript range.
    const refetch = useCallback(async () => {
        if (!meetingId) return;
        const revision = ++refreshRevisionRef.current;
        const targetCount = Math.max(DEFAULT_PAGE_SIZE, offsetRef.current);
        isLoadingRef.current = true;
        setIsLoadingMore(true);
        try {
            const nextMetadata = await invoke<MeetingMetadata>('api_get_meeting_metadata', { meetingId });
            const nextTranscripts: Transcript[] = [];
            let response: PaginatedTranscriptsResponse;
            do {
                response = await invoke<PaginatedTranscriptsResponse>('api_get_meeting_transcripts', {
                    meetingId, limit: DEFAULT_PAGE_SIZE, offset: nextTranscripts.length,
                });
                if (currentMeetingIdRef.current !== meetingId || revision !== refreshRevisionRef.current) return;
                if (response.has_more && response.transcripts.length === 0) {
                    throw new Error('Transcript refresh was incomplete. Please retry.');
                }
                nextTranscripts.push(...response.transcripts);
            } while (response.has_more && nextTranscripts.length < targetCount);
            setMetadata(nextMetadata);
            setTranscripts(nextTranscripts);
            setTotalCount(response.total_count);
            setHasMore(response.has_more);
            offsetRef.current = nextTranscripts.length;
            setError(null);
        } finally {
            if (currentMeetingIdRef.current === meetingId && revision === refreshRevisionRef.current) {
                isLoadingRef.current = false;
                setIsLoadingMore(false);
            }
        }
    }, [meetingId]);

    // Initial load
    useEffect(() => {
        if (!meetingId) {
            reset();
            return;
        }

        // Avoid reloading the same meeting
        if (loadedMeetingIdRef.current === meetingId) return;
        loadedMeetingIdRef.current = meetingId;

        const evidenceKey = initialTranscriptId || (initialTimestamp != null ? `time:${initialTimestamp}` : null);
        loadedEvidenceKeyRef.current = evidenceKey;
        reset();
        const revision = refreshRevisionRef.current;
        const ownsLoad = () => currentMeetingIdRef.current === meetingId && revision === refreshRevisionRef.current;

        const loadInitial = async () => {
            setIsLoading(true);
            try {
                await loadMetadata();
                if (!ownsLoad()) return;
                if (evidenceKey) {
                    await loadThroughEvidence(initialTranscriptId, initialTimestamp);
                } else {
                    await loadTranscriptsAtOffset(0, false);
                }
            } catch (initialError) {
                if (!ownsLoad()) return;
                console.error('Failed to load initial transcript evidence:', initialError);
                setError('Failed to load transcripts');
            } finally {
                if (ownsLoad()) setIsLoading(false);
            }
        };

        void loadInitial();
    }, [meetingId, reset, loadMetadata, loadTranscriptsAtOffset, loadThroughEvidence, initialTimestamp, initialTranscriptId]);

    // Evidence links can change while the same meeting route remains mounted.
    useEffect(() => {
        if (!meetingId) return;
        const evidenceKey = initialTranscriptId || (initialTimestamp != null ? `time:${initialTimestamp}` : null);
        if (!evidenceKey || loadedMeetingIdRef.current !== meetingId || loadedEvidenceKeyRef.current === evidenceKey) return;
        loadedEvidenceKeyRef.current = evidenceKey;
        const revision = ++refreshRevisionRef.current;
        let cancelled = false;
        const ownsLoad = () => !cancelled && currentMeetingIdRef.current === meetingId && revision === refreshRevisionRef.current;
        const loadEvidence = async () => {
            isLoadingRef.current = true;
            setIsLoadingMore(true);
            try {
                await loadThroughEvidence(initialTranscriptId, initialTimestamp);
            } catch (evidenceError) {
                if (ownsLoad()) setError('Could not load the cited transcript segment');
                console.error('Failed to load transcript evidence:', evidenceError);
            } finally {
                if (ownsLoad()) {
                    isLoadingRef.current = false;
                    setIsLoadingMore(false);
                    setIsLoading(false);
                }
            }
        };
        void loadEvidence();
        return () => { cancelled = true; };
    }, [initialTimestamp, initialTranscriptId, loadThroughEvidence, meetingId]);

    // Convert to segments (memoized)
    const segments = useMemo(() =>
        convertTranscriptsToSegments(transcripts),
        [transcripts]
    );

    return {
        metadata,
        segments,
        transcripts,
        isLoading,
        isLoadingMore,
        hasMore,
        totalCount,
        loadedCount: transcripts.length,
        error,
        loadMore,
        reset,
        refetch,
    };
}
