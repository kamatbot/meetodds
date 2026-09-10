'use client';

import { useCallback, useRef, useReducer, startTransition, useEffect, useState, memo } from "react";
import type { ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import { useTranscriptStreaming } from "@/hooks/useTranscriptStreaming";
import { ConfidenceIndicator } from "./ConfidenceIndicator";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { RecordingStatusBar } from "./RecordingStatusBar";
import { motion, AnimatePresence } from "framer-motion";
import { TranscriptSegmentData, TranscriptTranslationStatus } from "@/types";
import { TranslationDisplayMode } from "@/lib/live-translation";
import {
    describeSpeakerSource,
    getSpeakerPresentation,
} from "@/lib/speaker-labels";

export interface VirtualizedTranscriptViewProps {
    /** Transcript segments to display */
    segments: TranscriptSegmentData[];
    /** Whether recording is in progress */
    isRecording?: boolean;
    /** Whether recording is paused */
    isPaused?: boolean;
    /** Whether processing/finalizing transcription */
    isProcessing?: boolean;
    /** Whether stopping */
    isStopping?: boolean;
    /** Enable streaming effect for latest segment */
    enableStreaming?: boolean;
    /** Show confidence indicators */
    showConfidence?: boolean;
    /** Render translated text supplied by the non-blocking live translation hook */
    translationEnabled?: boolean;
    /** Show original plus translation, or replace original once translation arrives */
    translationDisplayMode?: TranslationDisplayMode;
    /** BCP-47 target language code for accessibility */
    translationTargetLanguage?: string;
    /** Completely disable auto-scroll behavior (for meeting details page) */
    disableAutoScroll?: boolean;

    // Pagination props (infinite scroll)
    hasMore?: boolean;
    isLoadingMore?: boolean;
    totalCount?: number;
    loadedCount?: number;
    onLoadMore?: () => void;
    /** Segment selected from a summary/memory evidence link. */
    focusSegmentId?: string | null;
    /** Optional, independent personal-note control; never mutates transcript text. */
    renderSegmentAction?: (segment: TranscriptSegmentData) => ReactNode;
}

// Threshold for enabling virtualization (below this, use simple rendering)
const VIRTUALIZATION_THRESHOLD = 10;

// Helper function to format seconds as recording-relative time [MM:SS]
function formatRecordingTime(seconds: number | undefined): string {
    if (seconds === undefined) return '[--:--]';

    const totalSeconds = Math.floor(seconds);
    const minutes = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;

    return `[${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}]`;
}

// Helper function to remove filler words and repetitions
function cleanStopWords(text: string): string {
    const stopWords = ['uh', 'um', 'er', 'ah', 'hmm', 'hm', 'eh', 'oh'];

    let cleanedText = text;
    stopWords.forEach(word => {
        const pattern = new RegExp(`\\b${word}\\b[,\\s]*`, 'gi');
        cleanedText = cleanedText.replace(pattern, ' ');
    });

    return cleanedText.replace(/\s+/g, ' ').trim();
}

const TranscriptSegment = memo(function TranscriptSegment({
    segment,
    id,
    timestamp,
    text,
    confidence,
    speaker: speakerId,
    speakerLabel,
    speakerSource,
    speakerConfidence,
    translatedText,
    translationStatus,
    translationError,
    translationEnabled,
    translationDisplayMode,
    translationTargetLanguage,
    isStreaming,
    showConfidence,
    isFocused,
    action,
    renderAction,
}: {
    segment?: TranscriptSegmentData;
    id: string;
    timestamp: number;
    text: string;
    confidence?: number;
    speaker?: string;
    speakerLabel?: string;
    speakerSource?: string;
    speakerConfidence?: number;
    translatedText?: string;
    translationStatus?: TranscriptTranslationStatus;
    translationError?: string;
    translationEnabled: boolean;
    translationDisplayMode: TranslationDisplayMode;
    translationTargetLanguage?: string;
    isStreaming: boolean;
    showConfidence: boolean;
    isFocused: boolean;
    action?: ReactNode;
    renderAction?: (segment: TranscriptSegmentData) => ReactNode;
}) {
    const actionContent = action ?? (renderAction && segment ? renderAction(segment) : null);
    const displayText = cleanStopWords(text) || (text.trim() === '' ? '[Silence]' : text);
    const showOriginal = !translationEnabled || translationDisplayMode === 'bilingual' || !translatedText;
    const isTranslationPending = translationEnabled && !translatedText &&
        (translationStatus === 'queued' || translationStatus === 'translating');
    const speaker = getSpeakerPresentation({
        speaker: speakerId,
        speaker_label: speakerLabel,
        speaker_source: speakerSource,
        speaker_confidence: speakerConfidence,
    });
    const sourceDescription = speaker ? describeSpeakerSource(speaker.source) : null;

    return (
        <div
            id={`segment-${id}`}
            className={`mb-3 rounded-control px-2 py-1 transition-colors ${isFocused ? 'bg-accent-soft ring-1 ring-accent/40' : ''}`}
            aria-label={`${speaker ? `${speaker.label}: ` : ''}${displayText}${translatedText ? `. Translation: ${translatedText}` : ''}`}
        >
            <div className="flex items-start gap-2">
                <Tooltip>
                    <TooltipTrigger>
                        <span className="text-xs text-gray-400 mt-1 flex-shrink-0 min-w-[50px]">
                            {formatRecordingTime(timestamp)}
                        </span>
                    </TooltipTrigger>
                    <TooltipContent className="space-y-1">
                        {confidence !== undefined && showConfidence && (
                            <ConfidenceIndicator confidence={confidence} showIndicator={showConfidence} />
                        )}
                        {speaker && sourceDescription && (
                            <div className="text-xs">
                                <div>{sourceDescription}</div>
                                {speaker.confidence !== null && (
                                    <div>Speaker confidence: {Math.round(speaker.confidence * 100)}%</div>
                                )}
                            </div>
                        )}
                    </TooltipContent>
                </Tooltip>
                <div
                    className={`flex-1 border-l-2 pl-3 ${speaker?.accentClassName ?? 'border-l-transparent'}`}
                >
                    {speaker && (
                        <div className="mb-1 flex items-center gap-2">
                            <span
                                className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${speaker.badgeClassName}`}
                            >
                                {speaker.label}
                            </span>
                            {speaker.isEstimate && (
                                <span className="text-[11px] text-gray-400">best estimate</span>
                            )}
                        </div>
                    )}
                    {showOriginal && (
                        isStreaming ? (
                            <div className="bg-gray-100 border border-gray-200 rounded-lg px-3 py-2">
                                <p className="text-base text-gray-800 leading-relaxed">{displayText}</p>
                            </div>
                        ) : (
                            <p className="text-base text-gray-800 leading-relaxed">{displayText}</p>
                        )
                    )}

                    {isTranslationPending && (
                        <div className={`${showOriginal ? 'mt-2' : ''} flex items-center gap-2 text-xs text-gray-400`}>
                            <span className="h-2 w-2 animate-pulse rounded-full bg-gray-300" />
                            Translating…
                        </div>
                    )}

                    {translationEnabled && translatedText && (
                        <div
                            lang={translationTargetLanguage}
                            dir="auto"
                            className={`${showOriginal ? 'mt-2 border-t border-gray-100 pt-2' : ''}`}
                        >
                            <p className="text-base font-medium leading-relaxed text-gray-900">
                                {translatedText}
                                {translationStatus === 'translating' && (
                                    <span className="ml-0.5 animate-pulse text-gray-400">▍</span>
                                )}
                            </p>
                        </div>
                    )}

                    {translationEnabled && translationStatus === 'error' && !translatedText && (
                        <p className="mt-2 text-xs text-gray-400" title={translationError}>
                            Translation unavailable
                        </p>
                    )}
                </div>
                {actionContent && <div className="shrink-0 pt-0.5">{actionContent}</div>}
            </div>
        </div>
    );
});

export const VirtualizedTranscriptView: React.FC<VirtualizedTranscriptViewProps> = ({
    segments,
    isRecording = false,
    isPaused = false,
    isProcessing = false,
    isStopping = false,
    enableStreaming = false,
    showConfidence = true,
    translationEnabled = false,
    translationDisplayMode = 'bilingual',
    translationTargetLanguage,
    disableAutoScroll = false,
    hasMore = false,
    isLoadingMore = false,
    totalCount = 0,
    loadedCount = 0,
    onLoadMore,
    focusSegmentId = null,
    renderSegmentAction,
}) => {
    // Create scroll ref first - shared between virtualizer and auto-scroll hook
    const scrollRef = useRef<HTMLDivElement>(null);
    // Ref for infinite scroll trigger element
    const loadMoreTriggerRef = useRef<HTMLDivElement>(null);

    // Force re-render without flushSync (avoids React warning)
    const [, rerender] = useReducer((x: number) => x + 1, 0);

    // Setup virtualizer for efficient rendering of large lists
    const virtualizer = useVirtualizer({
        count: segments.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => translationEnabled ? 136 : 88, // Translation adds a second text row
        overscan: 10, // Render extra items above/below viewport
        getItemKey: (index: number) => segments[index]?.id ?? index,
        onChange: () => {
            startTransition(() => {
                rerender();
            });
        },
    });

    useEffect(() => {
        if (!focusSegmentId) return;
        const index = segments.findIndex((segment) => segment.id === focusSegmentId);
        if (index < 0) return;

        if (segments.length >= VIRTUALIZATION_THRESHOLD) {
            virtualizer.scrollToIndex(index, { align: 'center' });
        } else {
            requestAnimationFrame(() => {
                document.getElementById(`segment-${focusSegmentId}`)?.scrollIntoView({
                    block: 'center',
                    behavior: 'smooth',
                });
            });
        }
    }, [focusSegmentId, segments, virtualizer]);

    // Custom hook for auto-scrolling (supports both virtualized and non-virtualized)
    useAutoScroll({
        scrollRef,
        segments,
        isRecording,
        isPaused,
        virtualizer,
        virtualizationThreshold: VIRTUALIZATION_THRESHOLD,
        disableAutoScroll,
    });

    // Streaming text effect hook (typewriter animation for new transcripts)
    const { streamingSegmentId, getDisplayText } = useTranscriptStreaming(
        segments,
        isRecording,
        enableStreaming
    );

    // Infinite scroll: IntersectionObserver to trigger loading more
    useEffect(() => {
        if (!onLoadMore || !hasMore || isLoadingMore || isRecording || segments.length === 0) {
            return;
        }

        const triggerElement = loadMoreTriggerRef.current;
        if (!triggerElement) return;

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting && hasMore && !isLoadingMore) {
                    onLoadMore();
                }
            },
            {
                root: null,
                rootMargin: '100px',
                threshold: 0,
            }
        );

        observer.observe(triggerElement);

        return () => observer.disconnect();
    }, [hasMore, isLoadingMore, onLoadMore, isRecording, segments.length]);

    // Scroll-based fallback for fast scrolling
    useEffect(() => {
        if (!onLoadMore || !hasMore || isLoadingMore || isRecording) return;

        const scrollElement = scrollRef.current;
        if (!scrollElement) return;

        let ticking = false;

        const handleScroll = () => {
            if (ticking || isLoadingMore || !hasMore) return;

            ticking = true;
            requestAnimationFrame(() => {
                const { scrollTop, scrollHeight, clientHeight } = scrollElement;
                const scrollBottom = scrollHeight - scrollTop - clientHeight;

                // Trigger load when within 200px of bottom
                if (scrollBottom < 200 && hasMore && !isLoadingMore) {
                    onLoadMore();
                }
                ticking = false;
            });
        };

        scrollElement.addEventListener('scroll', handleScroll, { passive: true });
        return () => scrollElement.removeEventListener('scroll', handleScroll);
    }, [onLoadMore, hasMore, isLoadingMore, isRecording]);

    // Use simple rendering for small lists, virtualization for large lists
    const useVirtualization = segments.length >= VIRTUALIZATION_THRESHOLD;

    return (
        <div ref={scrollRef} className="flex flex-col h-full overflow-y-auto px-4 py-2">
            {/* Recording Status Bar - Sticky at top, always visible when recording */}
            <AnimatePresence>
                {isRecording && (
                    <div className="sticky top-0 z-10 bg-white pb-2">
                        <RecordingStatusBar isPaused={isPaused} />
                    </div>
                )}
            </AnimatePresence>

            {/* Content - add padding when recording to prevent overlap */}
            <div className={isRecording ? 'pt-2' : ''}>
            {segments.length === 0 ? (
                // Empty state
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="text-center text-gray-500 mt-8"
                >
                    {isRecording ? (
                        <>
                            <div className="flex items-center justify-center mb-3">
                                <div className={`w-3 h-3 rounded-full ${isPaused ? 'bg-orange-500' : 'bg-blue-500 animate-pulse'}`}></div>
                            </div>
                            <p className="text-sm text-gray-600">
                                {isPaused ? 'Recording paused' : 'Listening for speech...'}
                            </p>
                            <p className="text-xs mt-1 text-gray-400">
                                {isPaused ? 'Click resume to continue recording' : 'Speak to see live transcription'}
                            </p>
                        </>
                    ) : (
                        <>
                            <p className="text-lg font-semibold">Welcome to MeetOdds!</p>
                            <p className="text-xs mt-1">Start recording to see live transcription</p>
                        </>
                    )}
                </motion.div>
            ) : useVirtualization ? (
                // Virtualized rendering for large lists
                <>
                    <div
                        style={{
                            height: virtualizer.getTotalSize(),
                            width: "100%",
                            position: "relative",
                        }}
                    >
                        {virtualizer.getVirtualItems().map((virtualRow) => {
                            const segment = segments[virtualRow.index];
                            const isStreaming = streamingSegmentId === segment.id;

                            return (
                                <div
                                    key={segment.id}
                                    data-index={virtualRow.index}
                                    ref={virtualizer.measureElement}
                                    style={{
                                        position: "absolute",
                                        top: 0,
                                        left: 0,
                                        width: "100%",
                                        transform: `translateY(${virtualRow.start}px)`,
                                    }}
                                >
                                    <TranscriptSegment
                                        id={segment.id}
                                        timestamp={segment.timestamp}
                                        text={getDisplayText(segment)}
                                        confidence={segment.confidence}
                                        speaker={segment.speaker}
                                        speakerLabel={segment.speaker_label}
                                        speakerSource={segment.speaker_source}
                                        speakerConfidence={segment.speaker_confidence}
                                        translatedText={segment.translated_text}
                                        translationStatus={segment.translation_status}
                                        translationError={segment.translation_error}
                                        translationEnabled={translationEnabled}
                                        translationDisplayMode={translationDisplayMode}
                                        translationTargetLanguage={translationTargetLanguage}
                                        isStreaming={isStreaming}
                                        showConfidence={showConfidence}
                                        isFocused={segment.id === focusSegmentId}
                                        segment={segment}
                                        renderAction={renderSegmentAction}
                                    />
                                </div>
                            );
                        })}
                    </div>

                    {/* Infinite scroll trigger and loading indicator */}
                    {(hasMore || isLoadingMore) && !isRecording && segments.length > 0 && (
                        <div ref={loadMoreTriggerRef} className="flex justify-center items-center py-4 mt-2">
                            {isLoadingMore ? (
                                <div className="flex items-center gap-2 text-gray-500">
                                    <div className="w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
                                    <span className="text-sm">Loading more...</span>
                                </div>
                            ) : hasMore && totalCount > 0 ? (
                                <span className="text-sm text-gray-400">
                                    Showing {loadedCount} of {totalCount} segments
                                </span>
                            ) : null}
                        </div>
                    )}

                    {/* Listening indicator when recording */}
                    {!isStopping && isRecording && !isPaused && !isProcessing && segments.length > 0 && (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="flex items-center gap-2 mt-4 text-gray-500"
                        >
                            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
                            <span className="text-sm">Listening...</span>
                        </motion.div>
                    )}
                </>
            ) : (
                // Simple rendering for small lists (better animations)
                <>
                    <div className="space-y-1">
                        {segments.map((segment) => {
                            const isStreaming = streamingSegmentId === segment.id;

                            return (
                                <motion.div
                                    key={segment.id}
                                    initial={{ opacity: 0, y: 5 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ duration: 0.15 }}
                                >
                                    <TranscriptSegment
                                        id={segment.id}
                                        timestamp={segment.timestamp}
                                        text={getDisplayText(segment)}
                                        confidence={segment.confidence}
                                        speaker={segment.speaker}
                                        speakerLabel={segment.speaker_label}
                                        speakerSource={segment.speaker_source}
                                        speakerConfidence={segment.speaker_confidence}
                                        translatedText={segment.translated_text}
                                        translationStatus={segment.translation_status}
                                        translationError={segment.translation_error}
                                        translationEnabled={translationEnabled}
                                        translationDisplayMode={translationDisplayMode}
                                        translationTargetLanguage={translationTargetLanguage}
                                        isStreaming={isStreaming}
                                        showConfidence={showConfidence}
                                        isFocused={segment.id === focusSegmentId}
                                        segment={segment}
                                        renderAction={renderSegmentAction}
                                    />
                                </motion.div>
                            );
                        })}
                    </div>

                    {/* Infinite scroll trigger (for small lists that grow) */}
                    {(hasMore || isLoadingMore) && !isRecording && segments.length > 0 && (
                        <div ref={loadMoreTriggerRef} className="flex justify-center items-center py-4 mt-2">
                            {isLoadingMore ? (
                                <div className="flex items-center gap-2 text-gray-500">
                                    <div className="w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
                                    <span className="text-sm">Loading more...</span>
                                </div>
                            ) : hasMore && totalCount > 0 ? (
                                <span className="text-sm text-gray-400">
                                    Showing {loadedCount} of {totalCount} segments
                                </span>
                            ) : null}
                        </div>
                    )}

                    {/* Listening indicator when recording */}
                    {!isStopping && isRecording && !isPaused && !isProcessing && segments.length > 0 && (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="flex items-center gap-2 mt-4 text-gray-500"
                        >
                            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
                            <span className="text-sm">Listening...</span>
                        </motion.div>
                    )}
                </>
            )}
            </div>
        </div>
    );
};
