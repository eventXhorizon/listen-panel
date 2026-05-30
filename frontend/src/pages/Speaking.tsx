import { useEffect, useState } from 'react';
import type { MaterialLanguage } from '../types';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import PronunciationCheck from '../components/PronunciationCheck';

const TEXT_STORAGE_KEY = 'speaking-reference-text';
const LANG_STORAGE_KEY = 'speaking-language';

const LANGS: { value: MaterialLanguage; label: string }[] = [
  { value: 'en', label: '英语' },
  { value: 'ja', label: '日语' },
];

export default function Speaking() {
  const [text, setText] = useState(() => localStorage.getItem(TEXT_STORAGE_KEY) ?? '');
  const [language, setLanguage] = useState<MaterialLanguage>(() => {
    const stored = localStorage.getItem(LANG_STORAGE_KEY);
    return stored === 'ja' ? 'ja' : 'en';
  });

  useEffect(() => {
    localStorage.setItem(TEXT_STORAGE_KEY, text);
  }, [text]);
  useEffect(() => {
    localStorage.setItem(LANG_STORAGE_KEY, language);
  }, [language]);

  const trimmed = text.trim();

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <div className="mb-6 flex items-baseline justify-between">
          <div>
            <h1 className="text-2xl font-medium tracking-tight text-foreground">
              口语练习
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              粘贴或输入一段文本,点击「朗读测评」录音,系统会给出发音评分并标出读错的词。
            </p>
          </div>
          <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
            {LANGS.map((l) => (
              <button
                key={l.value}
                type="button"
                onClick={() => setLanguage(l.value)}
                className={cn(
                  'rounded px-3 py-1 text-xs transition',
                  language === l.value
                    ? 'bg-accent font-medium text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {l.label}
              </button>
            ))}
          </div>
        </div>

        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="在这里输入要朗读的文本..."
          className="min-h-[200px] resize-y text-base leading-7"
        />

        <div className="mt-4">
          <PronunciationCheck
            key={`${language}:${trimmed}`}
            text={trimmed}
            language={language}
          />
        </div>
      </div>
    </main>
  );
}
