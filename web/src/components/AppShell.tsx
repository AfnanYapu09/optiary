import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { useSession } from "../lib/session.tsx";
import { api } from "../lib/api.ts";
import { num } from "../lib/format.ts";
import type { Streak } from "../lib/types.ts";

/** The rail is grouped by *when* you reach for a page: every day, vs. when you
 * sit down to analyse. Six flat links gave no such hint. */
const NAV_GROUPS: Array<{ group: string; items: Array<{ to: string; label: string; short: string; end: boolean }> }> = [
  {
    group: "ทุกวัน",
    items: [
      { to: "/", label: "ภาพรวม", short: "ภาพรวม", end: true },
      { to: "/day", label: "บันทึกวันนี้", short: "บันทึก", end: false },
    ],
  },
  {
    group: "วิเคราะห์",
    items: [
      { to: "/chart", label: "กราฟสรุป", short: "กราฟ", end: false },
      { to: "/compare", label: "เทียบภาพ", short: "เทียบ", end: false },
      { to: "/assistant", label: "ผู้ช่วย AI", short: "ผู้ช่วย", end: false },
    ],
  },
];

const MOBILE_TABS = NAV_GROUPS.flatMap((g) => g.items);

function useClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 20_000);
    return () => window.clearInterval(timer);
  }, []);
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

export default function AppShell() {
  const { user, signOut } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const clock = useClock();
  const [streak, setStreak] = useState<Streak | null>(null);
  const [pcRatio, setPcRatio] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const profileRef = useRef<HTMLDivElement>(null);

  // Stats carry the whole-dataset totals; the calendar's streak is month-scoped
  // and would read 0 on the first of a month.
  useEffect(() => {
    api
      .stats(365)
      .then((res) => {
        setStreak(res.streak);
        setPcRatio(res.latestPcRatio);
      })
      .catch(() => {
        setStreak(null);
        setPcRatio(null);
      });
  }, []);

  // "/" jumps to search the way it does in every terminal-shaped tool.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Profile menu: closes on outside click, on Escape, and whenever the route
  // changes so it never lingers over a page it no longer belongs to.
  useEffect(() => setMenuOpen(false), [location.pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!profileRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="diamond" />
          <b>OPTIARY</b>
          <span className="ticker desktop-only">
            <span className="dot" />
            {user?.settings.contract ?? "GC"}
            <em>P/C</em>
            {num(pcRatio, 2)}
          </span>
        </div>

        <div className="topbar-right">
          <form
            className="search"
            onSubmit={(event) => {
              event.preventDefault();
              if (query.trim()) navigate(`/assistant?q=${encodeURIComponent(query.trim())}`);
            }}
          >
            <span className="ring" />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="ถามข้อมูลย้อนหลัง…"
              aria-label="ค้นหา"
            />
            <kbd>/</kbd>
          </form>
          <span className="clock mono desktop-only">{clock}</span>

          {/* The avatar used to sign the user out on a single click, with no
              confirmation. It opens a menu now — which is also the only way to
              reach settings on a phone, where the rail is hidden. */}
          <div className="profile" ref={profileRef}>
            <button
              className="avatar"
              title={user?.name}
              onClick={() => setMenuOpen((open) => !open)}
              style={
                user?.picture
                  ? { backgroundImage: `url(${user.picture})`, backgroundSize: "cover" }
                  : undefined
              }
              aria-label="เมนูบัญชี"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            />

            {menuOpen ? (
              <div className="profile-menu" role="menu">
                <div className="profile-who">
                  <b>{user?.name}</b>
                  <span className="mono">{user?.email}</span>
                </div>
                <button role="menuitem" onClick={() => navigate("/settings")}>
                  ตั้งค่า
                </button>
                <button
                  role="menuitem"
                  className="danger"
                  onClick={() => {
                    setMenuOpen(false);
                    void signOut();
                  }}
                >
                  ออกจากระบบ
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <div className="body">
        <nav className="sidenav">
          {NAV_GROUPS.map((group) => (
            <div key={group.group} style={{ display: "contents" }}>
              <span className="eyebrow nav-group">{group.group}</span>
              {group.items.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.end}>
                  <i />
                  <span>{item.label}</span>
                </NavLink>
              ))}
            </div>
          ))}

          <div style={{ flex: 1, minHeight: 14 }} />

          {/* Settings lives in the profile menu now, so the rail is purely
              "places to work". */}
          <div className="dataset-card">
            <span className="eyebrow">ชุดข้อมูล</span>
            <b>{(streak?.totalImages ?? 0).toLocaleString("en-US")}</b>
            <small>ภาพ · {streak?.totalDays ?? 0} วันที่บันทึก</small>
          </div>
        </nav>

        <main className="main">
          <Outlet />
        </main>
      </div>

      <nav className="mobile-tabs mobile-only">
        {MOBILE_TABS.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end}>
            {item.short}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
