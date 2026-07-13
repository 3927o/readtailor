import { Route, Routes } from 'react-router';
import { ImportPage } from './library/ImportPage';
import { ProcessingPage } from './library/ProcessingPage';
import { ShelfPage } from './library/ShelfPage';
import { ReaderPage } from './reader/ReaderPage';

export function App() {
  return (
    <Routes>
      <Route path="/books/import" element={<ImportPage />} />
      <Route path="/books/:bookId/processing" element={<ProcessingPage />} />
      <Route path="/books/:bookId/read" element={<ReaderPage />} />
      <Route path="*" element={<ShelfPage />} />
    </Routes>
  );
}
