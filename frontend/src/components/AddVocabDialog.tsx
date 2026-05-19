import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { lookupWord } from '../lib/llm';
import { createVocab } from '../api';
import type { MaterialLanguage } from '../types';
import { languageAdapter } from '../lib/languages';
import SpeakButton from './SpeakButton';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

interface Props {
  word: string;
  context: string;
  materialId: number;
  language?: MaterialLanguage;
  onClose: () => void;
  onSaved: () => void;
}

export default function AddVocabDialog({
  word,
  context,
  materialId,
  language = 'en',
  onClose,
  onSaved,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lemma, setLemma] = useState('');
  const [phonetic, setPhonetic] = useState('');
  const [pos, setPos] = useState('');
  const [definitionZh, setDefinitionZh] = useState('');
  const [definitionEn, setDefinitionEn] = useState('');
  const [exampleZh, setExampleZh] = useState('');
  const [contextEdit, setContextEdit] = useState(context);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await lookupWord(word, context, language);
        if (cancelled) return;
        setLemma(r.lemma || word);
        setPhonetic(r.phonetic ?? '');
        setPos(r.pos ?? '');
        setDefinitionZh(r.definition_zh ?? '');
        setDefinitionEn(r.definition_en ?? '');
        setExampleZh(r.example_zh ?? '');
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [word, context, language]);

  async function save() {
    if (!definitionZh.trim()) {
      alert('请填写中文释义');
      return;
    }
    setSaving(true);
    try {
      const adapter = languageAdapter(language);
      await createVocab({
        word: adapter.normalizeTerm(word),
        language,
        lemma: lemma.trim() || word,
        phonetic: phonetic.trim() || undefined,
        pos: pos.trim() || undefined,
        definition_zh: definitionZh.trim(),
        definition_en: definitionEn.trim() || undefined,
        example_zh: exampleZh.trim() || undefined,
        context: contextEdit.trim(),
        material_id: materialId,
        mastery: 0,
      });
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  const keyMissing = (error ?? '').toLowerCase().includes('not configured');

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle className="text-base font-medium">加为生词</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 overflow-y-auto px-6 py-5">
          <div>
            <div className="mb-1 text-xs text-muted-foreground">选中</div>
            <div className="flex items-center gap-2">
              <div className="break-words text-xl font-medium text-foreground">
                {word}
              </div>
              <SpeakButton word={word} materialId={materialId} language={language} />
            </div>
          </div>

          {loading && (
            <div className="animate-pulse py-6 text-center text-sm text-muted-foreground">
              DeepSeek 查询中...
            </div>
          )}

          {error && (
            <div className="rounded border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              <div>{error}</div>
              {keyMissing && (
                <Link
                  to="/settings"
                  onClick={onClose}
                  className="mt-1 inline-block underline"
                >
                  去设置 →
                </Link>
              )}
            </div>
          )}

          {!loading && !error && (
            <>
              <div className="grid grid-cols-3 gap-3">
                <Field label="原形" value={lemma} onChange={setLemma} />
                <Field label="词性" value={pos} onChange={setPos} />
                <Field label="音标" value={phonetic} onChange={setPhonetic} mono />
              </div>
              <FieldArea
                label="中文释义 *"
                value={definitionZh}
                onChange={setDefinitionZh}
                rows={2}
              />
              <FieldArea
                label="英文释义"
                value={definitionEn}
                onChange={setDefinitionEn}
                rows={2}
              />
              <FieldArea
                label="上下文(原句)"
                value={contextEdit}
                onChange={setContextEdit}
                rows={3}
              />
              <FieldArea
                label="原句中文翻译"
                value={exampleZh}
                onChange={setExampleZh}
                rows={2}
              />
            </>
          )}
        </div>

        <DialogFooter className="border-t border-border px-6 py-3">
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={save} disabled={loading || saving || !!error}>
            {saving ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  value,
  onChange,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  mono?: boolean;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn('h-8 px-2 text-sm', mono && 'font-mono')}
      />
    </label>
  );
}

function FieldArea({
  label,
  value,
  onChange,
  rows,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows: number;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        className="resize-y px-2 py-1.5 text-sm leading-relaxed"
      />
    </label>
  );
}
