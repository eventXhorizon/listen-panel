import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/auth-context';

const NAV_ITEMS = [
  { to: '/', label: '书架', end: true },
  { to: '/vocab', label: '生词本', end: false },
  { to: '/review', label: '复习', end: false },
];

export default function Layout() {
  const auth = useAuth();

  return (
    <div className="h-screen flex flex-col bg-stone-50 overflow-hidden">
      <header className="border-b border-stone-100 bg-white shrink-0">
        <div className="w-full px-8 h-14 flex items-center justify-between">
          <Link
            to="/"
            className="text-stone-900 font-medium tracking-tight text-[15px]"
          >
            Listen Panel
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `px-3 py-1.5 rounded-md transition ${
                    isActive
                      ? 'text-stone-900 bg-stone-100'
                      : 'text-stone-600 hover:bg-stone-100'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                `ml-1 px-2.5 py-1.5 rounded-md transition text-stone-500 ${
                  isActive ? 'bg-stone-100 text-stone-900' : 'hover:bg-stone-100'
                }`
              }
              title="设置"
            >
              设置
            </NavLink>
            <button
              onClick={() => auth.logout()}
              className="ml-1 px-2.5 py-1.5 rounded-md transition text-stone-500 hover:bg-stone-100"
              title={`当前用户:${auth.user?.display_name ?? ''}`}
            >
              {auth.user?.display_name ?? auth.user?.username} · 退出
            </button>
            <Link
              to="/new"
              className="ml-2 px-3 py-1.5 rounded-md border border-sky-200 bg-sky-50 text-sky-800 font-medium hover:bg-sky-100 transition"
            >
              + 新建
            </Link>
          </nav>
        </div>
      </header>
      <div className="flex-1 flex flex-col min-h-0">
        <Outlet />
      </div>
    </div>
  );
}
