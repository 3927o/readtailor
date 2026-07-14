import { Navigate, Route, Routes } from 'react-router';
import { LoginPage } from './auth/LoginPage';
import { OnboardingPage } from './auth/OnboardingPage';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { ImportPage } from './library/ImportPage';
import { ProcessingPage } from './library/ProcessingPage';
import { ShelfPage } from './library/ShelfPage';
import { ReaderPage } from './reader/ReaderPage';
import { InterviewPage } from './user-books/InterviewPage';
import { StrategyPage } from './user-books/StrategyPage';
import { TrialPage } from './user-books/TrialPage';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/onboarding"
        element={<ProtectedRoute requireCompletedProfile={false}><OnboardingPage /></ProtectedRoute>}
      />
      <Route element={<ProtectedRoute />}>
        <Route path="/" element={<ShelfPage />} />
        <Route path="/books/import" element={<ImportPage />} />
        <Route path="/books/:bookId/processing" element={<ProcessingPage />} />
        <Route path="/user-books/:id/interview" element={<InterviewPage />} />
        <Route path="/user-books/:id/strategy" element={<StrategyPage />} />
        <Route path="/user-books/:id/trial" element={<TrialPage />} />
        <Route path="/user-books/:id/read" element={<ReaderPage />} />
      </Route>
      <Route path="*" element={<Navigate replace to="/" />} />
    </Routes>
  );
}
