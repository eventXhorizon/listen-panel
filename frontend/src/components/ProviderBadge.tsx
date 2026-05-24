import type { LlmProvider } from '../types';

/**
 * Small inline tag showing which LLM provider answered. Surfaced on lookup
 * and quick-note results so the user can tell when DeepSeek is down and
 * they're reading fallback (Gemini) output.
 *
 * Visual choice: muted gray for primary (no news is good news), amber for
 * fallback (so it actually catches the eye).
 */
export default function ProviderBadge({ provider }: { provider: LlmProvider }) {
  if (provider === 'fallback') {
    return (
      <div className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">
        DeepSeek 不可用,由 <span className="font-medium">Gemini</span> 兜底分析
      </div>
    );
  }
  return (
    <div className="text-[11px] text-muted-foreground">由 DeepSeek 分析</div>
  );
}
