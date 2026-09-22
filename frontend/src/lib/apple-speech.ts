import { invoke } from '@tauri-apps/api/core';

export interface AppleSpeechLocale {
  id: string;
  name: string;
  installed: boolean;
}

export interface AppleSpeechCapabilities {
  available: boolean;
  reason: string | null;
  locales: AppleSpeechLocale[];
}

export function getAppleSpeechCapabilities() {
  return invoke<AppleSpeechCapabilities>('apple_speech_capabilities');
}

export function prepareAppleSpeech(locale: string) {
  return invoke<string>('apple_speech_prepare', { locale });
}
