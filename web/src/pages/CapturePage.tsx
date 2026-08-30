import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../lib/api.ts";
import { useSession } from "../lib/session.tsx";
import { useToast } from "../lib/toast.tsx";
import ShotCell from "../components/ShotCell.tsx";
import AssistantPanel from "../components/AssistantPanel.tsx";
import { fullThaiDate, num, signed, todayIso } from "../lib/format.ts";
import {
  IMAGE_KINDS,
  SLOTS,
  slotDef,
  type DayRecord,
  type EntryRecord,
  type ImageKind,
  type SlotId,
} from "../lib/types.ts";
import "../styles/capture.css";

function metricRows(entry: EntryRecord) {
  const m = entry.metrics;
  return [
    { key: "ราคาปิดช่วง", value: num(m.priceClose, 1), color: "var(--ink)" },
    { key: "Call OI", value: num(m.callOi), color: "var(--green)" },
    { key: "Put OI", value: num(m.putOi), color: "var(--red)" },
    {
      key: "OI Chg รวม",
      value: signed(m.oiChgTotal),
      color: (m.oiChgTotal ?? 0) >= 0 ? "var(--green)" : "var(--red)",
    },
    { key: "P/C Ratio", value: num(m.pcRatio, 2), color: "var(--ink)" },
  ];
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
          .then((saved) =>
            setDay((current) =>
              current
                ? { ...current, slots: current.slots.map((s) => (s.slot === activeSlot ? saved : s)) }
                : current,
            ),
          )
          .catch((error) => toast(error instanceof Error ? error.message : "บันทึกโน้ตไม่สำเร็จ", "err"));
      }, 700);
    },
    [activeSlot, date, toast],
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
    } catch (error) {
      toast(error instanceof Error ? error.message : "ถอดตัวเลขไม่สำเร็จ", "err");
    } finally {
      setExtracting(false);
    }
  }, [activeSlot, date, toast]);

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
    const saved = await api.saveEntry(date, activeSlot, { tags: [...entry.tags, tag] });
    setDay((current) =>
      current
        ? { ...current, slots: current.slots.map((s) => (s.slot === activeSlot ? saved : s)) }
        : current,
    );
    setAddingTag(false);
    setTagDraft("");
  }, [activeSlot, date, entry, tagDraft]);

  const removeTag = useCallback(
    async (tag: string) => {
      if (!entry) return;
      const saved = await api.saveEntry(date, activeSlot, {
        tags: entry.tags.filter((t) => t !== tag),
      });
      setDay((current) =>
        current
          ? { ...current, slots: current.slots.map((s) => (s.slot === activeSlot ? saved : s)) }
          : current,
      );
    },
    [activeSlot, date, entry],
  );

  const canExtract = entry ? Object.keys(entry.images).length > 0 : false;

  return (
    <div className="capture">
      <header className="capture-bar">
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
                                : "rgba(217,178,106,.55)"
                              : "rgba(255,255,255,.09)",
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
              />
            ))}
          </div>

          <div className="capture-lower">
            <div className="capture-note">
              <span className="eyebrow">NOTE</span>
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
              <span className="eyebrow">EXTRACTED BY AI</span>
              <div className="metrics-box">
                {entry && entry.metrics.extractedAt ? (
                  <>
                    {metricRows(entry).map((row) => (
                      <div key={row.key} className="metric-row">
                        <span>{row.key}</span>
                        <b className="mono" style={{ color: row.color }}>
                          {row.value}
                        </b>
                      </div>
                    ))}
                    {entry.metrics.summary ? (
                      <p className="metric-summary">{entry.metrics.summary}</p>
                    ) : null}
                  </>
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
        </section>

        <aside className="capture-aside">
          <AssistantPanel
            thread={date}
            slot={activeSlot}
            subtitle="อ่านภาพ · จดโน้ต · ตอบจากข้อมูลเก่า"
            onNoteSaved={(savedDate) => {
              if (savedDate === date) void load();
            }}
          />
        </aside>
      </div>
    </div>
  );
}
