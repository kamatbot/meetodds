'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Bot,
  FileText,
  FlaskConical,
  Info,
  Languages,
  Mic,
  Settings2,
  ShieldCheck,
  Speech,
} from 'lucide-react';
import { useConfig } from '@/contexts/ConfigContext';
import { TranscriptSettings } from '@/components/TranscriptSettings';
import { RecordingSettings } from '@/components/RecordingSettings';
import { SummaryModelSettings } from '@/components/SummaryModelSettings';
import { BetaSettings } from '@/components/BetaSettings';
import { About } from '@/components/About';
import GeneralSettings from './GeneralSettings';
import TemplatesSettings from './TemplatesSettings';
import LiveTranslationSettingsSection from './LiveTranslationSettings';
import PrivacyDataSettings from './PrivacyDataSettings';

export type SettingsSectionId =
  | 'general'
  | 'recording'
  | 'transcription'
  | 'summary'
  | 'templates'
  | 'translation'
  | 'privacy'
  | 'labs'
  | 'about';

interface SettingsSectionDefinition {
  id: SettingsSectionId;
  label: string;
  description: string;
  icon: typeof Settings2;
  keywords: string[];
}

const SETTINGS_LAST_SECTION_KEY = 'meetodds.settings.lastSection';

const sections: SettingsSectionDefinition[] = [
  {
    id: 'general',
    label: 'General',
    description: 'Appearance, notifications, and application behavior.',
    icon: Settings2,
    keywords: ['appearance', 'theme', 'notifications', 'menu bar'],
  },
  {
    id: 'recording',
    label: 'Recording',
    description: 'Microphone, system audio, saved recordings, and capture preferences.',
    icon: Mic,
    keywords: ['microphone', 'audio', 'recording', 'device', 'folder'],
  },
  {
    id: 'transcription',
    label: 'Transcription',
    description: 'On-device transcription engine and model management.',
    icon: Speech,
    keywords: ['whisper', 'parakeet', 'model', 'language', 'transcript'],
  },
  {
    id: 'summary',
    label: 'AI Summary',
    description: 'Summary provider, model, language, and automatic generation.',
    icon: Bot,
    keywords: ['ollama', 'openai', 'claude', 'provider', 'summary', 'api key'],
  },
  {
    id: 'templates',
    label: 'Templates',
    description: 'Summary templates available to meeting generation.',
    icon: FileText,
    keywords: ['template', 'summary format'],
  },
  {
    id: 'translation',
    label: 'Live translation',
    description: 'Defaults for non-blocking live transcript translation.',
    icon: Languages,
    keywords: ['translation', 'language', 'bilingual', 'glossary'],
  },
  {
    id: 'privacy',
    label: 'Privacy & data',
    description: 'Storage locations and usage analytics controls.',
    icon: ShieldCheck,
    keywords: ['privacy', 'analytics', 'database', 'models', 'recordings', 'storage'],
  },
  {
    id: 'labs',
    label: 'Labs',
    description: 'Experimental and beta functionality.',
    icon: FlaskConical,
    keywords: ['beta', 'experimental', 'import', 'retranscribe'],
  },
  {
    id: 'about',
    label: 'About',
    description: 'Version, updates, diagnostics, and project information.',
    icon: Info,
    keywords: ['version', 'update', 'diagnostics', 'github'],
  },
];

function isSettingsSection(value: string | null): value is SettingsSectionId {
  return sections.some((section) => section.id === value);
}

function sectionFromStorage(): SettingsSectionId {
  if (typeof window === 'undefined') return 'general';
  const stored = window.localStorage.getItem(SETTINGS_LAST_SECTION_KEY);
  return isSettingsSection(stored) ? stored : 'general';
}

export default function SettingsShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedSection = searchParams.get('section');
  const { transcriptModelConfig, setTranscriptModelConfig } = useConfig();
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('general');
  const [query, setQuery] = useState('');
  const navRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    const initial = isSettingsSection(requestedSection)
      ? requestedSection
      : sectionFromStorage();
    setActiveSection(initial);
  }, [requestedSection]);

  const filteredSections = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return sections;
    return sections.filter((section) => (
      section.label.toLowerCase().includes(normalized)
      || section.description.toLowerCase().includes(normalized)
      || section.keywords.some((keyword) => keyword.includes(normalized))
    ));
  }, [query]);

  useEffect(() => {
    if (filteredSections.length === 0) return;
    if (!filteredSections.some((section) => section.id === activeSection)) {
      setActiveSection(filteredSections[0].id);
    }
  }, [activeSection, filteredSections]);

  const selectSection = useCallback((section: SettingsSectionId, updateUrl = true) => {
    setActiveSection(section);
    window.localStorage.setItem(SETTINGS_LAST_SECTION_KEY, section);
    if (updateUrl) {
      router.replace(`/settings?section=${section}`, { scroll: false });
    }
  }, [router]);

  const handleNavKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = Math.max(
      0,
      filteredSections.findIndex((section) => section.id === activeSection),
    );
    let nextIndex = currentIndex;
    if (event.key === 'ArrowDown') nextIndex = Math.min(filteredSections.length - 1, currentIndex + 1);
    if (event.key === 'ArrowUp') nextIndex = Math.max(0, currentIndex - 1);
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = filteredSections.length - 1;
    const next = filteredSections[nextIndex];
    if (!next) return;
    selectSection(next.id);
    requestAnimationFrame(() => navRefs.current[nextIndex]?.focus());
  };

  const sectionDefinition = sections.find((section) => section.id === activeSection) ?? sections[0];

  const content = (() => {
    switch (activeSection) {
      case 'general':
        return <GeneralSettings />;
      case 'recording':
        return <RecordingSettings />;
      case 'transcription':
        return (
          <TranscriptSettings
            transcriptModelConfig={transcriptModelConfig}
            setTranscriptModelConfig={setTranscriptModelConfig}
          />
        );
      case 'summary':
        return <SummaryModelSettings />;
      case 'templates':
        return <TemplatesSettings />;
      case 'translation':
        return <LiveTranslationSettingsSection />;
      case 'privacy':
        return <PrivacyDataSettings />;
      case 'labs':
        return <BetaSettings />;
      case 'about':
        return <About />;
      default:
        return null;
    }
  })();

  return (
    <div className="flex h-full min-h-0 bg-bg">
      <aside className="flex w-[220px] shrink-0 flex-col border-r border-border bg-sidebar px-3 py-4">
        <div className="px-2 pb-3">
          <h1 className="text-title text-text">Settings</h1>
          <p className="mt-1 text-caption text-3">Changes apply immediately.</p>
        </div>

        <div className="relative px-1 pb-3">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search settings"
            aria-label="Search settings"
            className="h-8 w-full rounded-control border border-border bg-surface px-2.5 text-ui text-text outline-none placeholder:text-3 focus:border-accent"
          />
        </div>

        <div
          role="listbox"
          aria-label="Settings sections"
          onKeyDown={handleNavKeyDown}
          className="min-h-0 flex-1 overflow-y-auto custom-scrollbar"
        >
          {filteredSections.map((section, index) => {
            const Icon = section.icon;
            const selected = activeSection === section.id;
            return (
              <button
                key={section.id}
                ref={(element) => { navRefs.current[index] = element; }}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => selectSection(section.id)}
                className={`mb-0.5 flex h-8 w-full items-center gap-2 rounded-control px-2.5 text-left text-ui transition-colors duration-150 ${selected ? 'bg-accent-soft font-semibold text-accent' : 'text-text hover:bg-surface'}`}
              >
                <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                <span className="truncate">{section.label}</span>
              </button>
            );
          })}
          {filteredSections.length === 0 && (
            <p className="px-2 py-4 text-caption text-3">No settings match “{query}”.</p>
          )}
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto custom-scrollbar">
        <div className="mx-auto w-full max-w-[620px] px-8 py-8">
          <header className="mb-5 border-b border-border pb-5">
            <h2 className="text-display text-text">{sectionDefinition.label}</h2>
            <p className="mt-1.5 text-body text-2">{sectionDefinition.description}</p>
          </header>

          <div className="settings-section min-w-0">
            {content}
          </div>
        </div>
      </main>
    </div>
  );
}
