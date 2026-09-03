'use client';

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FileText, LoaderCircle, RefreshCw } from 'lucide-react';

interface TemplateSummary {
  id: string;
  name: string;
  description: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export default function TemplatesSettings() {
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadTemplates = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await invoke<TemplateSummary[]>('api_list_templates');
      setTemplates(result);
    } catch (loadError) {
      console.error('[TemplatesSettings] Failed to load templates:', loadError);
      setError(errorMessage(loadError));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadTemplates();
  }, []);

  if (isLoading) {
    return (
      <div className="flex min-h-[160px] items-center justify-center text-ui text-3">
        <LoaderCircle className="mr-2 h-4 w-4 animate-spin" strokeWidth={1.75} />
        Loading templates…
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-6 text-center">
        <p className="text-ui font-medium text-danger">Templates could not be loaded</p>
        <p className="mt-1 text-caption text-3">{error}</p>
        <button
          type="button"
          onClick={() => void loadTemplates()}
          className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-control border border-border bg-bg px-3 text-ui font-medium text-text hover:bg-surface"
        >
          <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} /> Retry
        </button>
      </div>
    );
  }

  return (
    <div className="divide-y divide-border">
      {templates.map((template) => (
        <div key={template.id} className="flex items-start gap-3 py-4 first:pt-0 last:pb-0">
          <div className="mt-0.5 inline-grid h-8 w-8 shrink-0 place-items-center rounded-control bg-bg text-2">
            <FileText className="h-4 w-4" strokeWidth={1.75} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-ui font-medium text-text">{template.name}</div>
            <p className="mt-1 text-caption leading-5 text-3">
              {template.description || 'Meeting summary template'}
            </p>
            <p className="mt-1 font-mono text-[10px] text-3">{template.id}</p>
          </div>
        </div>
      ))}
      {templates.length === 0 && (
        <div className="py-8 text-center text-ui text-3">No summary templates are available.</div>
      )}
    </div>
  );
}
