import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { useSession } from "../lib/session.tsx";
import { api } from "../lib/api.ts";
import { stampDate, todayIso } from "../lib/format.ts";
import type { Streak } from "../lib/types.ts";

const NAV = [
  { to: "/", label: "ภาพรวม", short: "ภาพรวม", end: true },
  { to: "/day", label: "จดบันทึกวันนี้", short: "จดบันทึก", end: false },
  { to: "/compare", label: "เปรียบเทียบรูปภาพ", short: "เทียบภาพ", end: false },
  { to: "/chart", label: "กราฟสรุป", short: "กราฟ", end: false },
  { to: "/assistant", label: "AI ผู้ช่วยวิจัย", short: "ผู้ช่วย", end: false },
  { to: "/settings", label: "ตั้งค่า", short: "ตั้งค่า", end: false },
];

function useClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return `${stampDate(todayIso())} · ${String(now.getHours()).padStart(2, "0")}:${String(
    now.getMinutes(),
  ).padStart(2, "0")}`;
}

export default function AppShell() {
  const { user, signOut } = useSession();
  const navigate = useNavigate();
  const clock = useClock();
  const [streak, setStreak] = useState<Streak | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    api
      .calendar(todayIso().slice(0, 7))
      .then((res) => setStreak(res.streak))
      .catch(() => setStreak(null));
  }, []);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="diamond" />
          <b>OPTIARY</b>
          <span className="contract">{user?.settings.contract ?? "GC"} · GOLD FUTURES</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <form
            className="search"
            onSubmit={(event) => {
              event.preventDefault();
              if (query.trim()) navigate(`/assistant?q=${encodeURIComponent(query.trim())}`);
            }}
          >
            <span className="ring" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="ค้นหาวัน โน้ต หรือแท็ก"
              aria-label="ค้นหา"
            />
          </form>
          <span className="mono desktop-only" style={{ fontSize: 11, color: "var(--t-45)" }}>
            {clock}
          </span>
          <button
            className="avatar"
            title={`${user?.name} · ออกจากระบบ`}
            onClick={() => {
              void signOut();
            }}
            style={
              user?.picture
                ? { backgroundImage: `url(${user.picture})`, backgroundSize: "cover" }
                : undefined
            }
            aria-label="ออกจากระบบ"
          />
        </div>
      </header>

      <div className="body">
        <nav className="sidenav">
          <span className="eyebrow">WORKSPACE</span>
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end}>
              <i />
              <span>{item.label}</span>
            </NavLink>
          ))}
          <div style={{ flex: 1 }} />
          <div className="dataset-card">
            <span className="eyebrow">DATASET</span>
            <b>{(streak?.totalImages ?? 0).toLocaleString("en-US")}</b>
            <small>ภาพที่บันทึกแล้ว · {streak?.totalDays ?? 0} วัน</small>
          </div>
        </nav>

        <main className="main">
          <Outlet />
        </main>
      </div>

      <nav className="mobile-tabs mobile-only">
        {NAV.slice(0, 5).map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end}>
            {item.short}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
