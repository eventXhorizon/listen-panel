const SENT_END = /[.!?。!?…](?=["'"'"\)\]]?(\s|$))/g;

export function findSentence(text: string, offset: number): string {
  let segStart = 0;
  let m: RegExpExecArray | null;
  SENT_END.lastIndex = 0;
  while ((m = SENT_END.exec(text)) !== null) {
    const segEnd = m.index + 1;
    if (offset < segEnd) {
      return text.slice(segStart, segEnd).trim();
    }
    let next = segEnd;
    while (next < text.length && /\s/.test(text[next])) next++;
    segStart = next;
  }
  return text.slice(segStart).trim();
}
