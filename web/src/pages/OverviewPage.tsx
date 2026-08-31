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
  num,
  shiftMonth,
  shortThaiDate,
  signed,
  todayIso,
} from "../lib/format.ts";
import {
  IMAGE_KINDS,
  SLOTS,
  type CalendarDay,
  type DayRecord,
  type EntryRecord,
  type Metrics,
  type Stats,
  type Streak,
} from "../lib/types.ts";
import "../styles/overview.css";

const FULL_DAY = SLOTS.length * IMAGE_KINDS.length;

function dotColor(count: number): string {
  if (count >= IMAGE_KINDS.length) return "var(--gold)";
  if (count > 0) return "var(--gold-line)";
  return "var(--line-2)";
}

/** A slot counts as "read" once the model has put numbers on it. */
function hasMetrics(entry: EntryRecord): boolean {
  const m = entry.metrics;
  return m.putOi != null || m.callOi != null || m.pcRatio != null;
}

/** Thin trend line for the tape tiles — no axes, no labels, just the shape. */
function Spark({ values, stroke }: { values: number[]; stroke: string }) {
  if (values.length < 2) return <svg className="spark" viewBox="0 0 100 24" aria-hidden="true" />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = 100 / (values.length - 1);
  const points = values
    .map((v, i) => `${(i * step).toFixed(2)},${(22 - ((v - min) / span) * 20).toFixed(2)}`)
    .join(" ");
  return (
    <svg className="spark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} fill="none" stroke={stroke} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** One reading off the tape: label, figure, and how it moved since the last slot. */
function Tape({
  label,
  value,
  tone,
  side,
  delta,
  deltaDigits = 0,
  invertDelta = false,
  spark,
  sparkStroke,
  note,
}: {
  label: string;
  value: string;
  tone?: string;
  side?: "put" | "call";
  delta?: number | null;
  deltaDigits?: number;
  invertDelta?: boolean;
  spark?: number[];
  sparkStroke?: string;
  note?: string;
}) {
  const moved = delta != null && Number.isFinite(delta) && delta !== 0;
  const good = moved ? (invertDelta ? delta! < 0 : delta! > 0) : false;
  return (
    <div className="tape" data-tone={side}>
      <span className="eyebrow">{label}</span>
      <b className="mono" style={tone ? { color: tone } : undefined}>
        {value}
      </b>
      <div className="tape-foot">
        {moved ? (
          <span className={`tape-delta ${good ? "is-up" : "is-down"}`}>
            {delta! > 0 ? "▲" : "▼"} {signed(delta, deltaDigits)}
          </span>
        ) : (
          <span className="tape-delta muted">{note ?? "จากช่วงก่อน —"}</span>
        )}
        {spark && spark.length > 1 ? <Spark values={spark} stroke={sparkStroke ?? "var(--t-30)"} /> : null}
      </div>
    </div>
  );
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
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  const [readDay, setReadDay] = useState<DayRecord | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [calendar, day, series] = await Promise.all([
        api.calendar(month),
        api.day(today),
        api.stats(365).catch(() => null),
      ]);
      setDays(calendar.days);
      setStreak(calendar.streak);
      setTodayDay(day);
      setStats(series);

      // The tape is only useful if it has numbers on it. Most mornings today is
      // still blank, so fall back to the last session that was actually read.
      if (day.slots.some(hasMetrics)) {
        setReadDay(day);
      } else {
        const lastDate = series?.series.at(-1)?.date;
        setReadDay(lastDate && lastDate !== today ? await api.day(lastDate) : day);
      }
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

  /** The last two slots today that carry numbers — the tape shows the newer one
   * and measures its move against the older. */
  const [latest, previous] = useMemo(() => {
    const read = (readDay?.slots ?? []).filter(hasMetrics);
    return [read.at(-1) ?? null, read.at(-2) ?? null] as const;
  }, [readDay]);

  const stale = Boolean(readDay && readDay.date !== today && latest);

  const m: Metrics = latest?.metrics ?? {};
  const prev: Metrics = previous?.metrics ?? {};
  const delta = (a?: number | null, b?: number | null) =>
    a != null && b != null ? a - b : null;

  /** Put / Call split of the latest open interest, as a percentage of the pair. */
  const oiSplit = useMemo(() => {
    const put = m.putOi ?? 0;
    const call = m.callOi ?? 0;
    const total = put + call;
    if (!total) return null;
    return { put, call, putPct: (put / total) * 100, callPct: (call / total) * 100 };
  }, [m.callOi, m.putOi]);

  const pcHistory = useMemo(
    () =>
      (stats?.series ?? [])
        .map((p) => p.pcRatio)
        .filter((v): v is number => v != null && Number.isFinite(v))
        .slice(-40),
    [stats],
  );

  const oiHistory = useMemo(
    () =>
      (stats?.series ?? [])
        .map((p) => p.oi)
        .filter((v): v is number => v != null && Number.isFinite(v))
        .slice(-40),
    [stats],
  );

  /** The first slot of today that still has a gap — what the CTA points at. */
  const pendingSlot = useMemo(() => {
    if (!todayDay) return null;
    return todayDay.slots.find((s) => Object.keys(s.images).length < IMAGE_KINDS.length) ?? null;
  }, [todayDay]);

  const insight = useMemo(() => {
    if (!todayDay) return null;
    const withMetrics = todayDay.slots.filter((s) => s.metrics.pcRatio != null);
    if (withMetrics.length < 2) return null;
    const first = withMetrics[0].metrics.pcRatio!;
    const last = withMetrics[withMetrics.length - 1].metrics.pcRatio!;
    const dir = last < first ? "ลดลง" : last > first ? "เพิ่มขึ้น" : "ทรงตัว";
    const missing = todayDay.slots.filter((s) => Object.keys(s.images).length === 0);
    return `P/C ratio ${dir}จาก ${first.toFixed(2)} เป็น ${last.toFixed(2)} ระหว่างวัน${
      missing.length
        ? ` — น่าเก็บภาพช่วง “${missing
            .map((s) => SLOTS.find((d) => d.id === s.slot)!.th)
            .join(" / ")}” ให้ครบเพื่อยืนยันรูปแบบ`
        : ""
    }`;
  }, [todayDay]);

  const monthCompletion = useMemo(() => {
    const captured = days.reduce((total, d) => total + d.imageCount, 0);
    const target = days.length * FULL_DAY;
    return target === 0 ? 0 : Math.min(100, Math.round((captured / target) * 100));
  }, [days]);

  const latestLabel = latest ? SLOTS.find((s) => s.id === latest.slot)!.th : null;

  return (
    <div className="overview">
      <header className="toolbar">
        <div className="ov-head">
          <h1>{fullThaiDate(today)}</h1>
          <span className="pill">{user?.settings.contract ?? "GC"}</span>
          <span className={`mono ov-source${stale ? " stale" : ""}`}>
            {!latestLabel
              ? "ยังไม่มีตัวเลขที่ AI อ่านไว้"
              : stale
                ? `ตัวเลขล่าสุด · ${shortThaiDate(readDay!.date)} ช่วง${latestLabel}`
                : `ตัวเลขล่าสุด · ช่วง${latestLabel}`}
          </span>
        </div>
        <button
          className="btn-gold"
          onClick={() => navigate(`/day/${today}${pendingSlot ? `?slot=${pendingSlot.slot}` : ""}`)}
        >
          {pendingSlot
            ? `+ บันทึกช่วง “${SLOTS.find((s) => s.id === pendingSlot.slot)!.th}”`
            : "เปิดบันทึกของวันนี้"}
        </button>
      </header>

      {/* The tape — what the option book looks like right now, before anything else. */}
      <section className="tape-row" aria-label="สรุปตัวเลขล่าสุด">
        <Tape
          label="Put OI"
          value={num(m.putOi)}
          tone="var(--put)"
          side="put"
          delta={delta(m.putOi, prev.putOi)}
          spark={oiHistory}
          sparkStroke="var(--put)"
        />
        <Tape
          label="Call OI"
          value={num(m.callOi)}
          tone="var(--call)"
          side="call"
          delta={delta(m.callOi, prev.callOi)}
          spark={oiHistory}
          sparkStroke="var(--call)"
        />
        <Tape
          label="P/C Ratio"
          value={num(m.pcRatio, 2)}
          delta={delta(m.pcRatio, prev.pcRatio)}
          deltaDigits={2}
          invertDelta
          spark={pcHistory}
          sparkStroke="var(--gold)"
          note={m.pcRatio == null ? "ยังไม่ได้อ่านภาพ" : undefined}
        />
        <Tape
          label="OI เปลี่ยนแปลง"
          value={signed(m.oiChgTotal)}
          tone={(m.oiChgTotal ?? 0) >= 0 ? "var(--up)" : "var(--down)"}
          delta={delta(m.oiChgTotal, prev.oiChgTotal)}
        />
        <Tape
          label="ราคาปัจจุบัน"
          value={num(m.priceClose, 1)}
          delta={delta(m.priceClose, prev.priceClose)}
          deltaDigits={1}
        />
      </section>

      {/* Put vs Call as one bar — the single fastest read of who owns the book. */}
      <section className="split-meter" aria-label="สัดส่วน Put เทียบ Call">
        {oiSplit ? (
          <>
            <div className="split-meter-head">
              <span className="mono is-put">
                PUT {num(oiSplit.put)} · {oiSplit.putPct.toFixed(1)}%
              </span>
              <span className="eyebrow">สัดส่วน Open Interest</span>
              <span className="mono is-call">
                {oiSplit.callPct.toFixed(1)}% · {num(oiSplit.call)} CALL
              </span>
            </div>
            <div className="split-meter-bar">
              <i className="put" style={{ width: `${oiSplit.putPct}%` }} />
              <i className="call" style={{ width: `${oiSplit.callPct}%` }} />
            </div>
          </>
        ) : (
          <div className="split-meter-empty">
            อัปโหลดภาพ OI แล้วให้ AI อ่าน — สัดส่วน Put/Call จะขึ้นตรงนี้
          </div>
        )}
      </section>

      <div className="overview-body">
        <section className="overview-main card">
          <div className="page-head">
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="eyebrow">ปฏิทินการบันทึก</span>
              <h2>{monthTitle(month)}</h2>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
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
              const newsCount = record?.newsCount ?? 0;
              const holidayCount = record?.holidayCount ?? 0;
              return (
                <button
                  key={date}
                  className={`cal-cell${isToday ? " today" : ""}${future ? " future" : ""}${
                    newsCount ? " has-news" : holidayCount ? " has-holiday" : ""
                  }`}
                  onClick={() => navigate(`/day/${date}`)}
                  title={
                    `${fullThaiDate(date)} · ${record?.imageCount ?? 0}/${FULL_DAY} ภาพ` +
                    (newsCount ? ` · ข่าวแดง ${newsCount}` : "") +
                    (holidayCount ? ` · วันหยุด ${holidayCount}` : "")
                  }
                >
                  <span className="cal-top">
                    <b className="mono">{Number(date.slice(8))}</b>
                    {newsCount ? (
                      <span className="cal-badge news" aria-label={`ข่าวแดง ${newsCount} รายการ`}>
                        <i />
                        {newsCount}
                      </span>
                    ) : holidayCount ? (
                      <span className="cal-badge holiday" aria-label={`วันหยุด ${holidayCount}`}>
                        หยุด
                      </span>
                    ) : null}
                  </span>
                  <span className="cal-dots">
                    {counts.map((count, slot) => (
                      <i key={slot} style={{ background: future ? "var(--line)" : dotColor(count) }} />
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
              <i style={{ background: "var(--gold-line)" }} />
              ไม่ครบ
            </span>
            <span>
              <i style={{ background: "var(--line-2)" }} />
              ยังไม่บันทึก
            </span>
            <span className="legend-news">
              <b>3</b>
              วันมีข่าวแดง (ตัวเลข = จำนวนข่าว)
            </span>
            <span className="legend-holiday">
              <b />
              วันหยุด
            </span>
            <span className="mono cal-pct">เดือนนี้ {monthCompletion}%</span>
          </div>
        </section>

        <aside className="overview-side">
          <span className="eyebrow">ช่วงเวลาของวันนี้</span>

          <div className="today-slots">
            {(todayDay?.slots ?? []).map((entry) => {
              const def = SLOTS.find((s) => s.id === entry.slot)!;
              const have = Object.keys(entry.images).length;
              const done = have >= IMAGE_KINDS.length;
              const active = entry.slot === pendingSlot?.slot;
              const pc = entry.metrics.pcRatio;
              return (
                <button
                  key={entry.slot}
                  className={`today-slot${active ? " active" : ""}${done ? " done" : ""}`}
                  onClick={() => navigate(`/day/${today}?slot=${entry.slot}`)}
                >
                  <span className="mono time">
                    {def.from.slice(0, 2)}–{def.to.slice(0, 2)}
                  </span>
                  <span className="name">{def.th}</span>
                  {pc != null ? <span className="mono slot-pc">P/C {pc.toFixed(2)}</span> : null}
                  <span className={`mono stat-chip${done ? " done" : active ? " now" : ""}`}>
                    {have > 0 ? `${have}/3` : active ? "ถึงเวลา" : "—"}
                  </span>
                </button>
              );
            })}
          </div>

          {insight ? (
            <div className="ai-note">
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <span className="diamond" style={{ width: 10, height: 10 }} />
                <span style={{ font: "500 11px/1 var(--thai)", color: "var(--gold)" }}>AI สังเกตเห็น</span>
              </div>
              <p>{insight}</p>
              <button className="linkish" onClick={() => navigate("/assistant")}>
                เปิดในแชท →
              </button>
            </div>
          ) : null}

          <div className="streak-box">
            <span className="eyebrow">บันทึกต่อเนื่อง</span>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span className="mono streak-num">{streak?.current ?? 0}</span>
              <span style={{ font: "300 11.5px/1.4 var(--thai)", color: "var(--t-45)" }}>
                วันติดต่อกันที่บันทึกครบ
              </span>
            </div>
            <div className="bar">
              <i style={{ width: `${Math.min(100, ((streak?.current ?? 0) / 14) * 100)}%` }} />
            </div>
            <span className="mono" style={{ fontSize: 10, color: "var(--t-35)" }}>
              {streak?.completeDays ?? 0} วันครบ / {streak?.totalDays ?? 0} วันที่บันทึก
            </span>
          </div>
        </aside>
      </div>
    </div>
  );
}
