'use client';

import { Suspense } from 'react';
import { LoaderCircle } from 'lucide-react';
import SettingsShell from '@/components/Settings/SettingsShell';

function SettingsFallback() {
  return (
    <div className="flex h-full items-center justify-center bg-bg text-ui text-3">
      <LoaderCircle className="mr-2 h-4 w-4 animate-spin" strokeWidth={1.75} />
      Loading settings…
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<SettingsFallback />}>
      <SettingsShell />
    </Suspense>
  );
}
