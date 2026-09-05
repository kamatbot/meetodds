/** Durable draft journal + per-meeting write ordering, independent of React. */
export interface NotesDraft {
  version: 1;
  meetingId: string;
  base: string;
  value: string;
}

export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const keyFor = (meetingId: string) => `meetodds:notes-draft:v1:${encodeURIComponent(meetingId)}`;

export function readNotesDraft(storage: DraftStorage, meetingId: string): NotesDraft | null {
  const raw = storage.getItem(keyFor(meetingId));
  if (!raw) return null;
  try {
    const draft: unknown = JSON.parse(raw);
    if (!draft || typeof draft !== 'object') return null;
    const item = draft as Partial<NotesDraft>;
    return item.version === 1 && item.meetingId === meetingId &&
      typeof item.base === 'string' && typeof item.value === 'string'
      ? item as NotesDraft : null;
  } catch {
    return null;
  }
}

export function writeNotesDraft(storage: DraftStorage, draft: NotesDraft): void {
  storage.setItem(keyFor(draft.meetingId), JSON.stringify(draft));
}

/** An older native acknowledgement must not erase a newer recovery draft. */
export function clearAcknowledgedDraft(storage: DraftStorage, meetingId: string, value: string): void {
  const current = readNotesDraft(storage, meetingId);
  if (current?.value === value) storage.removeItem(keyFor(meetingId));
}

export function discardNotesDraft(storage: DraftStorage, meetingId: string): void {
  storage.removeItem(keyFor(meetingId));
}

export function createNotesSaveQueue(write: (meetingId: string, value: string) => Promise<void>) {
  const queues = new Map<string, { latest: number; tail: Promise<void> }>();
  return {
    save(meetingId: string, value: string): Promise<'saved' | 'superseded'> {
      const queue = queues.get(meetingId) ?? { latest: 0, tail: Promise.resolve() };
      const revision = ++queue.latest;
      queues.set(meetingId, queue);
      const result = queue.tail.then(async () => {
        if (revision !== queue.latest) return 'superseded' as const;
        await write(meetingId, value);
        return revision === queue.latest ? 'saved' as const : 'superseded' as const;
      });
      queue.tail = result.then(() => undefined, () => undefined);
      void queue.tail.then(() => {
        if (queues.get(meetingId) === queue && queue.latest === revision) queues.delete(meetingId);
      });
      return result;
    },
    async idle(meetingId: string): Promise<void> {
      // A newer save may join while the previous one is in flight.
      while (queues.has(meetingId)) await queues.get(meetingId)!.tail;
    },
  };
}
