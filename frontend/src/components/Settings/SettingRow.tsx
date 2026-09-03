'use client';

import type { ReactNode } from 'react';

interface SettingRowProps {
  label: string;
  description?: string;
  control: ReactNode;
  align?: 'center' | 'start';
  children?: ReactNode;
}

export default function SettingRow({
  label,
  description,
  control,
  align = 'center',
  children,
}: SettingRowProps) {
  return (
    <div className="border-b border-border py-4 last:border-b-0">
      <div className={`grid gap-4 md:grid-cols-[minmax(180px,1fr)_minmax(220px,280px)] ${align === 'start' ? 'items-start' : 'items-center'}`}>
        <div className="min-w-0">
          <div className="text-ui font-medium text-text">{label}</div>
          {description && (
            <p className="mt-1 max-w-[440px] text-caption leading-5 text-3">{description}</p>
          )}
        </div>
        <div className="min-w-0 justify-self-stretch md:justify-self-end">
          {control}
        </div>
      </div>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}
