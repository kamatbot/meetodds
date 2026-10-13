export interface SpeakerMetadata {
  speaker?: string | null;
  speaker_label?: string | null;
  speaker_source?: string | null;
  speaker_confidence?: number | null;
  source?: string | null;
}

export type SpeakerAttribution = 'confirmed' | 'estimated' | 'channel' | 'unknown';

export interface SpeakerPresentation {
  id: string;
  label: string;
  source: string;
  /** A clustering score, when present; never a calibrated identity probability. */
  confidence: number | null;
  attribution: SpeakerAttribution;
  statusLabel: string;
  badgeClassName: string;
  accentClassName: string;
  isEstimate: boolean;
}

function normalized(value?: string | null): string {
  return value?.trim().toLowerCase() ?? '';
}

export function getSpeakerPresentation(metadata: SpeakerMetadata): SpeakerPresentation {
  const speakerId = normalized(metadata.speaker);
  const explicitSource = normalized(metadata.speaker_source) || normalized(metadata.source);
  // Older recordings may only contain a channel id. A channel is not an identity.
  const source = explicitSource || (speakerId === 'me' || speakerId === 'mic'
    ? 'microphone-channel' : speakerId === 'system' ? 'system-channel' : 'unknown');
  const explicitLabel = metadata.speaker_label?.trim();
  const unresolved = speakerId === 'unknown' || source === 'unknown'
    || source === 'manual-unknown' || source === 'unresolved-channel';
  const acoustic = source.includes('acoustic');
  const microphone = source === 'microphone' || source === 'microphone-channel';
  const system = source === 'system' || source === 'system-channel';
  const attribution: SpeakerAttribution = unresolved ? 'unknown'
    : source === 'manual' && Boolean(speakerId) ? 'confirmed'
    : acoustic && Boolean(speakerId) ? 'estimated'
    : microphone || system ? 'channel' : 'unknown';
  const label = attribution === 'unknown' ? 'Unknown'
    : attribution === 'channel' ? (system ? 'Other party' : 'Microphone')
    : explicitLabel || 'Speaker';

  return {
    id: speakerId || source,
    label,
    source,
    confidence: metadata.speaker_confidence ?? null,
    attribution,
    statusLabel: {
      confirmed: 'Confirmed',
      estimated: 'Estimated',
      channel: 'Channel only',
      unknown: 'Needs review',
    }[attribution],
    badgeClassName: attribution === 'confirmed'
      ? 'border-accent/30 bg-accent-soft text-accent'
      : 'border-border bg-panel-2 text-text',
    accentClassName: attribution === 'confirmed' ? 'border-l-accent' : 'border-l-border',
    isEstimate: attribution === 'estimated',
  };
}

/** Keep the caveat when a label is used outside the transcript, such as in notes. */
export function getSpeakerAttributionLabel(metadata: SpeakerMetadata): string {
  const speaker = getSpeakerPresentation(metadata);
  const qualifier = speaker.attribution === 'confirmed' ? 'confirmed speaker'
    : speaker.attribution === 'estimated' ? 'estimated speaker'
    : speaker.attribution === 'channel' ? (speaker.source.startsWith('system')
      ? 'system audio; may include multiple speakers' : 'microphone audio; identity unconfirmed')
    : 'unresolved speaker';
  return `${speaker.label} [${qualifier}]`;
}

/** The caveat travels with the label into copying, accessibility and model input. */
export function withSpeakerPrefix<T extends SpeakerMetadata>(transcript: T, text: string): string {
  return `${getSpeakerAttributionLabel(transcript)}: ${text}`;
}

export function describeSpeakerSource(source: string): string {
  if (source === 'manual') return 'This segment’s speaker was confirmed by a person.';
  if (source === 'post-meeting-acoustic') {
    return 'Estimated from similar voices after the meeting. Names are labels until each segment is confirmed.';
  }
  if (source.includes('acoustic')) {
    return 'Estimated from similar voices. Speaker identity has not been confirmed.';
  }
  if (source === 'microphone-channel' || source === 'microphone') {
    return 'Captured on the microphone channel. This does not identify who spoke; a room microphone can include several people.';
  }
  if (source === 'system-channel' || source === 'system') {
    return 'Captured from system audio. Other party includes all remote participants, not an identified individual.';
  }
  return 'Speaker unknown. Review the recording before attributing this segment to a person.';
}

export const SPEAKER_ATTRIBUTION_INSTRUCTIONS = `
SPEAKER ATTRIBUTION
Speaker labels marked estimated are uncertain voice groups, even when named. Renaming a group does not confirm its segments.
Only "confirmed speaker" marks a human-confirmed segment. "Other party" is collective system audio; "Microphone" identifies a channel, not a person. Unknown speakers remain unknown.
Preserve these distinctions in summaries. Never infer an action owner or commitment from a guessed speaker label or channel.
An owner requires explicit evidence: a named assignment or a confirmed speaker explicitly accepting it. Otherwise use Unknown (omit Owner metadata).
Mark a commitment agreed only when acceptance is explicit; a request is proposed. Reviewing an action does not establish agreement.
`;
