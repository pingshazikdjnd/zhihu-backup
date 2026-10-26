import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout.js";
import ErrorBoundary from "./components/ErrorBoundary.js";
import DashboardPage from "./pages/DashboardPage.js";
import ContentsPage from "./pages/ContentsPage.js";
import ContentDetailPage from "./pages/ContentDetailPage.js";
import CollectionsPage from "./pages/CollectionsPage.js";
import CollectionDetailPage from "./pages/CollectionDetailPage.js";
import ChangesPage from "./pages/ChangesPage.js";
import AuthPage from "./pages/AuthPage.js";
import QuestionsPage from "./pages/QuestionsPage.js";

export default function App() {
  return (
    <Layout>
      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/contents" element={<ContentsPage />} />
          <Route path="/contents/:pk" element={<ContentDetailPage />} />
          <Route path="/collections" element={<CollectionsPage />} />
          <Route path="/collections/:id" element={<CollectionDetailPage />} />
          <Route path="/questions" element={<QuestionsPage />} />
          <Route path="/questions/:id" element={<QuestionsPage />} />
          <Route path="/changes" element={<ChangesPage />} />
          <Route path="/auth" element={<AuthPage />} />
          <Route
            path="*"
            element={<div className="empty-state">页面不存在，检查一下地址。</div>}
          />
        </Routes>
      </ErrorBoundary>
    </Layout>
  );
}
