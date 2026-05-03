import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Library from './pages/Library';
import Editor from './pages/Editor';
import Reader from './pages/Reader';
import Vocab from './pages/Vocab';
import Review from './pages/Review';
import Settings from './pages/Settings';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Library />} />
          <Route path="new" element={<Editor />} />
          <Route path="m/:id" element={<Reader />} />
          <Route path="m/:id/edit" element={<Editor />} />
          <Route path="vocab" element={<Vocab />} />
          <Route path="review" element={<Review />} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
