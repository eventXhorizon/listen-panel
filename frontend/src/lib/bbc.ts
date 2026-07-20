import type { Material } from '../types';

/// BBC "6 Minute English" episodes are bulk-imported by scripts/bbc_import and
/// stamped with a provenance block in `notes`:
///
///     BBC 6 Minute English
///     date: 2020-01-02
///     src: 200102_6min_english_yawning
///
/// There are ~550 of them, so they live in the 影子练习 catalog only and are kept
/// out of the 书架 — otherwise they bury the user's own handful of materials.
const BBC_MARKER = 'BBC 6 Minute English';

export function isBbcMaterial(m: Material): boolean {
  return (m.notes ?? '').includes(BBC_MARKER);
}

/// The episode's air date (from the filename, not the folder — folder dates are
/// batch dates). Drives the year/month grouping in the 影子练习 tree.
export function bbcDate(m: Material): string | null {
  const match = m.notes?.match(/date:\s*(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}
