/// Strip markdown syntax for TTS so Azure doesn't pronounce `**` as
/// "asterisk asterisk" or read multi-line code blocks word-by-word. The
/// rules are simple and lossy — fine because TTS only needs to convey the
/// prose, not the formatting.
///
///  - Fenced code blocks (```...```)  → " (code block omitted) "
///  - Inline backtick spans            → kept as-is; backend `prepare_for_tts`
///                                       expands symbols like `?` → "question mark"
///  - Bold (`**x**`) / italic (`*x*` / `_x_`) → strip the markers, keep content
///  - Headings (`### x`) → strip the leading #s
///  - List markers (`- `, `1. `) → strip
export function stripMarkdownForTts(text: string): string {
  let out = text;

  // Drop fenced code blocks. Tag them so the listener knows something was
  // skipped, but don't read code aloud.
  out = out.replace(/```[\s\S]*?```/g, ' (code block omitted) ');

  // Headings: `### Foo` -> `Foo`
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, '');

  // Bold / italic: `**x**`, `__x__`, `*x*`, `_x_`  -> `x`
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
  out = out.replace(/__([^_]+)__/g, '$1');
  out = out.replace(/(?<!\*)\*(?!\*)([^*\n]+)\*(?!\*)/g, '$1');
  out = out.replace(/(?<!_)_(?!_)([^_\n]+)_(?!_)/g, '$1');

  // List markers at line start
  out = out.replace(/^\s*[-*+]\s+/gm, '');
  out = out.replace(/^\s*\d+\.\s+/gm, '');

  // Collapse 3+ newlines from heading/list strips back to two
  out = out.replace(/\n{3,}/g, '\n\n');

  return out.trim();
}
