import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../lib/api.ts";
import { useSession } from "../lib/session.tsx";
import { useToast } from "../lib/toast.tsx";
import ShotCell from "../components/ShotCell.tsx";
import AssistantPanel from "../components/AssistantPanel.tsx";
import Lightbox, { type LightboxItem } from "../components/Lightbox.tsx";
import { fullThaiDate, num, signed, todayIso } from "../lib/format.ts";
import { syncEntryToCloud } from "../lib/firebase.ts";
import {
  IMAGE_KINDS,
  KIND_LABELS,
  SLOTS,
  slotDef,
  type DayNews,
  type DayRecord,
  type EntryRecord,
  type ImageKind,
  type SlotId,
} from "../lib/types.ts";
import "../styles/capture.css";

/** Day-level economic news — shown under the slots so it's visible from any slot. */
function NewsPanel({ news }: { news: DayNews }) {
  if (!news.events.length && !news.weekSummary) return null;
  return (
    <div className="news-panel">
      <span className="eyebrow">ข่าวเศรษฐกิจวันนี้ (แดง / วันหยุด)</span>
      {news.events.length ? (
        <div className="news-table">
          <div className="news-row news-head">
            <span className="news-time">เวลา</span>
            <span className="news-cur">สกุล</span>
            <span className="news-title">ข่าว</span>
            <span className="news-nums">
              <b>Actual</b>
              <i>Fcst</i>
              <i>Prev</i>
            </span>
          </div>
          {news.events.map((e, i) => (
            <div key={i} className={`news-row${e.holiday ? " holiday" : ""}`}>
              <span className="news-time mono">{e.holiday ? "ทั้งวัน" : e.time || "—"}</span>
              <span className="news-cur mono">{e.currency || ""}</span>
              <span className="news-title">{e.title}</span>
              <span className="news-nums mono">
                {[e.actual, e.forecast, e.previous].some(Boolean) ? (
                  <>
                    <b>{e.actual || "–"}</b>
                    <i>{e.forecast || "–"}</i>
                    <i>{e.previous || "–"}</i>
                  </>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {news.weekSummary ? (
        <p className="news-week">
          <b>🗓️ ข่าวแรงสุดของสัปดาห์:</b> {news.weekSummary}
        </p>
      ) : null}
    </div>
  );
}

const chgClass = (v: number | null | undefined) => ((v ?? 0) >= 0 ? "is-up" : "is-down");

/**
 * The numbers off the screenshots, laid out the way an option book is read:
 * Put against Call in two columns, then the day's single figures underneath.
 * A flat list of twelve rows made the reader do that pairing in their head.
 */
function MetricsPanel({ entry }: { entry: EntryRecord }) {
  const m = entry.metrics;
  // Ordered to match the three screenshots as they are captured and shown
  // above: Intraday, then OI, then OI Chg.
  const pairs: Array<{ label: string; put: string; call: string; signedPair?: boolean }> = [
    { label: "INTRADAY", put: num(m.intradayPut), call: num(m.intradayCall) },
    { label: "OI", put: num(m.putOi), call: num(m.callOi) },
    { label: "OI CHG", put: signed(m.putOiChg), call: signed(m.callOiChg), signedPair: true },
  ];
  // Everything on the Intraday header is always shown, even unread. A field
  // that silently disappears when null reads as "this app doesn't track it",
  // where a "—" correctly says "not read off this screenshot".
  const singles = [
    { label: "P/C Ratio", value: num(m.pcRatio, 2), cls: "" },
    { label: "OI เปลี่ยนแปลงรวม", value: signed(m.oiChgTotal), cls: chgClass(m.oiChgTotal) },
    { label: "ราคาปัจจุบัน", value: num(m.priceClose, 1), cls: "" },
    { label: "Future Chg", value: signed(m.futureChg, 1), cls: chgClass(m.futureChg) },
    { label: "Vol", value: num(m.vol, 2), cls: "" },
    { label: "Vol Chg", value: signed(m.volChg, 2), cls: chgClass(m.volChg) },
  ];

  return (
    <>
      <div className="pc-table">
        <div className="pc-head">
          <span />
          <span className="is-put">PUT</span>
          <span className="is-call">CALL</span>
        </div>
        {pairs.map((row) => (
          <div key={row.label} className="pc-row">
            <span className="pc-label">{row.label}</span>
            <b className={`mono ${row.signedPair ? chgClass(m.putOiChg) : "is-put"}`}>{row.put}</b>
            <b className={`mono ${row.signedPair ? chgClass(m.callOiChg) : "is-call"}`}>{row.call}</b>
          </div>
        ))}
      </div>

      <div className="metric-singles">
        {singles.map((row) => (
          <div key={row.label} className={`metric-single${row.value === "—" ? " unread" : ""}`}>
            <span className="eyebrow">{row.label}</span>
            <b className={`mono ${row.value === "—" ? "" : row.cls}`}>{row.value}</b>
          </div>
        ))}
      </div>

      {/* The model's full read-out is long and is not what the eye should land
       * on — folded away, with the numbers above left as the headline. */}
      {m.summary ? (
        <details className="metric-summary">
          <summary>สิ่งที่ AI อ่านได้จากภาพ</summary>
          <p>{m.summary}</p>
        </details>
      ) : null}
    </>
  );
}

export default function CapturePage() {
  const { date = todayIso() } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useSession();

  const [day, setDay] = useState<DayRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState<ImageKind | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [note, setNote] = useState("");
  const [tagDraft, setTagDraft] = useState("");
  const [addingTag, setAddingTag] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const saveTimer = useRef<number | null>(null);

  const slotParam = params.get("slot");
  const activeSlot: SlotId = useMemo(() => {
    if (slotParam && SLOTS.some((s) => s.id === slotParam)) return slotParam as SlotId;
    return "night";
  }, [slotParam]);

  const entry = day?.slots.find((s) => s.slot === activeSlot) ?? null;
  const def = slotDef(activeSlot);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.day(date);
      setDay(result);
      setNote(result.slots.find((s) => s.slot === activeSlot)?.note ?? "");
    } catch (error) {
      toast(error instanceof Error ? error.message : "โหลดบันทึกไม่สำเร็จ", "err");
    } finally {
      setLoading(false);
    }
  }, [activeSlot, date, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Notes save on a debounce so typing never blocks on the network.
  const queueNoteSave = useCallback(
    (value: string) => {
      setNote(value);
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        api
          .saveEntry(date, activeSlot, { note: value })
          .then((saved) => {
            setDay((current) =>
              current
                ? { ...current, slots: current.slots.map((s) => (s.slot === activeSlot ? saved : s)) }
                : current,
            );
            if (user?.id) {
              void syncEntryToCloud(user.id, date, activeSlot, { note: value });
            }
          })
          .catch((error) => toast(error instanceof Error ? error.message : "บันทึกโน้ตไม่สำเร็จ", "err"));
      }, 700);
    },
    [activeSlot, date, toast, user?.id],
  );

  useEffect(() => () => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
  }, []);

  const upload = useCallback(
    async (kind: ImageKind, file: File) => {
      setUploading(kind);
      try {
        const result = await api.uploadImage(date, activeSlot, kind, file);
        setDay(result.day);
        if (result.extraction?.ok) toast("อัปโหลดแล้ว · AI ถอดตัวเลขให้เรียบร้อย", "ok");
        else if (result.extraction && !result.extraction.ok)
          toast(`อัปโหลดแล้ว แต่ถอดตัวเลขไม่สำเร็จ: ${result.extraction.message}`, "err");
        else toast("อัปโหลดภาพแล้ว", "ok");
      } catch (error) {
        toast(error instanceof Error ? error.message : "อัปโหลดไม่สำเร็จ", "err");
      } finally {
        setUploading(null);
      }
    },
    [activeSlot, date, toast],
  );

  const removeImage = useCallback(
    async (id: string) => {
      try {
        await api.deleteImage(id);
        setDay(await api.day(date));
      } catch (error) {
        toast(error instanceof Error ? error.message : "ลบภาพไม่สำเร็จ", "err");
      }
    },
    [date, toast],
  );

  const runExtract = useCallback(async () => {
    setExtracting(true);
    try {
      const result = await api.extract(date, activeSlot);
      setDay((current) =>
        current
          ? { ...current, slots: current.slots.map((s) => (s.slot === activeSlot ? result.entry : s)) }
          : current,
      );
      toast(`AI ถอดตัวเลขแล้ว (ความมั่นใจ ${result.confidence})`, "ok");
      if (user?.id) {
        void syncEntryToCloud(user.id, date, activeSlot, {
          note: result.entry.note,
          tags: result.entry.tags,
          metrics: result.entry.metrics,
        });
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : "ถอดตัวเลขไม่สำเร็จ", "err");
    } finally {
      setExtracting(false);
    }
  }, [activeSlot, date, toast, user?.id]);

  const addTag = useCallback(async () => {
    const value = tagDraft.trim().replace(/^#*/, "");
    if (!value || !entry) {
      setAddingTag(false);
      setTagDraft("");
      return;
    }
    const tag = `#${value}`;
    if (entry.tags.includes(tag)) {
      setAddingTag(false);
      setTagDraft("");
      return;
    }
    const newTags = [...entry.tags, tag];
    const saved = await api.saveEntry(date, activeSlot, { tags: newTags });
    setDay((current) =>
      current
        ? { ...current, slots: current.slots.map((s) => (s.slot === activeSlot ? saved : s)) }
        : current,
    );
    if (user?.id) {
      void syncEntryToCloud(user.id, date, activeSlot, { tags: newTags });
    }
    setAddingTag(false);
    setTagDraft("");
  }, [activeSlot, date, entry, tagDraft, user?.id]);

  const removeTag = useCallback(
    async (tag: string) => {
      if (!entry) return;
      const newTags = entry.tags.filter((t) => t !== tag);
      const saved = await api.saveEntry(date, activeSlot, {
        tags: newTags,
      });
      setDay((current) =>
        current
          ? { ...current, slots: current.slots.map((s) => (s.slot === activeSlot ? saved : s)) }
          : current,
      );
      if (user?.id) {
        void syncEntryToCloud(user.id, date, activeSlot, { tags: newTags });
      }
    },
    [activeSlot, date, entry, user?.id],
  );

  const canExtract = entry ? Object.keys(entry.images).length > 0 : false;

  /** Only the shots this slot actually has, in capture order, so the viewer's
   * arrows step through Intraday → OI → OI Chg without hitting empty slots. */
  const shots: Array<{ kind: ImageKind; item: LightboxItem }> = IMAGE_KINDS.flatMap((kind) => {
    const image = entry?.images[kind];
    if (!image) return [];
    return [
      {
        kind,
        item: {
          url: image.url,
          title: KIND_LABELS[kind],
          caption: `${fullThaiDate(date)} · ช่วง${def.th} · ${def.from}–${def.to}`,
        },
      },
    ];
  });

  return (
    <div className="capture">
      <header className="toolbar capture-bar">
        <div className="capture-bar-left">
          <button className="linkish" onClick={() => navigate("/")}>
            ‹ ปฏิทิน
          </button>
          <span className="capture-date">{fullThaiDate(date)}</span>
          <input
            className="capture-datepick mono"
            type="date"
            value={date}
            onChange={(event) => {
              if (event.target.value) navigate(`/day/${event.target.value}?slot=${activeSlot}`);
            }}
            aria-label="เลือกวันที่"
          />
          <span className="pill">
            {day?.imageCount ?? 0} / {day?.imageTarget ?? 15} ภาพ
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <a className="btn" href="/api/export.csv">
            ส่งออก CSV
          </a>
          <button className="btn-gold" disabled={!canExtract || extracting} onClick={() => void runExtract()}>
            {extracting ? "กำลังอ่านภาพ…" : "ให้ AI อ่านภาพ"}
          </button>
        </div>
      </header>

      <div className="capture-body">
        <section className="capture-main">
          <div className="slot-steps">
            {SLOTS.map((slot) => {
              const record = day?.slots.find((s) => s.slot === slot.id);
              const filled = record ? Object.keys(record.images).length : 0;
              const active = slot.id === activeSlot;
              return (
                <button
                  key={slot.id}
                  className={`slot-step${active ? " active" : ""}`}
                  onClick={() => setParams({ slot: slot.id }, { replace: true })}
                >
                  <span className="slot-step-head">
                    <b>{slot.th}</b>
                    <em className="mono">
                      {slot.from.slice(0, 2)}–{slot.to.slice(0, 2)}
                    </em>
                  </span>
                  <span className="slot-step-dots">
                    {IMAGE_KINDS.map((_, index) => (
                      <i
                        key={index}
                        style={{
                          background:
                            index < filled
                              ? active
                                ? "var(--gold)"
                                : "var(--gold-line)"
                              : "var(--line-2)",
                        }}
                      />
                    ))}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="capture-title">
            <h2>ช่วง{def.th}</h2>
            <span className="mono">
              {def.from} – {def.to} · {user?.settings.contract}
            </span>
          </div>

          <div className="shot-row">
            {IMAGE_KINDS.map((kind) => (
              <ShotCell
                key={kind}
                kind={kind}
                image={entry?.images[kind]}
                height={186}
                busy={uploading === kind}
                pasteTarget={kind === IMAGE_KINDS.find((k) => !entry?.images[k])}
                caption={
                  kind === "intraday"
                    ? `INTRADAY · ${def.from}`
                    : kind === "oi"
                      ? "OPEN INTEREST"
                      : "OI CHANGE"
                }
                onUpload={(file) => void upload(kind, file)}
                onRemove={
                  entry?.images[kind] ? () => void removeImage(entry.images[kind]!.id) : undefined
                }
                onView={
                  entry?.images[kind]
                    ? () => setViewing(shots.findIndex((s) => s.kind === kind))
                    : undefined
                }
              />
            ))}
          </div>

          <div className="capture-lower">
            <div className="capture-note">
              <span className="eyebrow">โน้ตของช่วงนี้</span>
              <div className="note-box">
                <textarea
                  value={note}
                  onChange={(event) => queueNoteSave(event.target.value)}
                  placeholder="จดสิ่งที่สังเกตเห็นในช่วงนี้ — ราคา แรงซื้อขาย OI ที่สตราคไหน…"
                  disabled={loading}
                />
                <div className="note-tags">
                  {(entry?.tags ?? []).map((tag) => (
                    <button key={tag} className="tag-chip" onClick={() => void removeTag(tag)} title="คลิกเพื่อลบ">
                      {tag}
                    </button>
                  ))}
                  {addingTag ? (
                    <input
                      autoFocus
                      className="tag-input"
                      value={tagDraft}
                      placeholder="ชื่อแท็ก"
                      onChange={(event) => setTagDraft(event.target.value)}
                      onBlur={() => void addTag()}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void addTag();
                        if (event.key === "Escape") {
                          setAddingTag(false);
                          setTagDraft("");
                        }
                      }}
                    />
                  ) : (
                    <button className="tag-chip gold" onClick={() => setAddingTag(true)}>
                      + แท็ก
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="capture-metrics">
              <span className="eyebrow">ตัวเลขที่ AI อ่านได้</span>
              <div className="metrics-box">
                {entry && entry.metrics.extractedAt ? (
                  <MetricsPanel entry={entry} />
                ) : (
                  <div className="empty">
                    {canExtract
                      ? "กด “ให้ AI อ่านภาพ” เพื่อถอดตัวเลขจากภาพในช่วงนี้"
                      : "อัปโหลดภาพก่อน แล้ว AI จะถอดตัวเลขให้อัตโนมัติ"}
                  </div>
                )}
              </div>
            </div>
          </div>

          {day ? <NewsPanel news={day.news} /> : null}
        </section>

        <aside className="capture-aside">
          <AssistantPanel
            thread={date}
            slot={activeSlot}
            subtitle="อ่านภาพ · จดโน้ต · ข่าว · ตอบจากข้อมูลเก่า"
            onNoteSaved={(savedDate) => {
              if (savedDate === date) void load();
            }}
          />
        </aside>
      </div>

      {viewing !== null && shots[viewing] ? (
        <Lightbox
          items={shots.map((s) => s.item)}
          index={viewing}
          onIndex={setViewing}
          onClose={() => setViewing(null)}
        />
      ) : null}
    </div>
  );
}
