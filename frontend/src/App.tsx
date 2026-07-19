import type { ReactNode } from 'react';
import {
  BrowserRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import Layout from './components/Layout';
import { AuthProvider } from './lib/auth';
import { useAuth } from './lib/auth-context';
import { Login, Register, Setup } from './pages/Auth';
import Library from './pages/Library';
import Editor from './pages/Editor';
import Reader from './pages/Reader';
import News from './pages/News';
import Vocab from './pages/Vocab';
import Notes from './pages/Notes';
import QuickNotes from './pages/QuickNotes';
import Review from './pages/Review';
import Settings from './pages/Settings';
import Writing from './pages/Writing';
import Cloze from './pages/Cloze';
import Essays, { EssaysIndex } from './pages/Essays';
import EssayDetail from './pages/EssayDetail';
import Tts from './pages/Tts';
import Speaking from './pages/Speaking';
import Recognize from './pages/Recognize';
import Shadowing from './pages/Shadowing';
import Interview from './pages/Interview';

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="login" element={<Login />} />
          <Route path="register" element={<Register />} />
          <Route path="setup" element={<Setup />} />
          <Route element={<RequireAuth />}>
            <Route element={<Layout />}>
              <Route index element={<Library />} />
              <Route path="new" element={<Editor />} />
              <Route path="m/:id" element={<Reader />} />
              <Route path="m/:id/edit" element={<Editor />} />
              <Route path="shadowing" element={<Shadowing />} />
              <Route path="news" element={<Navigate to="/news/en" replace />} />
              <Route path="news/:lang" element={<News />} />
              <Route path="vocab" element={<Vocab />} />
              <Route path="notes" element={<Notes />} />
              <Route path="quick-notes" element={<QuickNotes />} />
              <Route path="review" element={<Review />} />
              <Route path="writing" element={<Writing />} />
              <Route path="cloze" element={<Cloze />} />
              <Route path="essays" element={<Essays />}>
                <Route index element={<EssaysIndex />} />
                <Route path=":id" element={<EssayDetail />} />
              </Route>
              <Route path="tts" element={<Tts />} />
              <Route path="speaking" element={<Speaking />} />
              <Route path="recognize" element={<Recognize />} />
              <Route
                path="interview"
                element={
                  <FeatureRoute feature="interview">
                    <Interview />
                  </FeatureRoute>
                }
              />
              <Route path="settings" element={<Settings />} />
            </Route>
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

function RequireAuth() {
  const auth = useAuth();
  const location = useLocation();

  if (auth.loading) {
    return (
      <main className="min-h-screen bg-muted/50 flex items-center justify-center text-sm text-muted-foreground">
        加载中...
      </main>
    );
  }
  if (auth.needsSetup) return <Navigate to="/setup" replace />;
  if (!auth.user) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname + location.search }}
      />
    );
  }
  return <Outlet />;
}

/// Guards a route behind an app feature flag. When the flag is off, a direct
/// visit (typed URL, old bookmark) bounces to the bookshelf instead of loading
/// a module whose API is also disabled. `loading` holds the redirect until the
/// flags have actually been fetched, so an enabled feature isn't flashed away.
function FeatureRoute({
  feature,
  children,
}: {
  feature: 'interview';
  children: ReactNode;
}) {
  const auth = useAuth();
  if (auth.loading) return null;
  if (!auth.features[feature]) return <Navigate to="/" replace />;
  return <>{children}</>;
}
