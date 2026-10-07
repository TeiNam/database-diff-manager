import { Route, Routes } from 'react-router';
import { AppShell } from './layout/AppShell';
import { HistoryPage } from './pages/HistoryPage';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { ObjectHistoryPage } from './pages/ObjectHistoryPage';
import { SchemaPage } from './pages/SchemaPage';
import { UsersPage } from './pages/UsersPage';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<AppShell />}>
        <Route index element={<HomePage />} />
        <Route path="db/:dbId/schema/:schemaId" element={<SchemaPage />} />
        <Route path="db/:dbId/schema/:schemaId/history" element={<HistoryPage />} />
        <Route path="objects/:objectId" element={<ObjectHistoryPage />} />
        <Route path="admin/users" element={<UsersPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
