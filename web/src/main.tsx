import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.tsx";
import { SessionProvider } from "./lib/session.tsx";
import { ToastProvider } from "./lib/toast.tsx";
import { ChatRunsProvider } from "./lib/chatRuns.tsx";
import { applyTheme } from "./lib/theme.ts";
import "./styles/app.css";

applyTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ToastProvider>
        <SessionProvider>
          {/* Above the router on purpose: an assistant turn keeps streaming
              while the user moves between pages. */}
          <ChatRunsProvider>
            <App />
          </ChatRunsProvider>
        </SessionProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
