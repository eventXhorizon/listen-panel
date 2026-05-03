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
import Vocab from './pages/Vocab';
import Review from './pages/Review';
import Settings from './pages/Settings';

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
              <Route path="vocab" element={<Vocab />} />
              <Route path="review" element={<Review />} />
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
      <main className="min-h-screen bg-stone-50 flex items-center justify-center text-sm text-stone-500">
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
