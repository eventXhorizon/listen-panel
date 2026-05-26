import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, matchPath, useLocation, useNavigate } from 'react-router-dom';
import { LogOut, Pencil, Plus, Settings as SettingsIcon, User } from 'lucide-react';
import { useAuth } from '../lib/auth-context';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import QuickNoteDialog from './QuickNoteDialog';

const NAV_ITEMS = [
  { to: '/', label: '书架', end: true },
  { to: '/news', label: '新闻', end: false },
  { to: '/vocab', label: '生词本', end: false },
  { to: '/notes', label: '笔记', end: false },
  { to: '/quick-notes', label: '随手记', end: false },
  { to: '/writing', label: '写作', end: false },
  { to: '/cloze', label: '填空', end: false },
  { to: '/review', label: '复习', end: false },
];

// Routes that take over the viewport (Reader, Editor) — no global chrome.
const FULLSCREEN_ROUTES = ['/m/:id', '/m/:id/edit', '/new'];

function isFullscreenRoute(pathname: string) {
  return FULLSCREEN_ROUTES.some((pattern) => matchPath(pattern, pathname));
}

export default function Layout() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const fullscreen = isFullscreenRoute(location.pathname);
  const [quickNoteOpen, setQuickNoteOpen] = useState(false);

  // Global Cmd/Ctrl + Shift + J opens the quick-note dialog from any page.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setQuickNoteOpen(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const displayName = auth.user?.display_name ?? auth.user?.username ?? '';
  const avatarInitial = displayName.trim().charAt(0).toUpperCase() || '?';

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      {!fullscreen && (
        <header className="border-b border-border bg-card shrink-0">
          <div className="w-full px-4 py-2 md:px-6 md:py-0 md:h-14 flex flex-col gap-2 md:flex-row md:items-center md:gap-6">
            <Link
              to="/"
              className="text-foreground font-medium tracking-tight text-[15px] shrink-0"
            >
              Listen Panel
            </Link>

            <nav className="-mx-4 flex items-center gap-1 overflow-x-auto px-4 pb-1 text-sm md:mx-0 md:flex-1 md:justify-center md:overflow-visible md:px-0 md:pb-0">
              {NAV_ITEMS.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    cn(
                      'shrink-0 px-3 py-1.5 rounded-md transition text-muted-foreground hover:text-foreground hover:bg-accent',
                      isActive && 'text-foreground bg-accent font-medium'
                    )
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>

            <div className="flex items-center gap-2 shrink-0 md:ml-auto">
              <Button
                asChild
                size="sm"
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                <Link to="/new">
                  <Plus className="size-4" />
                  新建
                </Link>
              </Button>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label="账户菜单"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-accent text-sm font-medium text-foreground hover:bg-accent/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  >
                    {avatarInitial}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuLabel className="flex items-center gap-2 font-normal">
                    <User className="size-4 text-muted-foreground" />
                    <span className="truncate">{displayName || '未登录'}</span>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => navigate('/settings')}>
                    <SettingsIcon className="size-4" />
                    设置
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => auth.logout()}
                    className="text-destructive focus:text-destructive"
                  >
                    <LogOut className="size-4" />
                    退出登录
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </header>
      )}

      <div className="flex-1 flex flex-col min-h-0">
        <Outlet />
      </div>

      {/* Floating quick-note button. Visible on every page including
          fullscreen routes like Reader/Editor, so the user can jot down a
          sentence they saw elsewhere without losing context. */}
      <button
        type="button"
        onClick={() => setQuickNoteOpen(true)}
        aria-label="随手记 (⇧⌘J)"
        title="随手记 (⇧⌘J)"
        className="fixed bottom-5 left-5 z-40 inline-flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-2 text-xs font-medium text-primary-foreground shadow-lg shadow-black/15 transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <Pencil className="size-3.5" />
        随手记
      </button>

      {quickNoteOpen && (
        <QuickNoteDialog onClose={() => setQuickNoteOpen(false)} />
      )}
    </div>
  );
}
