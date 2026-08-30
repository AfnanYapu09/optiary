import { useSearchParams } from "react-router-dom";
import AssistantPanel from "../components/AssistantPanel.tsx";

/**
 * The assistant on its own page, talking to the `global` thread so it can range
 * across the whole dataset rather than one day.
 */
export default function AssistantPage() {
  const [params] = useSearchParams();
  const question = params.get("q") ?? undefined;

  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0, background: "var(--bg)" }}>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          maxWidth: 900,
          margin: "0 auto",
          display: "flex",
          borderLeft: "1px solid var(--line)",
          borderRight: "1px solid var(--line)",
        }}
      >
        <AssistantPanel
          thread="global"
          subtitle="เห็นภาพ โน้ต และตัวเลขทั้งหมดของคุณ"
          initialQuestion={question}
        />
      </div>
    </div>
  );
}
