import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../lib/api.ts";
import { useToast } from "../lib/toast.tsx";
import { num, shortThaiDate, signed, stampDate } from "../lib/format.ts";
import {
  IMAGE_KINDS,
  KIND_LABELS,
  SLOTS,
  slotDef,
  type CompareResult,
  type DayRecord,
  type ImageKind,
  type LibraryItem,
  type SlotId,
} from "../lib/types.ts";
import "../styles/compare.css";

type Mode = "pair" | "grid" | "timeline";

const MODES: Array<{ id: Mode; label: string }> = [
  { id: "pair", label: "คู่เทียบ" },
  { id: "grid", label: "ตาราง" },
  { id: "timeline", label: "ไทม์ไลน์" },
];

type Pick = { date: string; slot: SlotId };

function pickKey(pick: Pick): string {
  return `${pick.date}_${pick.slot}`;
}

/** Distinct (date, slot) pairs present in the library for the chosen image kind. */
function capturesOf(items: LibraryItem[]): Pick[] {
  const seen = new Set<string>();
  const out: Pick[] = [];
  for (const item of items) {
    const key = `${item.date}_${item.slot}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date: item.date, slot: item.slot });
  }
  return out;
}

function SplitView({
  kind,
  left,
  right,
  leftUrl,
  rightUrl,
}: {
  kind: ImageKind;
  left: Pick;
  right: Pick;
  leftUrl?: string;
  rightUrl?: string;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useState(50);
  const dragging = useRef(false);

  const move = useCallback((clientX: number) => {
    const box = frame.current?.getBoundingClientRect();
    if (!box) return;
    setSplit(Math.min(92, Math.max(8, ((clientX - box.left) / box.width) * 100)));
  }, []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (dragging.current) move(event.clientX);
    };
    const onUp = () => {
      dragging.current = false;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [move]);

  // Both images occupy the whole frame; the divider clips the right one, so the
  // same region of each screenshot lines up as you sweep across.
  return (
    <div className="split" ref={frame}>
      <div className="split-layer">
        {leftUrl ? (
          <img src={leftUrl} alt={`${KIND_LABELS[kind]} ${left.date}`} />
        ) : (
          <span className="split-missing">ไม่มีภาพ {KIND_LABELS[kind]} ของช่วงนี้</span>
        )}
      </div>

      <div className="split-layer" style={{ clipPath: `inset(0 0 0 ${split}%)` }}>
        {rightUrl ? (
          <img src={rightUrl} alt={`${KIND_LABELS[kind]} ${right.date}`} />
        ) : (
          <span className="split-missing">ไม่มีภาพ {KIND_LABELS[kind]} ของช่วงนี้</span>
        )}
      </div>

      <span className="split-tag left mono">
        {KIND_LABELS[kind].toUpperCase()} · {stampDate(left.date)} · {slotDef(left.slot).en}
      </span>
      <span className="split-tag right mono">
        {KIND_LABELS[kind].toUpperCase()} · {stampDate(right.date)} · {slotDef(right.slot).en}
      </span>

      <button
        className="split-handle"
        style={{ left: `${split}%` }}
        role="slider"
        aria-valuenow={Math.round(split)}
        aria-valuemin={8}
        aria-valuemax={92}
        onPointerDown={(event) => {
          dragging.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") setSplit((v) => Math.max(8, v - 4));
          if (event.key === "ArrowRight") setSplit((v) => Math.min(92, v + 4));
        }}
        aria-label="ลากเพื่อไล่ดูภาพ"
      >
        <span>↔</span>
      </button>
    </div>
  );
}

export default function ComparePage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();

  const mode = (params.get("mode") as Mode) ?? "pair";
  const kind = (params.get("kind") as ImageKind) ?? "intraday";

  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [left, setLeft] = useState<Pick | null>(null);
  const [right, setRight] = useState<Pick | null>(null);
  const [diff, setDiff] = useState<CompareResult | null>(null);
  const [timelineDate, setTimelineDate] = useState<string | null>(null);
  const [timelineDay, setTimelineDay] = useState<DayRecord | null>(null);
  const [gridDays, setGridDays] = useState<DayRecord[]>([]);

  useEffect(() => {
    setLoading(true);
    api
      .library()
      .then((res) => setLibrary(res.items))
      .catch((error) => toast(error instanceof Error ? error.message : "โหลดคลังภาพไม่สำเร็จ", "err"))
      .finally(() => setLoading(false));
  }, [toast]);

  const ofKind = useMemo(() => library.filter((item) => item.kind === kind), [kind, library]);
  const captures = useMemo(() => capturesOf(ofKind), [ofKind]);
  const allDates = useMemo(
    () => [...new Set(library.map((item) => item.date))].sort((a, b) => b.localeCompare(a)),
    [library],
  );

  // Default the two sides to the newest two captures of the selected kind. With
  // only one capture the left side stays empty rather than duplicating the
  // right — comparing a shot against itself produced a full screen of "→ ต่าง 0".
  useEffect(() => {
    if (captures.length === 0) {
      setLeft(null);
      setRight(null);
      return;
    }
    const known = (pick: Pick | null) =>
      pick !== null && captures.some((c) => pickKey(c) === pickKey(pick));
    setRight((current) => (known(current) ? current : captures[0]));
    setLeft((current) => (known(current) ? current : captures[1] ?? null));
  }, [captures]);

  useEffect(() => {
    if (!left || !right) {
      setDiff(null);
      return;
    }
    api
      .compare(pickKey(left), pickKey(right))
      .then(setDiff)
      .catch(() => setDiff(null));
  }, [left, right]);

  useEffect(() => {
    if (allDates.length === 0) return;
    setTimelineDate((current) => current ?? allDates[0]);
  }, [allDates]);

  useEffect(() => {
    if (!timelineDate) return;
    api
      .day(timelineDate)
      .then(setTimelineDay)
      .catch(() => setTimelineDay(null));
  }, [timelineDate]);

  useEffect(() => {
    if (mode !== "grid" || allDates.length === 0) return;
    Promise.all(allDates.slice(0, 5).map((date) => api.day(date)))
      .then(setGridDays)
      .catch(() => setGridDays([]));
  }, [allDates, mode]);

  const urlFor = useCallback(
    (pick: Pick | null): string | undefined =>
      pick
        ? ofKind.find((item) => item.date === pick.date && item.slot === pick.slot)?.url
        : undefined,
    [ofKind],
  );

  const setMode = (next: Mode) => setParams({ mode: next, kind }, { replace: true });
  const setKind = (next: ImageKind) => setParams({ mode, kind: next }, { replace: true });

  const samePick = Boolean(left && right && pickKey(left) === pickKey(right));

  /**
   * A comparison is about what moved, so this is a table (metric, both sides,
   * delta) rather than a wall of cards — and rows that did not move are dimmed
   * so the eye lands on the ones that did.
   */
  const diffRows = (() => {
    if (!diff) return [];
    const L = diff.left.metrics;
    const R = diff.right.metrics;
    const d = diff.deltas;
    const rows = [
      { k: "P/C Ratio", l: num(L.pcRatio, 2), r: num(R.pcRatio, 2), delta: d.pcRatio, digits: 2, core: true },
      { k: "Put OI", l: num(L.putOi), r: num(R.putOi), delta: d.putOi, digits: 0, core: true },
      { k: "Call OI", l: num(L.callOi), r: num(R.callOi), delta: d.callOi, digits: 0, core: true },
      { k: "ราคาปัจจุบัน", l: num(L.priceClose, 1), r: num(R.priceClose, 1), delta: d.priceClose, digits: 1, core: true },
      { k: "OI เปลี่ยนแปลงรวม", l: signed(L.oiChgTotal), r: signed(R.oiChgTotal), delta: d.oiChgTotal, digits: 0, core: true },
      { k: "Put OI Chg", l: signed(L.putOiChg), r: signed(R.putOiChg), delta: d.putOiChg, digits: 0, core: false },
      { k: "Call OI Chg", l: signed(L.callOiChg), r: signed(R.callOiChg), delta: d.callOiChg, digits: 0, core: false },
      { k: "Intraday Put", l: num(L.intradayPut), r: num(R.intradayPut), delta: d.intradayPut, digits: 0, core: false },
      { k: "Intraday Call", l: num(L.intradayCall), r: num(R.intradayCall), delta: d.intradayCall, digits: 0, core: false },
      { k: "Vol", l: num(L.vol, 2), r: num(R.vol, 2), delta: d.vol, digits: 2, core: false },
      { k: "Vol Chg", l: signed(L.volChg, 2), r: signed(R.volChg, 2), delta: d.volChg, digits: 2, core: false },
      { k: "Future Chg", l: signed(L.futureChg, 1), r: signed(R.futureChg, 1), delta: d.futureChg, digits: 1, core: false },
    ];
    return rows.filter((row) => row.core || row.l !== "—" || row.r !== "—");
  })();

  const movedCount = diffRows.filter((row) => (row.delta ?? 0) !== 0).length;

  return (
    <div className="compare">
      <header className="toolbar">
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <h1>เทียบภาพ</h1>
          <div className="seg">
            {MODES.map((item) => (
              <button key={item.id} aria-pressed={mode === item.id} onClick={() => setMode(item.id)}>
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <span className="mono" style={{ fontSize: 11, color: "var(--t-40)" }}>
          {KIND_LABELS[kind].toUpperCase()} · {library.length} ภาพในคลัง
        </span>
      </header>

      <div className="compare-body">
        <aside className="compare-side">
          <div className="compare-group">
            <span className="eyebrow">ชนิดภาพ</span>
            <div className="compare-kinds">
              {IMAGE_KINDS.map((item) => (
                <button
                  key={item}
                  className={item === kind ? "active" : ""}
                  onClick={() => setKind(item)}
                >
                  {KIND_LABELS[item]}
                </button>
              ))}
            </div>
          </div>

          <div className="compare-group" style={{ flex: 1, minHeight: 0 }}>
            <span className="eyebrow">คลังภาพ</span>
            <div className="library">
              {loading ? <div className="empty">กำลังโหลด…</div> : null}
              {!loading && ofKind.length === 0 ? (
                <div className="empty">ยังไม่มีภาพชนิดนี้ในคลัง</div>
              ) : null}
              {ofKind.map((item) => {
                const pick = { date: item.date, slot: item.slot };
                const selected =
                  (left && pickKey(left) === pickKey(pick)) || (right && pickKey(right) === pickKey(pick));
                return (
                  <div key={item.id} className={`library-item${selected ? " selected" : ""}`}>
                    <div className="library-thumb">
                      <img src={item.url} alt="" loading="lazy" decoding="async" />
                    </div>
                    <div className="library-meta">
                      <span>{shortThaiDate(item.date)}</span>
                      <em className="mono">
                        {slotDef(item.slot).en} · {slotDef(item.slot).from}
                      </em>
                    </div>
                    <div className="library-actions">
                      <button className="ghost" onClick={() => setLeft(pick)}>
                        ซ้าย
                      </button>
                      <button className="ghost" onClick={() => setRight(pick)}>
                        ขวา
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </aside>

        <section className="compare-main">
          {mode === "pair" ? (
            <>
              <div className="pair-head">
                <span className={`pair-chip${left ? "" : " ghosted"}`}>
                  {left ? `${shortThaiDate(left.date)} · ${slotDef(left.slot).th}` : "ยังไม่ได้เลือกภาพซ้าย"}
                </span>
                <span className="mono" style={{ fontSize: 10.5, color: "var(--t-30)" }}>
                  VS
                </span>
                <span className={`pair-chip${right ? "" : " ghosted"}`}>
                  {right ? `${shortThaiDate(right.date)} · ${slotDef(right.slot).th}` : "ยังไม่ได้เลือกภาพขวา"}
                </span>
                <div style={{ flex: 1 }} />
                {left && right && !samePick ? (
                  <span style={{ font: "300 11px/1.3 var(--thai)", color: "var(--t-35)" }}>
                    ลากเส้นกลางเพื่อไล่ดูภาพ
                  </span>
                ) : null}
              </div>

              {left && right && !samePick ? (
                <SplitView
                  kind={kind}
                  left={left}
                  right={right}
                  leftUrl={urlFor(left)}
                  rightUrl={urlFor(right)}
                />
              ) : right ? (
                // One capture only. Show it plainly instead of splitting it
                // against itself, which produced a screen of zero deltas.
                <div className="solo card">
                  <img src={urlFor(right)} alt={KIND_LABELS[kind]} />
                  <p>
                    มีภาพ {KIND_LABELS[kind]} อยู่ช่วงเดียว — เลือกอีกช่วงจากคลังด้านซ้าย (ปุ่ม “ซ้าย”)
                    หรือบันทึกเพิ่มอีกวัน แล้วหน้านี้จะเทียบให้
                  </p>
                </div>
              ) : (
                <div className="card empty" style={{ flex: 1 }}>
                  เลือกภาพสองภาพจากคลังด้านซ้ายเพื่อเริ่มเปรียบเทียบ
                </div>
              )}

              {diff && !samePick && diffRows.length ? (
                <div className="diff card">
                  <div className="diff-head">
                    <span className="eyebrow">ตัวเลขที่ต่างกัน</span>
                    <span className="mono diff-moved">
                      {movedCount ? `${movedCount} ค่าเปลี่ยน` : "ไม่มีค่าไหนเปลี่ยน"}
                    </span>
                  </div>
                  <table className="diff-table">
                    <thead>
                      <tr>
                        <th />
                        <th>{shortThaiDate(diff.left.date)} · {slotDef(diff.left.slot).th}</th>
                        <th>{shortThaiDate(diff.right.date)} · {slotDef(diff.right.slot).th}</th>
                        <th>ต่าง</th>
                      </tr>
                    </thead>
                    <tbody>
                      {diffRows.map((row) => {
                        const moved = (row.delta ?? 0) !== 0;
                        return (
                          <tr key={row.k} className={moved ? "" : "flat"}>
                            <th>{row.k}</th>
                            {/* The row label already names the side, so the
                             * delta column is the only thing tinted here. */}
                            <td className="mono">{row.l}</td>
                            <td className="mono">{row.r}</td>
                            <td
                              className={`mono diff-delta ${
                                !moved ? "" : (row.delta ?? 0) > 0 ? "is-up" : "is-down"
                              }`}
                            >
                              {row.delta == null ? "—" : signed(row.delta, row.digits)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {diff && !samePick && (diff.left.note || diff.right.note) ? (
                <div className="ai-note">
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="diamond" style={{ width: 11, height: 11 }} />
                    <span style={{ font: "500 12px/1 var(--thai)", color: "var(--gold)" }}>
                      โน้ตของทั้งสองช่วง
                    </span>
                  </div>
                  {diff.left.note ? (
                    <p>
                      <b className="mono" style={{ color: "var(--t-45)", fontSize: 11 }}>
                        {shortThaiDate(diff.left.date)} ·{" "}
                      </b>
                      {diff.left.note}
                    </p>
                  ) : null}
                  {diff.right.note ? (
                    <p>
                      <b className="mono" style={{ color: "var(--t-45)", fontSize: 11 }}>
                        {shortThaiDate(diff.right.date)} ·{" "}
                      </b>
                      {diff.right.note}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}

          {mode === "grid" ? (
            <div className="grid-view">
              <div className="grid-head">
                <span />
                {SLOTS.map((slot) => (
                  <span key={slot.id}>{slot.th}</span>
                ))}
              </div>
              {gridDays.length === 0 ? (
                <div className="card empty">ยังไม่มีข้อมูลพอสำหรับมุมมองตาราง</div>
              ) : null}
              {gridDays.map((day) => (
                <div key={day.date} className="grid-row">
                  <div className="grid-row-label">
                    <span>{shortThaiDate(day.date)}</span>
                    <em className="mono">{day.imageCount}/{day.imageTarget}</em>
                  </div>
                  {SLOTS.map((slot) => {
                    const entry = day.slots.find((s) => s.slot === slot.id)!;
                    const image = entry.images[kind];
                    const isPicked =
                      (left && left.date === day.date && left.slot === slot.id) ||
                      (right && right.date === day.date && right.slot === slot.id);
                    return (
                      <button
                        key={slot.id}
                        className={`grid-cell${isPicked ? " picked" : ""}${image ? "" : " empty-cell"}`}
                        onClick={() => {
                          if (!image) return;
                          setLeft(right);
                          setRight({ date: day.date, slot: slot.id });
                          setMode("pair");
                        }}
                        title={image ? "คลิกเพื่อนำไปเทียบ" : "ยังไม่มีภาพ"}
                      >
                        {image ? <img src={image.url} alt="" loading="lazy" decoding="async" /> : null}
                        <span className="grid-cell-tag mono">
                          {image ? `${slot.from.slice(0, 2)}–${slot.to.slice(0, 2)}` : "NO DATA"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          ) : null}

          {mode === "timeline" ? (
            <div className="timeline-view">
              <div className="timeline-head">
                <span className="eyebrow">ไทม์ไลน์ · {timelineDate ? stampDate(timelineDate) : "—"}</span>
                <span style={{ font: "300 11.5px/1 var(--thai)", color: "var(--t-40)" }}>
                  ไล่ดูภาพ 5 ช่วงต่อเนื่องกันในวันเดียว
                </span>
                <div style={{ flex: 1 }} />
                <select
                  className="capture-datepick mono"
                  value={timelineDate ?? ""}
                  onChange={(event) => setTimelineDate(event.target.value)}
                >
                  {allDates.map((date) => (
                    <option key={date} value={date}>
                      {stampDate(date)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="timeline-strip card">
                {(timelineDay?.slots ?? []).map((entry) => {
                  const image = entry.images[kind];
                  const def = slotDef(entry.slot);
                  return (
                    <div
                      key={entry.slot}
                      className={`timeline-cell${image ? "" : " empty-cell"}`}
                      style={{ flex: image ? 1.4 : 1 }}
                    >
                      {image ? <img src={image.url} alt="" loading="lazy" decoding="async" /> : null}
                      <div className="timeline-overlay">
                        <span style={{ font: "500 12px/1 var(--thai)", color: "var(--ink)" }}>{def.th}</span>
                        <span className="mono" style={{ fontSize: 9.5, color: "rgba(255,255,255,.75)" }}>
                          {image ? `${def.from}–${def.to}` : "NO DATA"}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="timeline-notes">
                {(timelineDay?.slots ?? [])
                  .filter((entry) => entry.note)
                  .map((entry) => (
                    <div key={entry.slot} className="timeline-note">
                      <span className="mono">{slotDef(entry.slot).th}</span>
                      <p>{entry.note}</p>
                    </div>
                  ))}
                {(timelineDay?.slots ?? []).every((entry) => !entry.note) ? (
                  <div className="empty">ยังไม่มีโน้ตในวันนี้</div>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
