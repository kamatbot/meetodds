'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Feedback, SpanishProfile, SpanishSession, Turn, TutorResponse } from '@/lib/spanish';
import { wordDiff } from '@/lib/spanish';
import type { SpanishTutorMode, SpanishTutorReplyEvent } from '@/types/spanishTutor';
import { isCurrentSpanishReply, spanishReplyRate } from '@/types/spanishTutor';

type Status = 'listening' | 'thinking' | 'speaking' | 'practice' | 'paused' | null;
type Practice = { target: string; attempts: number; result: 'ok' | 'retry' | null; missed?: number[] };
type ActiveRequest = { id: string; mode: SpanishTutorMode; learnerText: string; spoken: boolean };
const describeError = (error: unknown) => typeof error === 'string' ? error : error instanceof Error ? error.message : 'Practice could not complete that step.';

/** Audio remains in the existing native commands. This hook owns only turn/event
 * ordering, small UI state, the stuck timer, and recovery/persistence boundaries. */
export function useSpanishTutor(profile: SpanishProfile, situation: string | null, onEnd: (session: SpanishSession) => void) {
  const sessionRef = useRef<SpanishSession>({ id: crypto.randomUUID(), profileId: profile.id, situation,
    startedAt: new Date().toISOString(), endedAt: null, turns: [], feedback: [], levelSignal: null });
  const [, setVersion] = useState(0);
  const bump = () => setVersion((value) => value + 1);
  const [status, setStatus] = useState<Status>('thinking');
  const [error, setError] = useState<string | null>(null);
  const [feedbackCard, setFeedbackCard] = useState<Feedback | null>(null);
  const [whyOpen, setWhyOpen] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [practice, setPractice] = useState<Practice | null>(null);
  const [helpText, setHelpText] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  const [allowExternal, setAllowExternal] = useState(false);
  const externalRef = useRef(false); externalRef.current = allowExternal;
  const [sceneDone, setSceneDone] = useState(false);
  const busyRef = useRef(true);
  const speakingRef = useRef(false);
  const modeRef = useRef<'conversation' | 'practice'>('conversation');
  const pendingRef = useRef('');
  const pendingSeedRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stuckRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const micOnRef = useRef(true);
  const endedRef = useRef(false);
  const sceneDoneRef = useRef(false);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<ActiveRequest | null>(null);
  const inflightRef = useRef(new Set<Promise<TutorResponse>>());
  const speechRef = useRef<Promise<void>>(Promise.resolve());
  const speechVersionRef = useRef(0);
  const runRef = useRef<(mode: SpanishTutorMode, text?: string) => Promise<void>>(async () => undefined);
  const finishRef = useRef<() => Promise<void>>(async () => undefined);
  const finalizePracticeRef = useRef<() => Promise<void>>(async () => undefined);
  const onEndRef = useRef(onEnd); onEndRef.current = onEnd;

  const clearStuck = () => { if (stuckRef.current) clearTimeout(stuckRef.current); stuckRef.current = null; };
  const clearPending = () => { if (timerRef.current) clearTimeout(timerRef.current); timerRef.current = null; pendingRef.current = ''; pendingSeedRef.current = null; };
  const idleStatus = (): Status => modeRef.current === 'practice' ? 'practice' : micOnRef.current ? 'listening' : 'paused';
  const addTurn = (role: Turn['role'], text: string) => {
    sessionRef.current = { ...sessionRef.current, turns: [...sessionRef.current.turns, { role, text }] }; bump();
  };
  const armStuck = () => {
    clearStuck();
    if (!micOnRef.current || endedRef.current || sceneDoneRef.current || modeRef.current !== 'conversation') return;
    stuckRef.current = setTimeout(() => {
      if (!pendingRef.current && !speakingRef.current && !endedRef.current) void runRef.current('stuck');
    }, 8000);
  };

  const speak = (text: string, rate: number, filler = false): Promise<void> => {
    clearStuck();
    const version = ++speechVersionRef.current;
    const previous = speechRef.current;
    const playback = (async () => {
      // Wait for the killed process's completion/tail handling before starting
      // another say call; an old completion must not reopen the mic mid-reply.
      await invoke('spanish_stop_speaking').catch(() => undefined);
      await previous.catch(() => undefined);
      if (endedRef.current || version !== speechVersionRef.current) return;
      speakingRef.current = true; busyRef.current = true; setStatus('speaking');
      try { await invoke('spanish_speak', { text, variety: profile.variety, rate }); }
      catch (reason) { if (!endedRef.current && version === speechVersionRef.current) setError(describeError(reason)); }
      finally {
        if (!endedRef.current && version === speechVersionRef.current) {
          speakingRef.current = false; busyRef.current = false; setStatus(idleStatus());
          if (!filler && text.trim().endsWith('?')) armStuck();
        }
      }
    })();
    speechRef.current = playback;
    return playback;
  };
  const speakRef = useRef(speak); speakRef.current = speak;

  const fetchSession = async () => {
    const sessions = await invoke<SpanishSession[]>('spanish_list_sessions', { profileId: profile.id, limit: 20 });
    const saved = sessions.find((session) => session.id === sessionRef.current.id);
    if (!saved) throw new Error('The saved practice session is unavailable.');
    return saved;
  };

  const runTurn = useCallback(async (mode: SpanishTutorMode, text = '') => {
    if (endedRef.current || sceneDoneRef.current) return;
    clearStuck();
    const previous = activeRef.current;
    if (mode === 'reply' && previous?.mode === 'reply' && !previous.spoken) {
      const turns = sessionRef.current.turns;
      if (turns.at(-1)?.role === 'learner') sessionRef.current = { ...sessionRef.current, turns: turns.slice(0, -1) };
    }
    const active: ActiveRequest = { id: crypto.randomUUID(), mode, learnerText: text, spoken: false };
    activeRef.current = active;
    busyRef.current = true; setStatus('thinking'); setError(null);
    if (mode === 'reply') { setFeedbackCard(null); if (text) addTurn('learner', text); }
    const pending = invoke<TutorResponse>('spanish_tutor_turn', { request: {
      profile, situation, history: sessionRef.current.turns.slice(-12), learnerText: text || null, mode,
      sessionId: sessionRef.current.id, requestId: active.id, allowExternalText: externalRef.current,
    } });
    inflightRef.current.add(pending);
    try {
      const response = await pending;
      if (endedRef.current || activeRef.current?.id !== active.id) return;
      const saved = await fetchSession();
      if (endedRef.current || activeRef.current?.id !== active.id) return;
      sessionRef.current = saved; bump();
      if (response.feedback) { setFeedbackCard(response.feedback); setWhyOpen(false); }
      if (response.sceneDone) {
        sceneDoneRef.current = true; setSceneDone(true); clearStuck();
        await speechRef.current;
        if (!endedRef.current && activeRef.current?.id === active.id) await finishRef.current();
      }
    } catch (reason) {
      if (!endedRef.current && activeRef.current?.id === active.id) {
        const message = describeError(reason);
        if (!message.toLowerCase().includes('cancelled')) setError(message);
      }
    } finally {
      inflightRef.current.delete(pending);
      if (!endedRef.current && activeRef.current?.id === active.id && !speakingRef.current) {
        busyRef.current = false; setStatus(idleStatus());
      }
    }
    // All volatile values used by an in-flight request are held in refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, situation]);
  runRef.current = runTurn;

  const finalizePractice = async () => {
    const text = pendingRef.current.trim(); clearPending();
    if (!text || !practice || endedRef.current) return;
    const diff = wordDiff(practice.target, text);
    const attempts = practice.attempts + 1;
    if (diff.score >= 0.8 || attempts >= 3) {
      modeRef.current = 'conversation';
      setPractice(null); setFeedbackCard(null);
      await speakRef.current(diff.score >= 0.8 ? '¡Muy bien!' : 'Casi. Sigamos.', 165);
      if (!endedRef.current) setStatus(idleStatus());
    } else {
      setPractice({ ...practice, attempts, result: 'retry', missed: diff.missedWordIndices });
      setStatus('practice');
    }
  };
  finalizePracticeRef.current = finalizePractice;

  const partial = (text: string) => {
    if (endedRef.current || !micOnRef.current || speakingRef.current || sceneDoneRef.current) return;
    clearStuck();
    const active = activeRef.current;
    if (modeRef.current === 'conversation' && active?.mode === 'reply' && !active.spoken && pendingSeedRef.current !== active.id) {
      // The learner continued before the tutor spoke: replace the old request
      // with the whole utterance, not only its trailing clause.
      pendingRef.current = active.learnerText; pendingSeedRef.current = active.id;
    }
    pendingRef.current = `${pendingRef.current} ${text}`.trim().slice(0, 4096);
    if (timerRef.current) clearTimeout(timerRef.current);
    const silence = modeRef.current === 'practice' ? 1500 : ({ beginner: 3200, intermediate: 2500, advanced: 1800 }[profile.level] ?? 2500);
    timerRef.current = setTimeout(() => {
      if (modeRef.current === 'practice') void finalizePracticeRef.current();
      else { const learnerText = pendingRef.current.trim(); clearPending(); if (learnerText) void runRef.current('reply', learnerText); }
    }, silence);
  };
  const partialRef = useRef(partial); partialRef.current = partial;

  useEffect(() => {
    let cancelled = false;
    endedRef.current = false;
    const subscriptions = [
      listen<SpanishTutorReplyEvent>('spanish-tutor-reply', ({ payload }) => {
        const active = activeRef.current;
        if (!active || !isCurrentSpanishReply(payload, sessionRef.current.id, active.id, cancelled || endedRef.current)) return;
        if (!payload.filler) {
          active.spoken = true;
          if (!payload.repeat) addTurn('tutor', payload.text);
          if (active.mode === 'help') setHelpText(payload.text);
        }
        void speakRef.current(payload.text, spanishReplyRate(payload, 165), Boolean(payload.filler));
      }),
      listen<{ text: string; tSec: number }>('spanish-partial', ({ payload }) => { if (!cancelled) partialRef.current(payload.text); }),
      listen<{ active: boolean }>('spanish-listening', ({ payload }) => {
        if (cancelled) return; micOnRef.current = payload.active; setMicOn(payload.active);
      }),
    ];
    (async () => {
      try {
        // Listener registration and initial persistence precede the synchronous
        // scripted opener, so that first early event cannot be lost.
        await Promise.all(subscriptions);
        if (cancelled) return;
        await invoke('spanish_save_session', { session: sessionRef.current });
        if (cancelled) return;
        await invoke('spanish_start_listening', { deviceName: null });
        if (!cancelled) await runRef.current('open');
      } catch (reason) { if (!cancelled) { busyRef.current = false; setStatus('paused'); setError(describeError(reason)); } }
    })();
    return () => {
      cancelled = true; endedRef.current = true; clearPending(); clearStuck(); ++speechVersionRef.current;
      void invoke('spanish_stop_listening').catch(() => undefined);
      void invoke('spanish_stop_speaking').catch(() => undefined);
      subscriptions.forEach((promise) => void promise.then((unsubscribe) => unsubscribe()).catch(() => undefined));
    };
    // The parent mounts a new keyed session for each learner/run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const turnCount = sessionRef.current.turns.length;
  useEffect(() => { transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [turnCount]);
  const lastTutorLine = [...sessionRef.current.turns].reverse().find((turn) => turn.role === 'tutor')?.text ?? null;

  const toggleMic = async () => {
    const next = !micOnRef.current; micOnRef.current = next; setMicOn(next); clearStuck();
    try {
      if (next) { await invoke('spanish_start_listening', { deviceName: null }); armStuck(); }
      else { clearPending(); await invoke('spanish_stop_listening'); }
    } catch (reason) { setError(describeError(reason)); }
    if (!speakingRef.current) setStatus(next ? 'listening' : 'paused');
  };
  const doSlower = async () => { if (lastTutorLine && !busyRef.current) await speakRef.current(lastTutorLine, 115); };
  const doRepeat = async () => { if (lastTutorLine && !busyRef.current) await speakRef.current(lastTutorLine, 115); };
  const doHelp = async () => { if (!speakingRef.current) await runRef.current('help'); };
  const startPracticeIt = async (target: string) => {
    if (busyRef.current) return;
    clearStuck(); clearPending(); modeRef.current = 'practice'; setPractice({ target, attempts: 0, result: null });
    await speakRef.current(target, 130); if (!endedRef.current) setStatus('practice');
  };
  const endSession = async () => {
    if (endedRef.current) return;
    endedRef.current = true; setEnding(true); clearPending(); clearStuck(); ++speechVersionRef.current;
    try {
      await invoke('spanish_stop_listening');
      await invoke('spanish_stop_speaking');
      await Promise.allSettled([...inflightRef.current]);
      const final = { ...sessionRef.current, endedAt: new Date().toISOString() };
      await invoke('spanish_save_session', { session: final });
      const saved = await fetchSession();
      sessionRef.current = saved; onEndRef.current(saved);
    } catch (reason) { endedRef.current = false; setEnding(false); setStatus('paused'); setError(describeError(reason)); }
  };
  finishRef.current = endSession;
  const statusLabel: Record<Exclude<Status, null>, string> = {
    listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking…', practice: 'Practice: repeat the phrase', paused: 'Mic paused',
  };
  return { sessionRef, status, statusLabel, error, feedbackCard, setFeedbackCard, whyOpen, setWhyOpen,
    micOn, practice, helpText, setHelpText, ending, transcriptEndRef, lastTutorLine, speak,
    toggleMic, doSlower, doRepeat, doHelp, startPracticeIt, endSession, allowExternal, setAllowExternal, sceneDone };
}
