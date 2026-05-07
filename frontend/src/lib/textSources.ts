import type { MaterialTextSource } from '../types';

const TEXT_SOURCE_LABELS: Record<MaterialTextSource, string> = {
  manual: '官方稿',
  manual_subtitle: '人工字幕',
  auto_subtitle: '自动字幕',
  asr: 'ASR',
};

export function textSourceLabel(source: MaterialTextSource): string {
  return TEXT_SOURCE_LABELS[source];
}
