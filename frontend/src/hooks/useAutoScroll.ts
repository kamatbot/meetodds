import { useRef, useState, useEffect, useCallback, RefObject } from "react";
import { Virtualizer } from "@tanstack/react-virtual";

interface UseAutoScrollProps {
    scrollRef: RefObject<HTMLDivElement | null>;
    segments: any[];
    isRecording: boolean;
    isPaused: boolean;
    activeSegmentId?: string;
    virtualizer?: Virtualizer<HTMLDivElement, Element>;
    virtualizationThreshold?: number;
    disableAutoScroll?: boolean; // Completely disable auto-scroll behavior (for meeting details page)
}

interface UseAutoScrollReturn {
    autoScroll: boolean;
    setAutoScroll: (value: boolean) => void;
    scrollToBottom: () => void;
}

// Threshold in pixels to consider "at the bottom"
const SCROLL_THRESHOLD = 100;

/**
 * Custom hook to manage auto-scrolling behavior for transcript
 *
 * Features:
 * - Auto-scrolls to bottom when new content arrives during recording
 * - Pauses auto-scroll when user manually scrolls up
 * - Resumes auto-scroll when user scrolls back to the bottom
 *
 * @param segments - Array of transcript segments
 * @param isRecording - Whether recording is in progress
 * @param isPaused - Whether recording is paused
 * @param activeSegmentId - ID of the currently active segment
 * @returns Scroll ref, auto-scroll state, and scroll control functions
 */
export function useAutoScroll({
    scrollRef,
    segments,
    isRecording,
    isPaused,
    activeSegmentId,
    virtualizer,
    virtualizationThreshold = 10,
    disableAutoScroll = false,
}: UseAutoScrollProps): UseAutoScrollReturn {
    const useVirtualization = virtualizer && segments.length >= virtualizationThreshold;
    const [autoScroll, setAutoScroll] = useState(true);
    // Ref to always have current autoScroll value in effects
    const autoScrollRef = useRef(autoScroll);
    autoScrollRef.current = autoScroll;

    // Track if user has manually scrolled (to disable auto-scroll temporarily)
    const userScrolledRef = useRef(false);
    // Track if we're doing a programmatic scroll
    const isProgrammaticScrollRef = useRef(false);
    // Track any pending programmatic scroll timeouts so they can be cancelled on user interaction
    const programmaticScrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Track previous segment count to detect new segments
    const prevSegmentCountRef = useRef(segments.length);

    const cancelProgrammaticScroll = useCallback(() => {
        if (programmaticScrollTimeoutRef.current) {
            clearTimeout(programmaticScrollTimeoutRef.current);
            programmaticScrollTimeoutRef.current = null;
        }
        isProgrammaticScrollRef.current = false;
    }, []);

    /**
     * Check if the user is scrolled near the bottom
     */
    const isNearBottom = useCallback(() => {
        if (!scrollRef.current) return true;
        const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
        return scrollHeight - scrollTop - clientHeight <= SCROLL_THRESHOLD;
    }, [scrollRef]);

    /**
     * Scroll to bottom programmatically
     */
    const scrollToBottom = useCallback(() => {
        if (scrollRef.current) {
            cancelProgrammaticScroll();
            isProgrammaticScrollRef.current = true;
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            userScrolledRef.current = false;
            setAutoScroll(true);

            programmaticScrollTimeoutRef.current = setTimeout(() => {
                isProgrammaticScrollRef.current = false;
                programmaticScrollTimeoutRef.current = null;
            }, 50);
        }
    }, [scrollRef, cancelProgrammaticScroll]);

    // Handle user gestures (wheel, touch, pointer, keys) to immediately cancel programmatic scroll lock
    useEffect(() => {
        const container = scrollRef.current;
        if (!container) return;

        const handleUserGesture = () => {
            cancelProgrammaticScroll();
            requestAnimationFrame(() => {
                if (!isNearBottom()) {
                    userScrolledRef.current = true;
                    setAutoScroll(false);
                }
            });
        };

        const handleKeyDown = (e: KeyboardEvent) => {
            if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) {
                cancelProgrammaticScroll();
                requestAnimationFrame(() => {
                    if (!isNearBottom()) {
                        userScrolledRef.current = true;
                        setAutoScroll(false);
                    }
                });
            }
        };

        container.addEventListener('wheel', handleUserGesture, { passive: true });
        container.addEventListener('touchmove', handleUserGesture, { passive: true });
        container.addEventListener('pointerdown', handleUserGesture, { passive: true });
        container.addEventListener('keydown', handleKeyDown, { passive: true });

        return () => {
            container.removeEventListener('wheel', handleUserGesture);
            container.removeEventListener('touchmove', handleUserGesture);
            container.removeEventListener('pointerdown', handleUserGesture);
            container.removeEventListener('keydown', handleKeyDown);
        };
    }, [scrollRef, cancelProgrammaticScroll, isNearBottom]);

    // Handle scroll events to detect manual scrolling
    useEffect(() => {
        const container = scrollRef.current;
        if (!container) return;

        let scrollTimeout: ReturnType<typeof setTimeout> | null = null;

        const handleScroll = () => {
            // Skip if this is a programmatic scroll
            if (isProgrammaticScrollRef.current) {
                return;
            }

            // Debounce scroll handling to prevent rapid state changes
            if (scrollTimeout) {
                clearTimeout(scrollTimeout);
            }

            scrollTimeout = setTimeout(() => {
                // Check if user is near bottom
                const nearBottom = isNearBottom();

                if (nearBottom) {
                    // User scrolled to bottom - re-enable auto-scroll
                    userScrolledRef.current = false;
                    setAutoScroll(true);
                } else {
                    // User scrolled away from bottom - disable auto-scroll
                    userScrolledRef.current = true;
                    setAutoScroll(false);
                }
            }, 60);
        };

        container.addEventListener("scroll", handleScroll, { passive: true });

        return () => {
            container.removeEventListener("scroll", handleScroll);
            if (scrollTimeout) {
                clearTimeout(scrollTimeout);
            }
        };
    }, [isNearBottom, scrollRef]);

    // Auto-scroll to bottom when new segments arrive during recording
    useEffect(() => {
        // EARLY RETURN: If auto-scroll is completely disabled (e.g., meeting details page)
        if (disableAutoScroll) {
            return;
        }

        const segmentCount = segments.length;
        const prevCount = prevSegmentCountRef.current;
        const hasNewSegments = segmentCount > prevCount;

        // Update the ref for next comparison
        prevSegmentCountRef.current = segmentCount;

        // The post-render scroll height includes the new segment, so checking the
        // current geometry here would falsely classify an untouched view as scrolled up.
        // `autoScrollRef` is updated only from deliberate user scrolling.
        if (hasNewSegments && autoScrollRef.current && isRecording && !isPaused && segmentCount > 0) {
            cancelProgrammaticScroll();
            isProgrammaticScrollRef.current = true;

            if (useVirtualization && virtualizer) {
                // Use scrollToOffset with a large value to ensure we're at the bottom
                const totalSize = virtualizer.getTotalSize();
                virtualizer.scrollToOffset(totalSize + 1000, { align: "end" });

                // Also set scrollTop directly as backup after virtualizer updates
                programmaticScrollTimeoutRef.current = setTimeout(() => {
                    if (scrollRef.current) {
                        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
                    }
                    isProgrammaticScrollRef.current = false;
                    programmaticScrollTimeoutRef.current = null;
                }, 50);
            } else if (scrollRef.current) {
                scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
                programmaticScrollTimeoutRef.current = setTimeout(() => {
                    isProgrammaticScrollRef.current = false;
                    programmaticScrollTimeoutRef.current = null;
                }, 50);
            }
        }
    }, [segments.length, isRecording, isPaused, useVirtualization, virtualizer, scrollRef, cancelProgrammaticScroll, disableAutoScroll]);

    // Auto-scroll to active segment (when clicking on search results, etc.)
    useEffect(() => {
        if (activeSegmentId) {
            isProgrammaticScrollRef.current = true;

            if (useVirtualization && virtualizer) {
                const index = segments.findIndex((s: any) => s.id === activeSegmentId);
                if (index >= 0) {
                    virtualizer.scrollToIndex(index, { align: "center", behavior: "smooth" });
                }
            } else {
                const element = document.getElementById(`segment-${activeSegmentId}`);
                if (element) {
                    element.scrollIntoView({ behavior: "smooth", block: "center" });
                }
            }

            // Reset the flag after scroll animation completes
            setTimeout(() => {
                isProgrammaticScrollRef.current = false;
            }, 500);
        }
    }, [activeSegmentId, useVirtualization, virtualizer, segments]);

    // Clean up any pending programmatic scroll on unmount
    useEffect(() => {
        return () => cancelProgrammaticScroll();
    }, [cancelProgrammaticScroll]);

    return {
        autoScroll,
        setAutoScroll,
        scrollToBottom,
    };
}
