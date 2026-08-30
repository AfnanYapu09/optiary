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
    <div className="assistant-page">
      <AssistantPanel
        thread="global"
        subtitle="เห็นภาพ โน้ต และตัวเลขทั้งหมดของคุณ"
        initialQuestion={question}
      />
    </div>
  );
}
