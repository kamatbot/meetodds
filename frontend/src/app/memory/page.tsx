'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ChevronRight,
  ExternalLink,
  LoaderCircle,
  Search,
  Sparkles,
} from 'lucide-react';
import { memoryHitHref, evidenceHref } from '@/lib/evidence-navigation';
import type {
  MeetingIntelligence,
  MeetingPreparationResponse,
  MemoryScope,
  MemorySearchResponse,
  PreparationItem,
} from '@/types/intelligence';

function PreparationList({ title, items }: { title: string; items: PreparationItem[] }) {
  const router = useRouter();
  if (!items.length) return null;
  return (
    <div>
      <h3 className="text-caption font-semibold uppercase tracking-[0.05em] text-3">{title}</h3>
      <div className="mt-2 space-y-1.5">
        {items.map((item, index) => (
          <button
            key={`${item.meetingId}-${index}-${item.text}`}
            type="button"
            onClick={() => item.evidence ? router.push(evidenceHref(item.meetingId, item.evidence)) : router.push(`/meeting?id=${encodeURIComponent(item.meetingId)}`)}
            className="flex w-full items-start gap-2 rounded-control px-2.5 py-2 text-left text-ui text-text hover:bg-bg"
          >
            <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-3" />
            <span className="min-w-0 flex-1">
              <span className="block leading-5">{item.text}</span>
              <span className="mt-0.5 block truncate text-caption text-3">{item.meetingTitle}{item.confirmed ? ' · confirmed' : ''}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function MemoryContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const meetingId = searchParams.get('meetingId');
  const requestedScope = searchParams.get('scope');
  const initialScope: MemoryScope = ['meeting', 'project', 'client', 'all'].includes(requestedScope || '')
    ? requestedScope as MemoryScope
    : meetingId ? 'meeting' : 'all';
  const [scope, setScope] = useState<MemoryScope>(initialScope);
  const [query, setQuery] = useState('');
  const [project, setProject] = useState('');
  const [client, setClient] = useState('');
  const [result, setResult] = useState<MemorySearchResponse | null>(null);
  const [preparation, setPreparation] = useState<MeetingPreparationResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!meetingId) return;
    let cancelled = false;
    void invoke<MeetingIntelligence>('api_get_meeting_intelligence', { meetingId }).then((intelligence) => {
      if (cancelled) return;
      setProject(intelligence.context.project ?? '');
      setClient(intelligence.context.client ?? '');
    }).catch(() => undefined);
    void invoke<MeetingPreparationResponse>('api_get_meeting_preparation', { meetingId }).then((value) => {
      if (!cancelled) setPreparation(value);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [meetingId]);

  const scopeDescription = useMemo(() => {
    switch (scope) {
      case 'meeting': return meetingId ? 'Only this meeting and its notes.' : 'Choose a meeting first.';
      case 'project': return project ? `Meetings linked to project “${project}”.` : 'Uses the current meeting project, or enter one below.';
      case 'client': return client ? `Meetings linked to client “${client}”.` : 'Uses the current meeting client, or enter one below.';
      case 'all': return 'Your local MeetOdds library.';
    }
  }, [client, meetingId, project, scope]);

  const ask = async () => {
    const trimmed = query.trim();
    if (trimmed.length < 2 || loading) return;
    setLoading(true);
    setError(null);
    try {
      setResult(await invoke<MemorySearchResponse>('api_search_meeting_memory', {
        request: {
          query: trimmed,
          scope,
          meetingId,
          project: project.trim() || null,
          client: client.trim() || null,
          limit: 14,
        },
      }));
    } catch (searchError) {
      setResult(null);
      setError(searchError instanceof Error ? searchError.message : String(searchError));
    } finally { setLoading(false); }
  };

  return (
    <main className="h-full overflow-y-auto bg-bg custom-scrollbar">
      <div className="mx-auto w-full max-w-[940px] px-6 py-8 md:py-10">
        <div className="flex items-center gap-2"><Sparkles className="h-5 w-5 text-accent" /><h1 className="text-display text-text">Meeting memory</h1></div>
        <p className="mt-2 max-w-2xl text-body text-2">Ask across saved meeting evidence. Retrieval and ranking stay on this device; answers show the source passages instead of inventing a synthesized claim.</p>

        <section className="mt-6 rounded-card border border-border bg-surface p-4" aria-label="Ask MeetOdds">
          <div className="grid gap-3 md:grid-cols-[160px_minmax(0,1fr)]">
            <select value={scope} onChange={(event) => setScope(event.target.value as MemoryScope)} className="h-10 rounded-control border border-border bg-bg px-3 text-ui text-text outline-none focus:border-accent" aria-label="Meeting memory scope">
              <option value="meeting" disabled={!meetingId}>This meeting</option>
              <option value="project">This project</option>
              <option value="client">This client</option>
              <option value="all">All meetings</option>
            </select>
            <div className="flex min-w-0 items-center gap-2 rounded-control border border-border bg-bg px-3 focus-within:border-accent">
              <Search className="h-4 w-4 shrink-0 text-3" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void ask(); } }}
                placeholder="What did we decide about the rollout?"
                className="h-10 min-w-0 flex-1 bg-transparent text-body text-text outline-none placeholder:text-3"
                autoFocus
              />
              <button type="button" disabled={loading || query.trim().length < 2} onClick={() => void ask()} className="inline-flex h-8 items-center gap-1.5 rounded-control bg-accent px-3 text-ui font-semibold text-white disabled:opacity-40">
                {loading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null} Ask
              </button>
            </div>
          </div>
          <p className="mt-2 text-caption text-3">{scopeDescription}</p>
          {scope === 'project' && !project && <input value={project} onChange={(event) => setProject(event.target.value)} placeholder="Project name" className="mt-3 h-9 w-full rounded-control border border-border bg-bg px-3 text-ui text-text outline-none focus:border-accent" />}
          {scope === 'client' && !client && <input value={client} onChange={(event) => setClient(event.target.value)} placeholder="Client / company" className="mt-3 h-9 w-full rounded-control border border-border bg-bg px-3 text-ui text-text outline-none focus:border-accent" />}
          {error && <p role="alert" className="mt-3 text-ui text-danger">{error}</p>}
        </section>

        {result && (
          <section className="mt-6" aria-labelledby="memory-answer-title">
            <div className="flex items-center justify-between gap-4"><h2 id="memory-answer-title" className="text-title text-text">Evidence</h2><span className="text-caption text-3">{result.scopeLabel}</span></div>
            <div className="mt-2 rounded-card border border-border bg-surface p-4">
              <p className="whitespace-pre-line text-body leading-7 text-text">{result.answer}</p>
            </div>
            <div className="mt-3 space-y-2">
              {result.hits.map((hit) => (
                <button key={`${hit.meetingId}-${hit.kind}-${hit.sourceId}`} type="button" onClick={() => router.push(memoryHitHref(hit))} className="group flex w-full items-start gap-3 rounded-card border border-border bg-surface p-4 text-left hover:bg-bg">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-ui font-semibold text-text">{hit.meetingTitle}</span>
                      <span className="rounded-full border border-border bg-bg px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.05em] text-3">{hit.kind.replace('_', ' ')}</span>
                      {hit.speakerLabel && <span className="text-caption text-3">{hit.speakerLabel}</span>}
                    </div>
                    <p className="mt-2 text-ui leading-6 text-2">{hit.snippet}</p>
                    <p className="mt-2 text-caption text-3">{[hit.project, hit.client].filter(Boolean).join(' · ') || 'Meeting evidence'} · local relevance {Math.round(hit.score * 100)}%</p>
                  </div>
                  <ExternalLink className="mt-0.5 h-4 w-4 shrink-0 text-3 transition-colors group-hover:text-accent" />
                </button>
              ))}
            </div>
          </section>
        )}

        {meetingId && preparation && (
          <section className="mt-8 rounded-card border border-border bg-surface p-4" aria-labelledby="prepare-title">
            <div className="flex items-start justify-between gap-4"><div><h2 id="prepare-title" className="text-title text-text">Prepare for the next conversation</h2><p className="mt-1 text-caption text-3">{preparation.scopeLabel}</p></div><button type="button" onClick={() => router.push(`/meeting?id=${encodeURIComponent(meetingId)}`)} className="text-caption font-medium text-accent hover:underline">Back to meeting</button></div>
            {preparation.priorDecisions.length === 0 && preparation.openActions.length === 0 && preparation.openQuestions.length === 0 ? (
              <p className="mt-4 text-ui text-3">Link this meeting to a project or client to surface prior decisions and unfinished work.</p>
            ) : (
              <div className="mt-4 grid gap-5 lg:grid-cols-3">
                <PreparationList title="Prior decisions" items={preparation.priorDecisions} />
                <PreparationList title="Open actions" items={preparation.openActions} />
                <PreparationList title="Open questions" items={preparation.openQuestions} />
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}

export default function MemoryPage() {
  return <Suspense fallback={<div className="flex h-full items-center justify-center bg-bg text-ui text-3"><LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> Loading meeting memory…</div>}><MemoryContent /></Suspense>;
}
