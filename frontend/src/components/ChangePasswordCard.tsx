import { useState } from 'react';
import { changePassword } from '../api';

/// Self-contained "修改密码" card. Available to every logged-in user (the
/// Settings page gates its credential sections behind admin, but changing your
/// own password should not need admin), so it's rendered in both branches.
export default function ChangePasswordCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit() {
    setMsg(null);
    if (next.length < 8) {
      setMsg({ ok: false, text: '新密码至少 8 位' });
      return;
    }
    if (next !== confirm) {
      setMsg({ ok: false, text: '两次输入的新密码不一致' });
      return;
    }
    setBusy(true);
    try {
      await changePassword(current, next);
      setMsg({ ok: true, text: '密码已更新' });
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message || '修改失败' });
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    'w-full bg-card border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:border-border';

  return (
    <section className="bg-card border border-border rounded-lg p-5">
      <div className="mb-4">
        <h2 className="text-sm font-medium text-foreground">修改密码</h2>
      </div>
      <div className="max-w-sm space-y-3">
        <label className="block">
          <div className="mb-1 text-xs text-muted-foreground">当前密码</div>
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            className={inputCls}
          />
        </label>
        <label className="block">
          <div className="mb-1 text-xs text-muted-foreground">新密码(至少 8 位)</div>
          <input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            className={inputCls}
          />
        </label>
        <label className="block">
          <div className="mb-1 text-xs text-muted-foreground">确认新密码</div>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            className={inputCls}
          />
        </label>
        {msg && (
          <div className={msg.ok ? 'text-xs text-emerald-600' : 'text-xs text-destructive'}>
            {msg.text}
          </div>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={busy || !current || !next}
          className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? '保存中...' : '更新密码'}
        </button>
      </div>
    </section>
  );
}
