import { Navigate, Route, Routes } from 'react-router';
import { LoginPage } from './auth/LoginPage';
import { OnboardingPage } from './auth/OnboardingPage';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { ImportPage } from './library/ImportPage';
import { ProcessingPage } from './library/ProcessingPage';
import { ShelfPage } from './library/ShelfPage';
import { ReaderPage } from './reader/ReaderPage';
import { StatsPage } from './reading-stats/StatsPage';
import { InterviewPage } from './user-books/InterviewPage';
import { ReadingSetupRoute } from './user-books/ReadingSetupRoute';
import { StrategyPage } from './user-books/StrategyPage';
import { TrialPage } from './user-books/TrialPage';
import { AgentDrivenReadingSetupPage } from './agent-driven-reading-setup/AgentDrivenReadingSetupPage';

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
        <Route path="/stats" element={<StatsPage />} />
        <Route path="/books/import" element={<ImportPage />} />
        <Route path="/books/:bookId/processing" element={<ProcessingPage />} />
        <Route path="/user-books/:id/reading-setup" element={<AgentDrivenReadingSetupPage />} />
        <Route path="/user-books/:id" element={<ReadingSetupRoute />}>
          <Route path="interview" element={<InterviewPage />} />
          <Route path="strategy" element={<StrategyPage />} />
          <Route path="trial" element={<TrialPage />} />
          <Route path="read" element={<ReaderPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate replace to="/" />} />
    </Routes>
  );
}
