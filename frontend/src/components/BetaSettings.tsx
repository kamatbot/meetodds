'use client';

import { AlertCircle, FlaskConical } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import SettingRow from '@/components/Settings/SettingRow';
import { useConfig } from '@/contexts/ConfigContext';
import {
  type BetaFeatureKey,
  BETA_FEATURE_NAMES,
  BETA_FEATURE_DESCRIPTIONS,
} from '@/types/betaFeatures';

export function BetaSettings() {
  const { betaFeatures, toggleBetaFeature } = useConfig();
  const featureOrder: BetaFeatureKey[] = ['importAndRetranscribe'];

  return (
    <div>
      <div className="mb-2 flex items-start gap-2 rounded-control border border-warn/30 bg-warn/10 px-3 py-2.5 text-caption text-2">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warn" strokeWidth={1.75} />
        <p>
          Labs features are still being tested and may change or fail. Existing meetings are not altered when a flag is disabled.
        </p>
      </div>

      {featureOrder.map((featureKey) => (
        <SettingRow
          key={featureKey}
          label={BETA_FEATURE_NAMES[featureKey]}
          description={BETA_FEATURE_DESCRIPTIONS[featureKey]}
          control={(
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded-full bg-warn/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-warn">
                <FlaskConical className="h-3 w-3" strokeWidth={1.75} /> Labs
              </span>
              <Switch
                checked={betaFeatures[featureKey]}
                onCheckedChange={(checked) => toggleBetaFeature(featureKey, checked)}
              />
            </div>
          )}
        />
      ))}
    </div>
  );
}
