'use client';

// Spanish practice feature - full screen, no app providers (see layout.tsx branch for '/spanish').
// One file per the ponytail brief: profiles -> start -> session -> recap, all as local screens.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  ArrowLeft,
  ChevronDown,
  LoaderCircle,
  Mic,
  MicOff,
  Pencil,
  Plus,
  Settings,
  Sparkles,
  Trash2,
  Volume2,
  X,
} from 'lucide-react';
import {
  ClassMeeting,
  Feedback,
  LessonBrief,
  LEVELS,
  Level,
  Readiness,
  SITUATIONS,
  SpanishProfile,
  SpanishSession,
  Turn,
  Variety,
  VARIETIES,
  nextLevel,
  similarity,
} from '@/lib/spanish';

type Screen = 'profiles' | 'start' | 'session' | 'recap';

function describeError(e: unknown): string {
  return typeof e === 'string' ? e : e instanceof Error ? e.message : 'Something went wrong.';
}

const cardBase = 'horizon-card p-5 text-left transition-colors hover:border-[color:var(--text-3)]';
const segBtn = (active: boolean) =>
  `h-9 flex-1 rounded-[10px] border text-[12.5px] font-medium transition-colors ${
    active ? 'border-accent bg-accent-soft text-accent' : 'border-border bg-panel text-2 hover:text-text'
  }`;

export default function SpanishPractice() {
  const router = useRouter();
  const [screen, setScreen] = useState<Screen>('profiles');
  const [profiles, setProfiles] = useState<SpanishProfile[]>([]);
  const [activeProfile, setActiveProfile] = useState<SpanishProfile | null>(null);
  const [sessions, setSessions] = useState<SpanishSession[]>([]);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingSituation, setPendingSituation] = useState<string | null>(null);
  const [recapSession, setRecapSession] = useState<SpanishSession | null>(null);
  const [sessionNonce, setSessionNonce] = useState(0);

  const loadProfiles = useCallback(async () => {
    try {
      const list = await invoke<SpanishProfile[]>('spanish_list_profiles');
      setProfiles(list);
    } catch (e) {
      setLoadError(describeError(e));
    }
  }, []);

  useEffect(() => {
    void loadProfiles();
    invoke<Readiness>('spanish_check_readiness').then(setReadiness).catch(() => undefined);
  }, [loadProfiles]);

  const openProfile = useCallback(async (profile: SpanishProfile) => {
    setActiveProfile(profile);
    setScreen('start');
    try {
      const list = await invoke<SpanishSession[]>('spanish_list_sessions', { profileId: profile.id, limit: 20 });
      setSessions(list);
    } catch (e) {
      setLoadError(describeError(e));
      setSessions([]);
    }
  }, []);

  const startSession = useCallback((situation: string | null) => {
    setPendingSituation(situation);
    setSessionNonce((n) => n + 1);
    setScreen('session');
  }, []);

  const handleSessionEnd = useCallback((session: SpanishSession) => {
    setRecapSession(session);
    setScreen('recap');
  }, []);

  const handleProfileLevelUpdate = useCallback((updated: SpanishProfile) => {
    setActiveProfile(updated);
    setProfiles((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
  }, []);

  if (screen === 'profiles' || !activeProfile) {
    return (
      <ProfilesScreen
        router={router}
        profiles={profiles}
        readiness={readiness}
        loadError={loadError}
        onProfilesChange={setProfiles}
        onOpenProfile={(p) => void openProfile(p)}
      />
    );
  }

  if (screen === 'start') {
    return (
      <StartScreen
        profile={activeProfile}
        sessions={sessions}
        onBack={() => setScreen('profiles')}
        onStart={startSession}
      />
    );
  }

  if (screen === 'session') {
    return (
      <SessionScreen
        key={`${activeProfile.id}-${sessionNonce}`}
        profile={activeProfile}
        situation={pendingSituation}
        onEnd={handleSessionEnd}
      />
    );
  }

  return (
    <RecapScreen
      profile={activeProfile}
      session={recapSession!}
      onProfileLevelUpdate={handleProfileLevelUpdate}
      onPracticeAgain={() => setScreen('start')}
      onDone={() => setScreen('profiles')}
    />
  );
}

// ---------------------------------------------------------------------------
// A. Profiles
// ---------------------------------------------------------------------------

function ProfilesScreen({
  router,
  profiles,
  readiness,
  loadError,
  onProfilesChange,
  onOpenProfile,
}: {
  router: ReturnType<typeof useRouter>;
  profiles: SpanishProfile[];
  readiness: Readiness | null;
  loadError: string | null;
  onProfilesChange: (profiles: SpanishProfile[]) => void;
  onOpenProfile: (profile: SpanishProfile) => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<SpanishProfile | null>(null);
  const [name, setName] = useState('');
  const [level, setLevel] = useState<Level>('beginner');
  const [variety, setVariety] = useState<Variety>('es_MX');
  const [topics, setTopics] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const openAddForm = () => {
    setEditing(null);
    setName('');
    setLevel('beginner');
    setVariety('es_MX');
    setTopics('');
    setFormError(null);
    setShowForm(true);
  };

  const openEditForm = (profile: SpanishProfile) => {
    setEditing(profile);
    setName(profile.name);
    setLevel(profile.level);
    setVariety(profile.variety);
    setTopics(profile.topics.join(', '));
    setFormError(null);
    setShowForm(true);
  };

  const saveProfile = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setFormError('Name is required.');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const topicList = topics.split(',').map((t) => t.trim()).filter(Boolean);
      const saved = await invoke<SpanishProfile>('spanish_save_profile', {
        profile: {
          id: editing?.id ?? '',
          name: trimmed,
          level,
          variety,
          topics: topicList,
        },
      });
      const next = editing
        ? profiles.map((p) => (p.id === saved.id ? saved : p))
        : [...profiles, saved];
      onProfilesChange(next);
      setShowForm(false);
    } catch (e) {
      setFormError(describeError(e));
    } finally {
      setSaving(false);
    }
  };

  const deleteProfile = async (profile: SpanishProfile) => {
    if (!confirm(`Remove ${profile.name}'s Spanish practice profile? This cannot be undone.`)) return;
    try {
      await invoke('spanish_delete_profile', { id: profile.id });
      onProfilesChange(profiles.filter((p) => p.id !== profile.id));
    } catch (e) {
      setFormError(describeError(e));
    }
  };

  const showReadinessBanner = readiness && (!readiness.whisperReady || !readiness.llmReady);

  return (
    <div className="flex h-screen w-screen flex-col overflow-y-auto bg-bg text-text custom-scrollbar">
      <div data-tauri-drag-region className="h-[52px] shrink-0" aria-hidden="true" />
      <div className="mx-auto w-full max-w-[640px] flex-1 px-6 pb-16">
        <button
          type="button"
          onClick={() => router.push('/')}
          aria-label="Back to MeetOdds"
          className="mb-6 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-2 hover:text-text"
        >
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.8} />
          Back to MeetOdds
        </button>

        <h1 className="text-display text-text">Who&apos;s practicing?</h1>
        <p className="mt-1 text-body text-2">Pick a family member, or add a new Spanish learner.</p>

        {showReadinessBanner && readiness && (
          <div className="mt-5 flex items-start gap-3 rounded-[11px] border border-warn/30 bg-warn/10 p-3.5 text-[12.5px] text-text">
            <div className="min-w-0 flex-1">
              {!readiness.whisperReady && <p>Pick a multilingual Whisper model in Settings so the tutor can hear you.</p>}
              {readiness.whisperReady && !readiness.llmReady && <p>{readiness.message ?? 'Set up an AI model in Settings to power the tutor.'}</p>}
            </div>
            <button
              type="button"
              onClick={() => router.push('/settings')}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-[9px] border border-border bg-panel px-2.5 py-1 text-[11.5px] font-medium text-text hover:bg-[var(--hover)]"
            >
              <Settings className="h-3.5 w-3.5" strokeWidth={1.8} />
              Open Settings
            </button>
          </div>
        )}

        {loadError && <p className="mt-4 text-[12.5px] text-danger">{loadError}</p>}

        <div className="mt-6 grid gap-2">
          {profiles.map((profile) => (
            <div key={profile.id} className={`${cardBase} flex items-center gap-3 p-4`}>
              <button
                type="button"
                onClick={() => onOpenProfile(profile)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-accent-soft text-[15px] font-semibold text-accent">
                  {profile.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14.5px] font-semibold text-text">{profile.name}</span>
                  <span className="mt-0.5 flex items-center gap-1.5">
                    <span className="rounded-[6px] bg-panel-2 px-1.5 py-0.5 text-[10.5px] font-medium text-2">
                      {LEVELS.find((l) => l.value === profile.level)?.label ?? profile.level}
                    </span>
                    <span className="rounded-[6px] bg-panel-2 px-1.5 py-0.5 text-[10.5px] font-medium text-2">
                      {VARIETIES.find((v) => v.value === profile.variety)?.label ?? profile.variety}
                    </span>
                  </span>
                </span>
              </button>
              <button
                type="button"
                aria-label={`Edit ${profile.name}`}
                onClick={() => openEditForm(profile)}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-[9px] text-2 hover:bg-[var(--hover)] hover:text-text"
              >
                <Pencil className="h-3.5 w-3.5" strokeWidth={1.8} />
              </button>
              <button
                type="button"
                aria-label={`Delete ${profile.name}`}
                onClick={() => void deleteProfile(profile)}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-[9px] text-2 hover:bg-[var(--hover)] hover:text-danger"
              >
                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} />
              </button>
            </div>
          ))}

          {profiles.length === 0 && !showForm && (
            <div className="horizon-card p-8 text-center">
              <p className="text-[13.5px] font-medium text-2">No learning profiles yet</p>
              <button
                type="button"
                onClick={openAddForm}
                className="horizon-button mx-auto mt-4 inline-flex items-center gap-1.5 bg-accent px-4 text-accent-foreground"
              >
                <Plus className="h-4 w-4" strokeWidth={1.8} />
                Add a family member
              </button>
            </div>
          )}
        </div>

        {profiles.length > 0 && !showForm && (
          <button
            type="button"
            onClick={openAddForm}
            className="mt-3 inline-flex items-center gap-1.5 rounded-[10px] border border-border bg-panel px-3 py-2 text-[12.5px] font-medium text-text hover:bg-[var(--hover)]"
          >
            <Plus className="h-4 w-4" strokeWidth={1.8} />
            Add a family member
          </button>
        )}

        {showForm && (
          <div className="horizon-card mt-4 p-5">
            <h2 className="horizon-eyebrow mb-3">{editing ? 'Edit profile' : 'New profile'}</h2>
            <label htmlFor="spanish-profile-name" className="mb-1 block text-[11.5px] font-medium text-2">
              Name
            </label>
            <input
              id="spanish-profile-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              className="h-9 w-full rounded-[10px] border border-border bg-bg px-3 text-[13.5px] text-text focus:outline-none"
              placeholder="e.g. Sofia"
            />

            <p className="mb-1 mt-3 text-[11.5px] font-medium text-2">Level</p>
            <div className="flex gap-1.5">
              {LEVELS.map((l) => (
                <button key={l.value} type="button" onClick={() => setLevel(l.value)} className={segBtn(level === l.value)}>
                  {l.label}
                </button>
              ))}
            </div>

            <p className="mb-1 mt-3 text-[11.5px] font-medium text-2">Spanish</p>
            <div className="flex gap-1.5">
              {VARIETIES.map((v) => (
                <button key={v.value} type="button" onClick={() => setVariety(v.value)} className={segBtn(variety === v.value)}>
                  {v.label}
                </button>
              ))}
            </div>

            <label htmlFor="spanish-profile-topics" className="mb-1 mt-3 block text-[11.5px] font-medium text-2">
              Topics they like
            </label>
            <input
              id="spanish-profile-topics"
              value={topics}
              onChange={(e) => setTopics(e.target.value)}
              className="h-9 w-full rounded-[10px] border border-border bg-bg px-3 text-[13.5px] text-text focus:outline-none"
              placeholder="fútbol, cocina, videojuegos"
            />

            {formError && <p className="mt-2 text-[12px] text-danger">{formError}</p>}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="h-9 rounded-[10px] border border-border bg-surface px-3 text-[12.5px] font-medium text-text"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void saveProfile()}
                className="h-9 rounded-[10px] bg-accent px-4 text-[12.5px] font-semibold text-accent-foreground disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// B. Start
// ---------------------------------------------------------------------------

function StartScreen({
  profile,
  sessions,
  onBack,
  onStart,
}: {
  profile: SpanishProfile;
  sessions: SpanishSession[];
  onBack: () => void;
  onStart: (situation: string | null) => void;
}) {
  const [showSituations, setShowSituations] = useState(false);
  const [speakingPhrase, setSpeakingPhrase] = useState<string | null>(null);
  const [speakError, setSpeakError] = useState<string | null>(null);
  const [showClasses, setShowClasses] = useState(false);
  const [classes, setClasses] = useState<ClassMeeting[] | null>(null);
  const [classError, setClassError] = useState<string | null>(null);
  const [buildingId, setBuildingId] = useState<string | null>(null);
  const [lesson, setLesson] = useState<LessonBrief | null>(null);

  const toggleClasses = async () => {
    const next = !showClasses;
    setShowClasses(next);
    if (next && classes === null) {
      try {
        setClasses(await invoke<ClassMeeting[]>('spanish_list_class_meetings', { limit: 30 }));
      } catch (e) {
        setClassError(describeError(e));
        setClasses([]);
      }
    }
  };

  const buildLesson = async (meeting: ClassMeeting) => {
    setClassError(null);
    setBuildingId(meeting.id);
    setLesson(null);
    try {
      setLesson(await invoke<LessonBrief>('spanish_build_lesson', { meetingId: meeting.id }));
    } catch (e) {
      setClassError(describeError(e));
    } finally {
      setBuildingId(null);
    }
  };

  const lastSession = sessions[0] ?? null;
  const lastCorrections = lastSession ? lastSession.feedback.filter((f) => f.kind === 'correction').length : 0;

  const practicePhrases = useMemo(() => {
    const seen = new Set<string>();
    const phrases: string[] = [];
    for (const session of sessions) {
      for (const f of session.feedback) {
        if (f.kind !== 'correction' || !f.tryThis || seen.has(f.tryThis)) continue;
        seen.add(f.tryThis);
        phrases.push(f.tryThis);
        if (phrases.length >= 5) return phrases;
      }
    }
    return phrases;
  }, [sessions]);

  const hearPhrase = async (text: string) => {
    setSpeakError(null);
    setSpeakingPhrase(text);
    try {
      await invoke('spanish_speak', { text, variety: profile.variety, rate: 165 });
    } catch (e) {
      setSpeakError(describeError(e));
    } finally {
      setSpeakingPhrase(null);
    }
  };

  return (
    <div className="flex h-screen w-screen flex-col overflow-y-auto bg-bg text-text custom-scrollbar">
      <div data-tauri-drag-region className="h-[52px] shrink-0" aria-hidden="true" />
      <div className="mx-auto w-full max-w-[640px] flex-1 px-6 pb-16">
        <button
          type="button"
          onClick={onBack}
          className="mb-6 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-2 hover:text-text"
        >
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.8} />
          Profiles
        </button>

        <h1 className="text-display text-text">Hola, {profile.name}</h1>
        <p className="mt-1 text-body text-2">What do you want to practice today?</p>

        {speakError && <p className="mt-3 text-[12.5px] text-danger">{speakError}</p>}

        <div className="mt-6 grid gap-3">
          {lastSession && (
            <button type="button" onClick={() => onStart(lastSession.situation)} className={cardBase}>
              <h2 className="text-[15px] font-semibold text-text">Continue practicing</h2>
              <p className="mt-1 text-[12.5px] text-2">
                {lastSession.situation ?? 'Just talking'} · Last time: {lastCorrections} correction{lastCorrections === 1 ? '' : 's'}
              </p>
              {practicePhrases.length > 0 && (
                <div className="mt-3 grid gap-1.5" onClick={(e) => e.stopPropagation()}>
                  <p className="horizon-eyebrow">Phrases you&apos;re practicing</p>
                  {practicePhrases.map((phrase) => (
                    <div key={phrase} className="flex items-center gap-2 rounded-[9px] bg-panel-2 px-2.5 py-1.5">
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-text">{phrase}</span>
                      <button
                        type="button"
                        aria-label={`Hear "${phrase}"`}
                        onClick={() => void hearPhrase(phrase)}
                        className="grid h-6 w-6 shrink-0 place-items-center rounded-[7px] text-2 hover:bg-[var(--hover)] hover:text-text"
                      >
                        {speakingPhrase === phrase ? (
                          <LoaderCircle className="h-3.5 w-3.5 animate-spin" strokeWidth={1.8} />
                        ) : (
                          <Volume2 className="h-3.5 w-3.5" strokeWidth={1.8} />
                        )}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </button>
          )}

          <div className={cardBase}>
            <button type="button" onClick={() => setShowSituations((v) => !v)} className="flex w-full items-center justify-between">
              <span className="text-[15px] font-semibold text-text">Choose a situation</span>
              <ChevronDown className={`h-4 w-4 text-2 transition-transform ${showSituations ? 'rotate-180' : ''}`} strokeWidth={1.8} />
            </button>
            {showSituations && (
              <div className="mt-3 grid grid-cols-2 gap-2">
                {SITUATIONS.map((situation) => (
                  <button
                    key={situation}
                    type="button"
                    onClick={() => onStart(situation)}
                    className="rounded-[10px] border border-border bg-panel-2 px-3 py-2.5 text-left text-[12.5px] font-medium text-text hover:border-[color:var(--text-3)]"
                  >
                    {situation}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className={cardBase}>
            <button type="button" onClick={() => void toggleClasses()} className="flex w-full items-center justify-between">
              <span className="text-left">
                <span className="block text-[15px] font-semibold text-text">From a class recording</span>
                <span className="mt-1 block text-[12.5px] text-2">Practice what was covered in a recorded Spanish class.</span>
              </span>
              <ChevronDown className={`h-4 w-4 shrink-0 text-2 transition-transform ${showClasses ? 'rotate-180' : ''}`} strokeWidth={1.8} />
            </button>
            {showClasses && !lesson && (
              <div className="mt-3 grid gap-1.5">
                {classes === null && <p className="text-[12.5px] text-2">Loading recordings…</p>}
                {classes !== null && classes.length === 0 && (
                  <p className="text-[12.5px] text-2">No recordings with a transcript yet. Record a class with MeetOdds first, then come back here.</p>
                )}
                {classes?.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    disabled={buildingId !== null}
                    onClick={() => void buildLesson(m)}
                    className="flex items-center justify-between gap-3 rounded-[10px] border border-border bg-panel-2 px-3 py-2.5 text-left hover:border-[color:var(--text-3)] disabled:opacity-60"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium text-text">{m.title}</span>
                      <span className="block text-[11.5px] text-3">{new Date(m.createdAt).toLocaleDateString()} · {m.segments} lines</span>
                    </span>
                    {buildingId === m.id ? (
                      <span className="inline-flex shrink-0 items-center gap-1.5 text-[11.5px] text-2"><LoaderCircle className="h-3.5 w-3.5 animate-spin" /> Building lesson…</span>
                    ) : (
                      <span className="shrink-0 text-[11.5px] font-medium text-accent">Use this class</span>
                    )}
                  </button>
                ))}
              </div>
            )}
            {lesson && (
              <div className="mt-3">
                <p className="horizon-eyebrow mb-1">Lesson from “{lesson.title}”</p>
                {lesson.topic && <p className="text-[17px] font-semibold text-text">{lesson.topic}</p>}
                <ul className="mt-2 grid gap-1">
                  {lesson.phrases.map((ph) => (
                    <li key={ph.es} className="flex items-center justify-between gap-2 rounded-[10px] bg-panel-2 px-3 py-2">
                      <span className="min-w-0">
                        <span className="block text-[16px] font-medium text-text">{ph.es}</span>
                        {ph.en && <span className="block text-[12px] text-2">{ph.en}</span>}
                      </span>
                      <button type="button" aria-label={`Hear "${ph.es}"`} onClick={() => void hearPhrase(ph.es)} className="shrink-0 text-2 hover:text-text">
                        {speakingPhrase === ph.es ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Volume2 className="h-4 w-4" strokeWidth={1.8} />}
                      </button>
                    </li>
                  ))}
                </ul>
                {lesson.grammar.length > 0 && (
                  <p className="mt-2 text-[12.5px] text-2"><span className="font-medium text-text">Grammar: </span>{lesson.grammar.join(' · ')}</p>
                )}
                <div className="mt-3 flex gap-2">
                  <button type="button" onClick={() => onStart(lesson.situation)} className="rounded-[10px] bg-accent px-4 py-2 text-[13.5px] font-semibold text-accent-foreground">
                    Start practicing
                  </button>
                  <button type="button" onClick={() => setLesson(null)} className="rounded-[10px] border border-border bg-panel px-3 py-2 text-[13.5px] font-medium text-text hover:bg-[var(--hover)]">
                    Pick another class
                  </button>
                </div>
              </div>
            )}
            {classError && <p className="mt-2 text-[12px] text-danger">{classError}</p>}
          </div>

          <button type="button" onClick={() => onStart(null)} className={cardBase}>
            <h2 className="text-[15px] font-semibold text-text">Just talk</h2>
            <p className="mt-1 text-[12.5px] text-2">Open conversation, no set topic.</p>
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// C. Session
// ---------------------------------------------------------------------------

type Status = 'listening' | 'thinking' | 'speaking' | 'practice' | 'paused' | null;

function SessionScreen({
  profile,
  situation,
  onEnd,
}: {
  profile: SpanishProfile;
  situation: string | null;
  onEnd: (session: SpanishSession) => void;
}) {
  const sessionRef = useRef<SpanishSession>({
    id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`,
    profileId: profile.id,
    situation,
    startedAt: new Date().toISOString(),
    endedAt: null,
    turns: [],
    feedback: [],
    levelSignal: null,
  });
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);

  const [status, setStatus] = useState<Status>('thinking');
  const [error, setError] = useState<string | null>(null);
  const [feedbackCard, setFeedbackCard] = useState<Feedback | null>(null);
  const [whyOpen, setWhyOpen] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [practice, setPractice] = useState<{ target: string; attempts: number; result: 'ok' | 'retry' | null } | null>(null);
  const [helpText, setHelpText] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);

  const busyRef = useRef(true);
  const modeRef = useRef<'conversation' | 'practice'>('conversation');
  const pendingRef = useRef('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const micOnRef = useRef(true);
  const endedRef = useRef(false);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  const addTurn = (role: Turn['role'], text: string) => {
    sessionRef.current = { ...sessionRef.current, turns: [...sessionRef.current.turns, { role, text }] };
    bump();
  };

  const persist = () => {
    void invoke('spanish_save_session', { session: sessionRef.current }).catch(() => undefined);
    // ponytail: fire-and-forget save after every turn so a crash mid-conversation loses at most one turn.
  };

  const speak = async (text: string, rate: number) => {
    setStatus('speaking');
    try {
      await invoke('spanish_speak', { text, variety: profile.variety, rate });
    } catch (e) {
      setError(describeError(e));
    }
  };

  const idleStatus = (): Status => (micOnRef.current ? 'listening' : 'paused');

  const runOpen = useCallback(async () => {
    busyRef.current = true;
    setStatus('thinking');
    setError(null);
    try {
      const res = await invoke<{ reply: string; feedback: Feedback | null }>('spanish_tutor_turn', {
        request: { profile, situation, history: [], learnerText: null, mode: 'open' },
      });
      addTurn('tutor', res.reply);
      if (res.feedback) {
        sessionRef.current = { ...sessionRef.current, feedback: [...sessionRef.current.feedback, res.feedback] };
        setFeedbackCard(res.feedback);
        setWhyOpen(false);
        bump();
      }
      persist();
      await speak(res.reply, 165);
    } catch (e) {
      setError(describeError(e));
    } finally {
      busyRef.current = false;
      setStatus(idleStatus());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finalizeReply = useCallback(async () => {
    const text = pendingRef.current.trim();
    pendingRef.current = '';
    if (!text || busyRef.current) return;
    busyRef.current = true;
    setStatus('thinking');
    setError(null);
    addTurn('learner', text);
    try {
      const history = sessionRef.current.turns.slice(-12);
      const res = await invoke<{ reply: string; feedback: Feedback | null }>('spanish_tutor_turn', {
        request: { profile, situation, history, learnerText: text, mode: 'reply' },
      });
      addTurn('tutor', res.reply);
      if (res.feedback) {
        sessionRef.current = { ...sessionRef.current, feedback: [...sessionRef.current.feedback, res.feedback] };
        setFeedbackCard(res.feedback);
        setWhyOpen(false);
        bump();
      }
      persist();
      await speak(res.reply, 165);
    } catch (e) {
      setError(describeError(e));
    } finally {
      busyRef.current = false;
      setStatus(idleStatus());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, situation]);

  const finalizePractice = useCallback(async () => {
    const text = pendingRef.current.trim();
    pendingRef.current = '';
    if (!text || !practice) return;
    const sim = similarity(text, practice.target);
    if (sim >= 0.75) {
      setPractice({ ...practice, result: 'ok' });
      await speak('¡Muy bien!', 165);
      modeRef.current = 'conversation';
      setPractice(null);
      setFeedbackCard(null);
      setStatus(idleStatus());
      return;
    }
    const attempts = practice.attempts + 1;
    if (attempts >= 3) {
      modeRef.current = 'conversation';
      setPractice(null);
      setFeedbackCard(null);
      setStatus(idleStatus());
      return;
    }
    setPractice({ target: practice.target, attempts, result: 'retry' });
    setStatus('practice');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [practice]);

  const finalizeReplyRef = useRef(finalizeReply);
  const finalizePracticeRef = useRef(finalizePractice);
  useEffect(() => { finalizeReplyRef.current = finalizeReply; }, [finalizeReply]);
  useEffect(() => { finalizePracticeRef.current = finalizePractice; }, [finalizePractice]);

  // How long to wait after the last transcribed phrase before treating the turn as
  // finished. New learners pause mid-sentence while they search for words, so the
  // wait scales with level. Measured from partial arrival, so STT latency adds to it.
  const silenceMs = { beginner: 3200, intermediate: 2500, advanced: 1800 }[profile.level] ?? 2500;
  const handlePartial = (text: string) => {
    if (modeRef.current === 'practice') {
      pendingRef.current = `${pendingRef.current} ${text}`.trim();
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => void finalizePracticeRef.current(), 1500);
      return;
    }
    if (busyRef.current) return; // ignore partials that arrive while busy
    pendingRef.current = `${pendingRef.current} ${text}`.trim();
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void finalizeReplyRef.current(), silenceMs);
  };

  useEffect(() => {
    let cancelled = false;
    const unlistenPromises = [
      listen<{ text: string; tSec: number }>('spanish-partial', (event) => {
        if (!cancelled) handlePartial(event.payload.text);
      }),
      listen<{ active: boolean }>('spanish-listening', (event) => {
        if (cancelled) return;
        micOnRef.current = event.payload.active;
        setMicOn(event.payload.active);
      }),
    ];

    (async () => {
      try {
        await invoke('spanish_start_listening', { deviceName: null });
      } catch (e) {
        if (!cancelled) setError(describeError(e));
      }
      if (!cancelled) await runOpen();
    })();

    return () => {
      cancelled = true;
      endedRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      void invoke('spanish_stop_listening').catch(() => undefined);
      void invoke('spanish_stop_speaking').catch(() => undefined);
      unlistenPromises.forEach((p) => void p.then((fn) => fn()));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [sessionRef.current.turns.length]);

  const lastTutorLine = [...sessionRef.current.turns].reverse().find((t) => t.role === 'tutor')?.text ?? null;

  const toggleMic = async () => {
    const next = !micOnRef.current;
    micOnRef.current = next;
    setMicOn(next);
    try {
      if (next) await invoke('spanish_start_listening', { deviceName: null });
      else {
        pendingRef.current = '';
        if (timerRef.current) clearTimeout(timerRef.current);
        await invoke('spanish_stop_listening');
      }
    } catch (e) {
      setError(describeError(e));
    }
    if (!busyRef.current) setStatus(next ? 'listening' : 'paused');
  };

  const doSlower = async () => {
    if (!lastTutorLine || busyRef.current) return;
    busyRef.current = true;
    await speak(lastTutorLine, 115);
    busyRef.current = false;
    setStatus(idleStatus());
  };

  const doRepeat = async () => {
    if (!lastTutorLine || busyRef.current) return;
    busyRef.current = true;
    await speak(lastTutorLine, 165);
    busyRef.current = false;
    setStatus(idleStatus());
  };

  const doHelp = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setStatus('thinking');
    setError(null);
    try {
      const history = sessionRef.current.turns.slice(-12);
      const res = await invoke<{ reply: string; feedback: Feedback | null }>('spanish_tutor_turn', {
        request: { profile, situation, history, learnerText: null, mode: 'help' },
      });
      setHelpText(res.reply);
      await speak(res.reply, 165);
    } catch (e) {
      setError(describeError(e));
    } finally {
      busyRef.current = false;
      setStatus(idleStatus());
    }
  };

  const startPracticeIt = async (target: string) => {
    modeRef.current = 'practice';
    pendingRef.current = '';
    setPractice({ target, attempts: 0, result: null });
    busyRef.current = false;
    await speak(target, 130);
    setStatus('practice');
  };

  const endSession = () => {
    if (ending) return;
    setEnding(true);
    onEnd(sessionRef.current);
  };

  const statusLabel: Record<Exclude<Status, null>, string> = {
    listening: 'Listening…',
    thinking: 'Thinking…',
    speaking: 'Speaking…',
    practice: 'Practice: repeat the phrase',
    paused: 'Mic paused',
  };

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg text-text">
      <div data-tauri-drag-region className="flex h-[52px] shrink-0 items-center justify-between px-5">
        <div className="min-w-0">
          <p className="truncate text-[13.5px] font-semibold text-text">{profile.name}</p>
          <p className="truncate text-[11px] text-3">{situation ?? 'Just talking'}</p>
        </div>
        <button
          type="button"
          onClick={endSession}
          className="no-drag h-8 shrink-0 rounded-[9px] border border-border bg-panel px-3 text-[12px] font-semibold text-text hover:bg-[var(--hover)]"
        >
          End session
        </button>
      </div>

      <div className="mx-auto flex w-full max-w-[640px] min-h-0 flex-1 flex-col px-6">
        <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar py-4">
          <div className="grid gap-3">
            {sessionRef.current.turns.map((turn, i) => {
              const isLastTutor = turn.role === 'tutor' && turn.text === lastTutorLine && i === sessionRef.current.turns.length - 1;
              return (
                <div key={i} className={`flex ${turn.role === 'learner' ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[80%] rounded-[16px] px-4 py-3 ${
                      turn.role === 'learner' ? 'bg-accent text-accent-foreground' : 'border border-border bg-panel text-text'
                    } ${isLastTutor ? 'text-[23px] font-medium leading-[30px]' : 'text-body'}`}
                  >
                    {turn.text}
                  </div>
                </div>
              );
            })}
          </div>
          <div ref={transcriptEndRef} />
        </div>

        <div className="shrink-0 pb-2">
          {status && (
            <div className="flex items-center gap-2 py-1.5 text-[12px] font-medium text-2">
              {status === 'listening' && <span className="h-2 w-2 animate-pulse rounded-full bg-success" />}
              {status === 'thinking' && <LoaderCircle className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />}
              <span>{statusLabel[status]}</span>
            </div>
          )}

          {error && <p className="pb-1.5 text-[12px] text-danger">{error}</p>}

          {helpText && (
            <div className="mb-3 flex items-start gap-3 rounded-[14px] bg-accent-soft px-5 py-4 text-accent">
              <Sparkles className="mt-1 h-5 w-5 shrink-0" strokeWidth={1.8} />
              <div className="min-w-0 flex-1">
                <p className="horizon-eyebrow mb-1">You could say</p>
                <p className="text-[22px] font-semibold leading-snug">{helpText}</p>
              </div>
              <button type="button" aria-label="Dismiss suggestion" onClick={() => setHelpText(null)} className="shrink-0">
                <X className="h-5 w-5" strokeWidth={1.8} />
              </button>
            </div>
          )}

          {feedbackCard && !practice && (
            <div className={`horizon-card mb-3 p-5 ${feedbackCard.kind === 'praise' ? 'border-success/40' : ''}`}>
              <div className="flex items-start justify-between gap-2">
                <h3 className={`text-[15px] font-semibold ${feedbackCard.kind === 'praise' ? 'text-success' : 'text-text'}`}>
                  {feedbackCard.kind === 'praise' ? 'Nice phrase' : 'A small correction'}
                </h3>
                <button type="button" aria-label="Dismiss feedback" onClick={() => setFeedbackCard(null)} className="text-2 hover:text-text">
                  <X className="h-4 w-4" strokeWidth={1.8} />
                </button>
              </div>

              {feedbackCard.kind === 'correction' ? (
                <div className="mt-3 grid gap-3">
                  <div>
                    <p className="horizon-eyebrow mb-1">You said</p>
                    <p className="text-[17px] leading-snug text-2">{feedbackCard.youSaid}</p>
                  </div>
                  <div>
                    <p className="horizon-eyebrow mb-1">Try this</p>
                    <p className="text-[24px] font-semibold leading-snug text-text">{feedbackCard.tryThis}</p>
                  </div>
                  <button type="button" onClick={() => setWhyOpen((v) => !v)} className="flex items-center gap-1 text-left text-[13px] font-medium text-2 hover:text-text">
                    Why? <ChevronDown className={`h-3.5 w-3.5 transition-transform ${whyOpen ? 'rotate-180' : ''}`} strokeWidth={2} />
                  </button>
                  {whyOpen && <p className="text-[15px] leading-snug text-2">{feedbackCard.why}</p>}
                </div>
              ) : (
                <div className="mt-3 grid gap-2">
                  <p className="text-[22px] font-semibold leading-snug text-text">{feedbackCard.tryThis}</p>
                  <p className="text-[15px] leading-snug text-2">{feedbackCard.why}</p>
                </div>
              )}

              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => void speak(feedbackCard.tryThis, 130)}
                  className="inline-flex items-center gap-1.5 rounded-[10px] border border-border bg-panel px-3.5 py-2 text-[13.5px] font-medium text-text hover:bg-[var(--hover)]"
                >
                  <Volume2 className="h-4 w-4" strokeWidth={1.8} />
                  Hear the phrase
                </button>
                <button
                  type="button"
                  onClick={() => void startPracticeIt(feedbackCard.tryThis)}
                  className="rounded-[10px] bg-accent px-3.5 py-2 text-[13.5px] font-semibold text-accent-foreground"
                >
                  Practice it
                </button>
              </div>
            </div>
          )}

          {practice && (
            <div className="horizon-card mb-3 p-5">
              <p className="horizon-eyebrow mb-1">Repeat this phrase</p>
              <p className="text-[24px] font-semibold leading-snug text-accent">{practice.target}</p>
              {practice.result === 'retry' && <p className="mt-2 text-[14px] text-danger">Try again ({practice.attempts}/3)</p>}
            </div>
          )}

          <div className="flex items-center gap-2 pb-4">
            <button
              type="button"
              onClick={() => void doSlower()}
              className="h-9 rounded-[10px] border border-border bg-panel px-3 text-[12px] font-medium text-text hover:bg-[var(--hover)]"
            >
              Slower
            </button>
            <button
              type="button"
              onClick={() => void doRepeat()}
              className="h-9 rounded-[10px] border border-border bg-panel px-3 text-[12px] font-medium text-text hover:bg-[var(--hover)]"
            >
              Repeat
            </button>
            <button
              type="button"
              onClick={() => void doHelp()}
              className="h-9 rounded-[10px] border border-border bg-panel px-3 text-[12px] font-medium text-text hover:bg-[var(--hover)]"
            >
              Help me answer
            </button>
            <button
              type="button"
              aria-label={micOn ? 'Pause microphone' : 'Resume microphone'}
              onClick={() => void toggleMic()}
              className={`ml-auto grid h-9 w-9 place-items-center rounded-[10px] border ${
                micOn ? 'border-border bg-panel text-text' : 'border-danger/40 bg-danger/10 text-danger'
              }`}
            >
              {micOn ? <Mic className="h-4 w-4" strokeWidth={1.8} /> : <MicOff className="h-4 w-4" strokeWidth={1.8} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// D. Recap
// ---------------------------------------------------------------------------

function RecapScreen({
  profile,
  session,
  onProfileLevelUpdate,
  onPracticeAgain,
  onDone,
}: {
  profile: SpanishProfile;
  session: SpanishSession;
  onProfileLevelUpdate: (profile: SpanishProfile) => void;
  onPracticeAgain: () => void;
  onDone: () => void;
}) {
  const finalSessionRef = useRef<SpanishSession>({ ...session, endedAt: session.endedAt ?? new Date().toISOString() });
  const [levelSignal, setLevelSignal] = useState<SpanishSession['levelSignal']>(null);
  const [speakingPhrase, setSpeakingPhrase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const savedOnMount = useRef(false);

  useEffect(() => {
    if (savedOnMount.current) return;
    savedOnMount.current = true;
    void invoke('spanish_save_session', { session: finalSessionRef.current }).catch((e) => setError(describeError(e)));
  }, []);

  const corrections = session.feedback.filter((f) => f.kind === 'correction');
  const nicePhrases = session.feedback.filter((f) => f.kind === 'praise');
  const learnerTurns = session.turns.filter((t) => t.role === 'learner').length;

  const setFeeling = async (signal: 'easier' | 'right' | 'harder') => {
    setLevelSignal(signal);
    finalSessionRef.current = { ...finalSessionRef.current, levelSignal: signal };
    try {
      await invoke('spanish_save_session', { session: finalSessionRef.current });
      if (signal !== 'right') {
        const updatedLevel = nextLevel(profile.level, signal);
        if (updatedLevel !== profile.level) {
          const updatedProfile = await invoke<SpanishProfile>('spanish_save_profile', {
            profile: { ...profile, level: updatedLevel },
          });
          onProfileLevelUpdate(updatedProfile);
        }
      }
    } catch (e) {
      setError(describeError(e));
    }
  };

  const hearPhrase = async (text: string) => {
    setSpeakingPhrase(text);
    try {
      await invoke('spanish_speak', { text, variety: profile.variety, rate: 165 });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSpeakingPhrase(null);
    }
  };

  return (
    <div className="flex h-screen w-screen flex-col overflow-y-auto bg-bg text-text custom-scrollbar">
      <div data-tauri-drag-region className="h-[52px] shrink-0" aria-hidden="true" />
      <div className="mx-auto w-full max-w-[640px] flex-1 px-6 pb-16">
        <h1 className="text-display text-text">Good work, {profile.name}</h1>
        <div className="mt-4 flex gap-2">
          <div className="horizon-card flex-1 p-3 text-center">
            <p className="text-[20px] font-semibold text-text">{learnerTurns}</p>
            <p className="text-[11px] text-2">Turns spoken</p>
          </div>
          <div className="horizon-card flex-1 p-3 text-center">
            <p className="text-[20px] font-semibold text-text">{corrections.length}</p>
            <p className="text-[11px] text-2">Corrections</p>
          </div>
          <div className="horizon-card flex-1 p-3 text-center">
            <p className="text-[20px] font-semibold text-success">{nicePhrases.length}</p>
            <p className="text-[11px] text-2">Nice phrases</p>
          </div>
        </div>

        {error && <p className="mt-3 text-[12.5px] text-danger">{error}</p>}

        {session.feedback.length > 0 && (
          <div className="mt-5 grid gap-2">
            <p className="horizon-eyebrow">What we worked on</p>
            {session.feedback.map((f, i) => (
              <div key={i} className="horizon-card flex items-start gap-2 p-3">
                <div className="min-w-0 flex-1 text-[12.5px]">
                  {f.kind === 'correction' ? (
                    <>
                      <p className="text-2">{f.youSaid} →</p>
                      <p className="font-medium text-text">{f.tryThis}</p>
                    </>
                  ) : (
                    <p className="font-medium text-success">{f.tryThis}</p>
                  )}
                  <p className="mt-1 text-[11.5px] text-2">{f.why}</p>
                </div>
                <button
                  type="button"
                  aria-label={`Hear "${f.tryThis}"`}
                  onClick={() => void hearPhrase(f.tryThis)}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-[8px] text-2 hover:bg-[var(--hover)] hover:text-text"
                >
                  {speakingPhrase === f.tryThis ? (
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" strokeWidth={1.8} />
                  ) : (
                    <Volume2 className="h-3.5 w-3.5" strokeWidth={1.8} />
                  )}
                </button>
              </div>
            ))}
          </div>
        )}

        <p className="horizon-eyebrow mt-6">How did that feel?</p>
        <div className="mt-2 flex gap-2">
          <button type="button" onClick={() => void setFeeling('easier')} className={segBtn(levelSignal === 'easier')}>
            Too easy
          </button>
          <button type="button" onClick={() => void setFeeling('right')} className={segBtn(levelSignal === 'right')}>
            Just right
          </button>
          <button type="button" onClick={() => void setFeeling('harder')} className={segBtn(levelSignal === 'harder')}>
            Too hard
          </button>
        </div>

        <div className="mt-6 flex gap-2">
          <button type="button" onClick={onPracticeAgain} className="horizon-button flex-1 border border-border bg-panel text-text">
            Practice again
          </button>
          <button type="button" onClick={onDone} className="horizon-button flex-1 bg-accent text-accent-foreground">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
