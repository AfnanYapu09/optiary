import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "../styles/lightbox.css";

export type LightboxItem = { url: string; title: string; caption?: string };

/** How far in a click-to-zoom goes. The source screenshots are dense option
 * charts, so reading a strike label needs real magnification, not a nudge. */
const ZOOM = 2.6;

/**
 * Full-screen image viewer. Click (or press +) to zoom, drag to pan, arrow
 * keys to move between the shots of a slot, Esc to leave.
 */
export default function Lightbox({
  items,
  index,
  onIndex,
  onClose,
}: {
  items: LightboxItem[];
  index: number;
  onIndex: (next: number) => void;
  onClose: () => void;
}) {
  const [zoomed, setZoomed] = useState(false);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{
    x: number;
    y: number;
    panX: number;
    panY: number;
    moved?: boolean;
  } | null>(null);
  const item = items[index];

  const reset = useCallback(() => {
    setZoomed(false);
    setPan({ x: 0, y: 0 });
  }, []);

  const go = useCallback(
    (delta: number) => {
      if (items.length < 2) return;
      reset();
      onIndex((index + delta + items.length) % items.length);
    },
    [index, items.length, onIndex, reset],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowRight") go(1);
      else if (event.key === "ArrowLeft") go(-1);
      else if (event.key === "+" || event.key === "=" || event.key === "-") {
        setZoomed((z) => !z);
        setPan({ x: 0, y: 0 });
      }
    };
    window.addEventListener("keydown", onKey);
    // The page behind must not scroll away under the overlay.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [go, onClose]);

  if (!item) return null;

  return createPortal(
    <div className="lb" role="dialog" aria-modal="true" aria-label={item.title}>
      <div className="lb-backdrop" onClick={onClose} />

      <header className="lb-bar">
        <div className="lb-title">
          <b>{item.title}</b>
          {item.caption ? <span>{item.caption}</span> : null}
        </div>
        <div className="lb-tools">
          {items.length > 1 ? (
            <span className="lb-count mono">
              {index + 1} / {items.length}
            </span>
          ) : null}
          <button
            className="lb-btn"
            onClick={() => {
              setZoomed((z) => !z);
              setPan({ x: 0, y: 0 });
            }}
          >
            {zoomed ? "ย่อลง" : "ซูมเข้า"}
          </button>
          <a className="lb-btn" href={item.url} target="_blank" rel="noreferrer">
            เปิดแท็บใหม่
          </a>
          <button className="lb-btn lb-close" onClick={onClose} aria-label="ปิด">
            ✕
          </button>
        </div>
      </header>

      {items.length > 1 ? (
        <>
          <button className="lb-nav prev" onClick={() => go(-1)} aria-label="ภาพก่อนหน้า">
            ‹
          </button>
          <button className="lb-nav next" onClick={() => go(1)} aria-label="ภาพถัดไป">
            ›
          </button>
        </>
      ) : null}

      <div className={`lb-stage${zoomed ? " zoomed" : ""}`} onClick={onClose}>
        <img
          src={item.url}
          alt={item.title}
          draggable={false}
          style={
            zoomed
              ? { transform: `translate(${pan.x}px, ${pan.y}px) scale(${ZOOM})` }
              : undefined
          }
          // Clicks on the image itself zoom; clicks on the surrounding stage
          // fall through to the backdrop and close.
          onClick={(event) => {
            event.stopPropagation();
            if (drag.current?.moved) return;
            setZoomed((z) => !z);
            setPan({ x: 0, y: 0 });
          }}
          onPointerDown={(event) => {
            if (!zoomed) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
          }}
          onPointerMove={(event) => {
            const start = drag.current;
            if (!start) return;
            const dx = event.clientX - start.x;
            const dy = event.clientY - start.y;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.current!.moved = true;
            setPan({ x: start.panX + dx, y: start.panY + dy });
          }}
          onPointerUp={() => {
            // Cleared on the next tick so the click handler above can see that
            // this pointer sequence was a drag, not a tap.
            const wasDrag = drag.current;
            window.setTimeout(() => {
              if (drag.current === wasDrag) drag.current = null;
            }, 0);
          }}
        />
      </div>

      <footer className="lb-hint">
        คลิกที่ภาพเพื่อซูม · ลากเพื่อเลื่อน{items.length > 1 ? " · ← → เปลี่ยนภาพ" : ""} · Esc ปิด
      </footer>
    </div>,
    document.body,
  );
}
