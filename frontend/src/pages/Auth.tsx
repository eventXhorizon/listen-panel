import { useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth-context';

export function Login() {
  const auth = useAuth();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (auth.loading) return <AuthLoading />;
  if (auth.needsSetup) return <Navigate to="/setup" replace />;
  if (auth.user) {
    const to = (location.state as { from?: string } | null)?.from ?? '/';
    return <Navigate to={to} replace />;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await auth.login(username, password);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="登录">
      <form onSubmit={submit} className="space-y-4">
        <AuthField label="用户名">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            className="w-full bg-white border border-stone-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-stone-400"
          />
        </AuthField>
        <AuthField label="密码">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full bg-white border border-stone-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-stone-400"
          />
        </AuthField>
        {err && <p className="text-sm text-rose-600">{err}</p>}
        <button
          disabled={busy}
          className="w-full px-4 py-2 rounded-md bg-stone-900 text-white text-sm hover:bg-stone-700 disabled:opacity-50"
        >
          {busy ? '登录中...' : '登录'}
        </button>
        <div className="text-center text-xs text-stone-500">
          <Link to="/register" className="hover:text-stone-900 underline">
            创建新账户
          </Link>
        </div>
      </form>
    </AuthShell>
  );
}

export function Setup() {
  const auth = useAuth();
  const [form, setForm] = useState({ username: '', displayName: '', password: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (auth.loading) return <AuthLoading />;
  if (!auth.needsSetup) return <Navigate to={auth.user ? '/' : '/login'} replace />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await auth.setup(form.username, form.displayName, form.password);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="初始化账户">
      <AuthForm
        form={form}
        setForm={setForm}
        submit={submit}
        busy={busy}
        err={err}
        submitLabel="创建管理员账户"
      />
    </AuthShell>
  );
}

export function Register() {
  const auth = useAuth();
  const [form, setForm] = useState({ username: '', displayName: '', password: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (auth.loading) return <AuthLoading />;
  if (auth.needsSetup) return <Navigate to="/setup" replace />;
  if (auth.user) return <Navigate to="/" replace />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await auth.register(form.username, form.displayName, form.password);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="创建账户">
      <AuthForm
        form={form}
        setForm={setForm}
        submit={submit}
        busy={busy}
        err={err}
        submitLabel="创建账户"
      />
      <div className="text-center text-xs text-stone-500 mt-4">
        <Link to="/login" className="hover:text-stone-900 underline">
          已有账户,去登录
        </Link>
      </div>
    </AuthShell>
  );
}

function AuthLoading() {
  return (
    <main className="min-h-screen bg-stone-50 flex items-center justify-center text-sm text-stone-500">
      加载中...
    </main>
  );
}

function AuthShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-stone-50 flex items-center justify-center px-6">
      <div className="w-full max-w-sm bg-white border border-stone-200 rounded-lg p-6">
        <h1 className="text-xl font-medium text-stone-900 mb-5">{title}</h1>
        {children}
      </div>
    </main>
  );
}

function AuthForm({
  form,
  setForm,
  submit,
  busy,
  err,
  submitLabel,
}: {
  form: { username: string; displayName: string; password: string };
  setForm: React.Dispatch<
    React.SetStateAction<{ username: string; displayName: string; password: string }>
  >;
  submit: (e: React.FormEvent) => void;
  busy: boolean;
  err: string | null;
  submitLabel: string;
}) {
  return (
    <form onSubmit={submit} className="space-y-4">
      <AuthField label="用户名">
        <input
          value={form.username}
          onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
          autoFocus
          className="w-full bg-white border border-stone-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-stone-400"
        />
      </AuthField>
      <AuthField label="显示名">
        <input
          value={form.displayName}
          onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
          placeholder="留空则使用用户名"
          className="w-full bg-white border border-stone-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-stone-400"
        />
      </AuthField>
      <AuthField label="密码">
        <input
          type="password"
          value={form.password}
          onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
          className="w-full bg-white border border-stone-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-stone-400"
        />
      </AuthField>
      {err && <p className="text-sm text-rose-600">{err}</p>}
      <button
        disabled={busy}
        className="w-full px-4 py-2 rounded-md bg-stone-900 text-white text-sm hover:bg-stone-700 disabled:opacity-50"
      >
        {busy ? '提交中...' : submitLabel}
      </button>
    </form>
  );
}

function AuthField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-stone-800 mb-2">{label}</span>
      {children}
    </label>
  );
}
