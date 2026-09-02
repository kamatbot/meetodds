export interface SpeakerMetadata {
  speaker?: string | null;
  speaker_label?: string | null;
  speaker_source?: string | null;
  speaker_confidence?: number | null;
  source?: string | null;
}

export interface SpeakerPresentation {
  id: string;
  label: string;
  source: string;
  confidence: number | null;
  badgeClassName: string;
  accentClassName: string;
  isEstimate: boolean;
}

const REMOTE_STYLES = [
  {
    badgeClassName: 'border-violet-200 bg-violet-50 text-violet-700',
    accentClassName: 'border-l-violet-300',
  },
  {
    badgeClassName: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    accentClassName: 'border-l-emerald-300',
  },
  {
    badgeClassName: 'border-amber-200 bg-amber-50 text-amber-800',
    accentClassName: 'border-l-amber-300',
  },
  {
    badgeClassName: 'border-rose-200 bg-rose-50 text-rose-700',
    accentClassName: 'border-l-rose-300',
  },
  {
    badgeClassName: 'border-cyan-200 bg-cyan-50 text-cyan-700',
    accentClassName: 'border-l-cyan-300',
  },
  {
    badgeClassName: 'border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700',
    accentClassName: 'border-l-fuchsia-300',
  },
] as const;

function normalized(value?: string | null): string {
  return value?.trim().toLowerCase() ?? '';
}

function stableStyleIndex(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % REMOTE_STYLES.length;
}

export function getSpeakerPresentation(
  metadata: SpeakerMetadata,
): SpeakerPresentation | null {
  const speakerId = normalized(metadata.speaker);
  const source = normalized(metadata.speaker_source || metadata.source);
  const explicitLabel = metadata.speaker_label?.trim();

  // Backward compatibility with the dormant `mic` / `system` values from the
  // original migration, plus the new stable session-local ids.
  const isMe = speakerId === 'me'
    || speakerId === 'mic'
    || source === 'microphone'
    || source === 'microphone-channel';

  if (isMe) {
    return {
      id: speakerId || 'me',
      label: explicitLabel || 'Me',
      source: source || 'microphone-channel',
      confidence: metadata.speaker_confidence ?? 1,
      badgeClassName: 'border-blue-200 bg-blue-50 text-blue-700',
      accentClassName: 'border-l-blue-300',
      isEstimate: false,
    };
  }

  const isRemote = speakerId === 'system'
    || speakerId.startsWith('remote-')
    || speakerId.startsWith('room-')
    || source.startsWith('system')
    || source.startsWith('microphone-acoustic');

  if (!isRemote && !explicitLabel) {
    return null;
  }

  const id = speakerId || source || explicitLabel || 'speaker';
  const style = REMOTE_STYLES[stableStyleIndex(id)];
  const confidence = metadata.speaker_confidence ?? null;
  return {
    id,
    label: explicitLabel
      || (speakerId === 'system' ? 'Other party' : 'Speaker'),
    source: source || 'acoustic',
    confidence,
    badgeClassName: style.badgeClassName,
    accentClassName: style.accentClassName,
    isEstimate: source.includes('acoustic')
      && (confidence === null || confidence < 0.8),
  };
}

export function withSpeakerPrefix<T extends SpeakerMetadata>(
  transcript: T,
  text: string,
): string {
  const speaker = getSpeakerPresentation(transcript);
  return speaker ? `${speaker.label}: ${text}` : text;
}

export function describeSpeakerSource(source: string): string {
  if (source === 'microphone-channel') {
    return 'Identified from the microphone channel';
  }
  if (source === 'system-acoustic') {
    return 'Best-effort speaker cluster within system audio';
  }
  if (source === 'microphone-acoustic') {
    return 'Best-effort speaker cluster within room audio';
  }
  if (source.startsWith('system')) {
    return 'Identified from system audio';
  }
  if (source.startsWith('microphone')) {
    return 'Identified from microphone audio';
  }
  return 'Speaker attribution';
}
