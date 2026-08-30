import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api.ts";
import { useToast } from "../lib/toast.tsx";
import { useSession } from "../lib/session.tsx";
import {
  DOW_LABELS,
  fullThaiDate,
  monthGrid,
  monthOf,
  monthTitle,
  shiftMonth,
  todayIso,
} from "../lib/format.ts";
import { IMAGE_KINDS, SLOTS, type CalendarDay, type DayRecord, type Streak } from "../lib/types.ts";
import "../styles/overview.css";

const FULL_DAY = SLOTS.length * IMAGE_KINDS.length;

function dotColor(count: number): string {
  if (count >= IMAGE_KINDS.length) return "var(--gold)";
  if (count > 0) return "rgba(217,178,106,.35)";
  return "rgba(255,255,255,.08)";
}

export default function OverviewPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useSession();
  const today = todayIso();

  const [month, setMonth] = useState(() => monthOf(today));
  const [days, setDays] = useState<CalendarDay[]>([]);
  const [streak, setStreak] = useState<Streak | null>(null);
  const [todayDay, setTodayDay] = useState<DayRecord | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [calendar, day] = await Promise.all([api.calendar(month), api.day(today)]);
      setDays(calendar.days);
      setStreak(calendar.streak);
      setTodayDay(day);
    } catch (error) {
      toast(error instanceof Error ? error.message : "โหลดข้อมูลไม่สำเร็จ", "err");
    } finally {
      setLoading(false);
    }
  }, [month, today, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const byDate = useMemo(() => new Map(days.map((d) => [d.date, d])), [days]);
  const cells = useMemo(() => monthGrid(month), [month]);

  /** The first slot of today that still has a gap — what the CTA points at. */
  const pendingSlot = useMemo(() => {
    if (!todayDay) return null;
    return todayDay.slots.find((s) => Object.keys(s.images).length < IMAGE_KINDS.length) ?? null;
  }, [todayDay]);

  const insight = useMemo(() => {
    if (!todayDay) return null;
    const withMetrics = todayDay.slots.filter((s) => s.metrics.pcRatio !== null && s.metrics.pcRatio !== undefined);
    if (withMetrics.length < 2) return null;
    const first = withMetrics[0].metrics.pcRatio!;
    const last = withMetrics[withMetrics.length - 1].metrics.pcRatio!;
    const dir = last < first ? "ลดลง" : last > first ? "เพิ่มขึ้น" : "ทรงตัว";
    const missing = todayDay.slots.filter((s) => Object.keys(s.images).length === 0);
    return `P/C ratio ${dir}จาก ${first.toFixed(2)} เป็น ${last.toFixed(2)} ระหว่างวัน${
      missing.length ? ` — น่าเก็บภาพช่วง “${missing.map((s) => SLOTS.find((d) => d.id === s.slot)!.th).join(" / ")}” ให้ครบเพื่อยืนยันรูปแบบ` : ""
    }`;
  }, [todayDay]);

  const monthCompletion = useMemo(() => {
    const captured = days.reduce((total, d) => total + d.imageCount, 0);
    const target = days.length * FULL_DAY;
    return target === 0 ? 0 : Math.min(100, Math.round((captured / target) * 100));
  }, [days]);

  return (
    <div className="overview">
      <section className="overview-main">
        <div className="page-head">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="eyebrow">CALENDAR</span>
            <h2>{monthTitle(month)}</h2>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button className="btn" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="เดือนก่อนหน้า">
              ‹
            </button>
            <button className="btn" onClick={() => setMonth(monthOf(today))}>
              วันนี้
            </button>
            <button className="btn" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="เดือนถัดไป">
              ›
            </button>
          </div>
        </div>

        <div className="cal-dow">
          {DOW_LABELS.map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>

        <div className="cal-grid" aria-busy={loading}>
          {cells.map((date, index) => {
            if (!date) return <div key={`pad-${index}`} className="cal-cell pad" />;
            const record = byDate.get(date);
            const counts = record?.slotCounts ?? SLOTS.map(() => 0);
            const isToday = date === today;
            const future = date > today;
            return (
              <button
                key={date}
                className={`cal-cell${isToday ? " today" : ""}${future ? " future" : ""}`}
                onClick={() => navigate(`/day/${date}`)}
                title={`${fullThaiDate(date)} · ${record?.imageCount ?? 0}/${FULL_DAY} ภาพ`}
              >
                <span className="cal-top">
                  <b>{Number(date.slice(8))}</b>
                  <em>{record?.imageCount ? `${record.imageCount}` : ""}</em>
                </span>
                <span className="cal-dots">
                  {counts.map((count, slot) => (
                    <i key={slot} style={{ background: future ? "rgba(255,255,255,.06)" : dotColor(count) }} />
                  ))}
                </span>
              </button>
            );
          })}
        </div>

        <div className="cal-legend">
          <span>
            <i style={{ background: "var(--gold)" }} />
            ครบ 3 ภาพ
          </span>
          <span>
            <i style={{ background: "rgba(217,178,106,.35)" }} />
            ไม่ครบ
          </span>
          <span>
            <i style={{ background: "rgba(255,255,255,.08)" }} />
            ยังไม่บันทึก
          </span>
          <span className="mono" style={{ marginLeft: "auto", color: "var(--t-35)", fontSize: 10.5 }}>
            เดือนนี้เก็บได้ {monthCompletion}%
          </span>
        </div>
      </section>

      <aside className="overview-side">
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span className="eyebrow">TODAY</span>
          <span style={{ font: "400 17px/1.3 var(--thai)", color: "var(--ink)" }}>
            {fullThaiDate(today).replace(` ${today.slice(0, 4)}`, "")}
          </span>
        </div>

        <div className="today-slots">
          {(todayDay?.slots ?? []).map((entry) => {
            const def = SLOTS.find((s) => s.id === entry.slot)!;
            const have = Object.keys(entry.images).length;
            const done = have >= IMAGE_KINDS.length;
            const active = entry.slot === pendingSlot?.slot;
            return (
              <button
                key={entry.slot}
                className={`today-slot${active ? " active" : ""}`}
                onClick={() => navigate(`/day/${today}?slot=${entry.slot}`)}
              >
                <span className="mono time">{def.from.slice(0, 2)}–{def.to.slice(0, 2)}</span>
                <span className="name">{def.th}</span>
                <span
                  className="mono stat"
                  style={{
                    color: done ? "rgba(127,191,155,.9)" : active ? "var(--gold)" : "var(--t-30)",
                  }}
                >
                  {done ? `${have}/3` : have > 0 ? `${have}/3` : active ? "ถึงเวลา" : "—"}
                </span>
              </button>
            );
          })}
        </div>

        {insight ? (
          <div className="ai-note">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="diamond" style={{ width: 13, height: 13 }} />
              <span style={{ font: "500 11.5px/1 var(--thai)", color: "var(--gold)" }}>AI สังเกตเห็น</span>
            </div>
            <p>{insight}</p>
            <button className="linkish" onClick={() => navigate("/assistant")}>
              เปิดในแชท →
            </button>
          </div>
        ) : null}

        <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 2 }}>
          <span className="eyebrow">STREAK</span>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span className="mono" style={{ fontSize: 30, color: "var(--ink)" }}>
              {streak?.current ?? 0}
            </span>
            <span style={{ font: "300 12.5px/1.4 var(--thai)", color: "var(--t-45)" }}>
              วันติดต่อกันที่บันทึกครบ
            </span>
          </div>
          <div className="bar">
            <i
              style={{
                width: `${Math.min(100, ((streak?.current ?? 0) / 14) * 100)}%`,
              }}
            />
          </div>
          <span className="mono" style={{ fontSize: 10.5, color: "var(--t-35)" }}>
            {streak?.completeDays ?? 0} วันครบ / {streak?.totalDays ?? 0} วันที่บันทึก
          </span>
        </div>

        <div style={{ flex: 1 }} />

        <button
          className="btn-gold"
          style={{ width: "100%", padding: 14, fontSize: 13.5 }}
          onClick={() =>
            navigate(`/day/${today}${pendingSlot ? `?slot=${pendingSlot.slot}` : ""}`)
          }
        >
          {pendingSlot
            ? `+ บันทึกช่วง “${SLOTS.find((s) => s.id === pendingSlot.slot)!.th}”`
            : "เปิดบันทึกของวันนี้"}
        </button>
        <span className="mono" style={{ fontSize: 10, color: "var(--t-30)", textAlign: "center" }}>
          {user?.settings.contract}
        </span>
      </aside>
    </div>
  );
}
