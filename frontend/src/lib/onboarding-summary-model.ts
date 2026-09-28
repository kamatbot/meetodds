interface OnboardingSummaryModelStatusInput {
  selectedModel: string;
  recommendedModel: string;
  selectedModelReady: boolean;
}

interface OnboardingSummaryModelStatus {
  selectedSummaryModel: string;
  summaryModelDownloaded: boolean;
}

// ponytail: the built-in summary models (and their download sizes) were removed.
// Kept only for this branch's pre-merge onboarding imports; delete once nothing imports it.
const SUMMARY_MODEL_SIZES_MB: Record<string, number> = {};

export function resolveOnboardingSummaryModelStatus({
  selectedModel,
  recommendedModel,
  selectedModelReady,
}: OnboardingSummaryModelStatusInput): OnboardingSummaryModelStatus {
  const selectedSummaryModel = selectedModel || recommendedModel;

  return {
    selectedSummaryModel,
    summaryModelDownloaded: Boolean(selectedSummaryModel && selectedModelReady),
  };
}

export function getSummaryModelSizeMb(model: string): number {
  return SUMMARY_MODEL_SIZES_MB[model] ?? 0;
}

export function getDownloadTotalMb(totalMb: number | null | undefined, model: string): number {
  return totalMb || getSummaryModelSizeMb(model);
}

export function formatSummaryModelSizeLabelFromMb(sizeMb: number): string {
  if (sizeMb === 0) {
    return '';
  }

  if (sizeMb >= 1024) {
    return `~${(sizeMb / 1024).toFixed(1)} GiB`;
  }

  return `~${sizeMb} MiB`;
}

export function getSummaryModelSizeLabel(model: string): string {
  return formatSummaryModelSizeLabelFromMb(getSummaryModelSizeMb(model));
}
