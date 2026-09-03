'use client';

import { useState } from 'react';
import { Pin } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { LanguagePickerPopover } from '@/components/LanguagePickerPopover';
import SettingRow from '@/components/Settings/SettingRow';
import { useRecentLanguages } from '@/hooks/useRecentLanguages';
import { labelForCode } from '@/lib/summary-languages';

export function SummaryLanguageSettings() {
  const { recents, pinned, addRecent, removeRecent, setPinned } = useRecentLanguages();
  const [pickerOpen, setPickerOpen] = useState(false);

  const togglePin = (code: string) => {
    setPinned(pinned === code ? null : code);
  };

  return (
    <SettingRow
      label="Summary language"
      description={pinned
        ? `Default: ${labelForCode(pinned)}. Keep up to five quick-switch languages available in meeting summaries.`
        : 'Auto follows the dominant transcript language. Pin a language to make it the default for new meetings.'}
      align="start"
      control={(
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={recents.length >= 5}
              className="h-8 rounded-control border border-border bg-bg px-2.5 text-ui font-medium text-text hover:bg-surface disabled:opacity-40"
            >
              Add language…
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-auto border-0 bg-transparent p-0 shadow-none">
            <LanguagePickerPopover
              mode="settings"
              value={null}
              onChange={(code) => {
                if (code) addRecent(code);
                setPickerOpen(false);
              }}
              onClose={() => setPickerOpen(false)}
            />
          </PopoverContent>
        </Popover>
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        {recents.map((code) => {
          const isPinned = pinned === code;
          return (
            <span
              key={code}
              className={`inline-flex items-center overflow-hidden rounded-full border text-caption ${isPinned ? 'border-accent/30 bg-accent-soft text-accent' : 'border-border bg-surface text-2'}`}
            >
              <button
                type="button"
                aria-label={isPinned ? `Unpin ${labelForCode(code)} as default` : `Pin ${labelForCode(code)} as default`}
                aria-pressed={isPinned}
                onClick={() => togglePin(code)}
                className="flex items-center gap-1.5 py-1 pl-2.5 pr-1.5"
              >
                <Pin className="h-3 w-3" fill={isPinned ? 'currentColor' : 'none'} strokeWidth={1.75} />
                {labelForCode(code)}
              </button>
              <button
                type="button"
                aria-label={`Remove ${labelForCode(code)}`}
                onClick={() => removeRecent(code)}
                className="py-1 pl-1 pr-2 text-3 hover:text-text"
              >
                ×
              </button>
            </span>
          );
        })}
        {recents.length === 0 && (
          <span className="text-caption text-3">No quick-switch languages added.</span>
        )}
      </div>
    </SettingRow>
  );
}
