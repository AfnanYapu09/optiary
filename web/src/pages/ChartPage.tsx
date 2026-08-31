import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api.ts";
import { useToast } from "../lib/toast.tsx";
import DualAxisChart from "../components/DualAxisChart.tsx";
import { num, signed } from "../lib/format.ts";
import { SLOTS, type Stats } from "../lib/types.ts";
import "../styles/chart.css";

const RANGES = [
  { days: 7, label: "7 วัน" },
  { days: 30, label: "30 วัน" },
  { days: 365, label: "ทั้งหมด" },
];

export default function ChartPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api
      .stats(days)
      .then(setStats)
      .catch((error) => toast(error instanceof Error ? error.message : "โหลดสถิติไม่สำเร็จ", "err"))
      .finally(() => setLoading(false));
  }, [days, toast]);

  const kpis = useMemo(() => {
    if (!stats) return [];
    return [
      {
        k: "P/C RATIO",
        v: num(stats.latestPcRatio, 2),
        sub:
          stats.latestPcRatio == null
            ? "ยังไม่มีค่า"
            : stats.latestPcRatio < 1
              ? "Call มากกว่า Put"
              : "Put มากกว่า Call",
        color: (stats.latestPcRatio ?? 1) < 1 ? "var(--call)" : "var(--put)",
        tone: undefined as string | undefined,
      },
      {
        k: "AVG OI CHG",
        v: signed(stats.avgOiChg, 0),
        sub: bestSlotLabel(stats),
        color: "var(--t-45)",
        tone: (stats.avgOiChg ?? 0) >= 0 ? "var(--up)" : "var(--down)",
      },
      {
        k: "IMAGES CAPTURED",
        v: num(stats.streak.totalImages),
        sub: `${stats.streak.totalDays} วันที่บันทึก`,
        color: "var(--t-45)",
        tone: undefined,
      },
      {
        k: "COMPLETE DAYS",
        v: `${stats.streak.completeDays} / ${stats.streak.totalDays}`,
        sub: "ครบทั้ง 5 ช่วง",
        color: "var(--t-45)",
        tone: undefined,
      },
    ];
  }, [stats]);

  const maxAbsChg = useMemo(() => {
    if (!stats) return 1;
    const values = stats.bySlot.map((s) => Math.abs(s.avgOiChg ?? 0));
    return Math.max(1, ...values);
  }, [stats]);

  // With no negative averages there is nothing to show below the axis, so the
  // bars use the full height rather than leaving the lower half empty.
  const diverging = useMemo(
    () => Boolean(stats?.bySlot.some((s) => (s.avgOiChg ?? 0) < 0)),
    [stats],
  );

  const observation = useMemo(() => {
    if (!stats) return null;
    const ranked = [...stats.bySlot]
      .filter((s) => s.samples > 0 && s.avgOiChg !== null)
      .sort((a, b) => (b.avgOiChg ?? 0) - (a.avgOiChg ?? 0));
    if (ranked.length === 0) return null;
    const top = ranked[0];
    const corr = stats.correlation;
    return `ช่วง “${top.label}” เป็นช่วงที่ OI เพิ่มมากที่สุด (เฉลี่ย ${signed(top.avgOiChg)} สัญญา จาก ${
      top.samples
    } ครั้ง · ขึ้น ${top.up} ลง ${top.down})${
      corr === null
        ? " · ข้อมูลยังไม่พอคำนวณสหสัมพันธ์กับราคา"
        : ` · สหสัมพันธ์ระหว่างราคากับ OI อยู่ที่ ${corr >= 0 ? "+" : "−"}${Math.abs(corr).toFixed(2)}`
    }`;
  }, [stats]);

  return (
    <div className="chart-page">
      <header className="toolbar">
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <h1>กราฟสรุป</h1>
          <div className="seg">
            {RANGES.map((range) => (
              <button key={range.days} aria-pressed={days === range.days} onClick={() => setDays(range.days)}>
                {range.label}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <span className="legend">
            <i style={{ background: "var(--gold)" }} />
            ราคา Intraday
          </span>
          <span className="legend">
            <i style={{ background: "var(--call)", height: 0, borderTop: "2px dashed var(--call)" }} />
            Open Interest
          </span>
          <a className="btn" href="/api/export.csv">
            ส่งออกข้อมูล
          </a>
        </div>
      </header>

      <div className="chart-body">
        <div className="kpi-row">
          {kpis.map((kpi) => (
            <div key={kpi.k} className="kpi">
              <span className="eyebrow caps">{kpi.k}</span>
              <b className="mono" style={kpi.tone ? { color: kpi.tone } : undefined}>
                {kpi.v}
              </b>
              <small style={{ color: kpi.color }}>{kpi.sub}</small>
            </div>
          ))}
        </div>

        <section className="card chart-main">
          <div className="chart-main-head">
            <span style={{ font: "400 14px/1.4 var(--thai)", color: "var(--ink)" }}>
              ราคา Intraday เทียบกับ Open Interest — รายช่วงเวลา
            </span>
            <span className="mono" style={{ fontSize: 10.5, color: "var(--t-35)" }}>
              {stats?.correlation === null || stats?.correlation === undefined
                ? "CORRELATION —"
                : `CORRELATION ${stats.correlation >= 0 ? "+" : "−"}${Math.abs(stats.correlation).toFixed(2)}`}
            </span>
          </div>
          {loading ? (
            <div className="empty">
              <span className="spin" /> กำลังคำนวณ…
            </div>
          ) : (
            <DualAxisChart series={stats?.series ?? []} />
          )}
        </section>

        <div className="chart-lower">
          <section className="card chart-bars">
            <span style={{ font: "400 13px/1.4 var(--thai)", color: "var(--ink)" }}>
              OI Chg ตามช่วงเวลา (ค่าเฉลี่ย {days} วัน)
            </span>
            <div className="bars">
              {SLOTS.map((slot) => {
                const row = stats?.bySlot.find((s) => s.slot === slot.id);
                const value = row?.avgOiChg ?? 0;
                const height = `${(Math.abs(value) / maxAbsChg) * 100}%`;
                return (
                  <div key={slot.id} className="bar-col" title={`${signed(row?.avgOiChg ?? null)} สัญญา`}>
                    <div className={`bar-track${diverging ? " diverging" : ""}`}>
                      <div className="bar-half up">{value > 0 ? <i style={{ height }} /> : null}</div>
                      {diverging ? (
                        <div className="bar-half down">{value < 0 ? <i style={{ height }} /> : null}</div>
                      ) : null}
                    </div>
                    <span>{slot.th}</span>
                    <span className="bar-value">{signed(row?.avgOiChg ?? null)}</span>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="chart-insight">
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <span className="diamond" style={{ width: 13, height: 13 }} />
              <span style={{ font: "500 12.5px/1 var(--thai)", color: "var(--gold)" }}>
                ข้อสังเกตจากชุดข้อมูล
              </span>
            </div>
            <p>{observation ?? "ยังไม่มีตัวเลขพอจะสรุป — ให้ AI อ่านภาพในหน้าจดบันทึกก่อน"}</p>
            <button className="linkish" onClick={() => navigate("/assistant")}>
              ถาม AI ต่อเรื่องนี้ →
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}

function bestSlotLabel(stats: Stats): string {
  const ranked = [...stats.bySlot]
    .filter((s) => s.avgOiChg !== null)
    .sort((a, b) => (b.avgOiChg ?? 0) - (a.avgOiChg ?? 0));
  return ranked.length ? `ช่วง${ranked[0].label}สูงสุด` : "ยังไม่มีข้อมูล";
}
