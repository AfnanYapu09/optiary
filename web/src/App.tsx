import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useSession } from "./lib/session.tsx";
import AppShell from "./components/AppShell.tsx";
import LoginPage from "./pages/LoginPage.tsx";
import OverviewPage from "./pages/OverviewPage.tsx";
import CapturePage from "./pages/CapturePage.tsx";
import ComparePage from "./pages/ComparePage.tsx";
import ChartPage from "./pages/ChartPage.tsx";
import AssistantPage from "./pages/AssistantPage.tsx";
import SettingsPage from "./pages/SettingsPage.tsx";
import { todayIso } from "./lib/format.ts";

function Booting() {
  return (
    <div className="empty" style={{ height: "100vh" }}>
      <span className="spin" />
      กำลังเปิดสมุดวิจัย…
    </div>
  );
}

export default function App() {
  const { user, loading } = useSession();
  const location = useLocation();

  if (loading) return <Booting />;

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="*"
          element={<Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname)}`} replace />}
        />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route element={<AppShell />}>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/day" element={<Navigate to={`/day/${todayIso()}`} replace />} />
        <Route path="/day/:date" element={<CapturePage />} />
        <Route path="/compare" element={<ComparePage />} />
        <Route path="/chart" element={<ChartPage />} />
        <Route path="/assistant" element={<AssistantPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
