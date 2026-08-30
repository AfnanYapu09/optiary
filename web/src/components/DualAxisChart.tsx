import { useMemo, useState } from "react";
import { num, shortThaiDate } from "../lib/format.ts";
import { slotDef, type SeriesPoint } from "../lib/types.ts";

const W = 1000;
const H = 260;
const PAD = { top: 14, right: 8, bottom: 22, left: 8 };

type Scaled = { x: number; price: number | null; oi: number | null; point: SeriesPoint };

function extent(values: number[]): [number, number] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return [min - 1, max + 1];
  const pad = (max - min) * 0.12;
  return [min - pad, max + pad];
}

/**
 * Price (gold, solid) against total open interest (blue, dashed) on independent
 * axes — the comparison the research workflow is built around.
 */
export default function DualAxisChart({ series }: { series: SeriesPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);

  const scaled = useMemo<Scaled[]>(() => {
    const prices = series.map((p) => p.priceClose).filter((v): v is number => v !== null);
    const ois = series.map((p) => p.oi).filter((v): v is number => v !== null);
    if (series.length === 0) return [];

    const [pMin, pMax] = prices.length ? extent(prices) : [0, 1];
    const [oMin, oMax] = ois.length ? extent(ois) : [0, 1];
    const plotH = H - PAD.top - PAD.bottom;
    const step = series.length > 1 ? (W - PAD.left - PAD.right) / (series.length - 1) : 0;

    return series.map((point, index) => ({
      x: PAD.left + index * step,
      price:
        point.priceClose === null
          ? null
          : PAD.top + plotH - ((point.priceClose - pMin) / (pMax - pMin)) * plotH,
      oi: point.oi === null ? null : PAD.top + plotH - ((point.oi - oMin) / (oMax - oMin)) * plotH,
      point,
    }));
  }, [series]);

  /** Breaks the polyline wherever a value is missing, rather than interpolating over gaps. */
  const path = (key: "price" | "oi"): string =>
    scaled
      .reduce<string[]>((out, item) => {
        if (item[key] === null) {
          out.push("");
          return out;
        }
        const previous = out[out.length - 1];
        const command = previous === undefined || previous === "" ? "M" : "L";
        if (previous === "") out.pop();
        out.push(`${command}${item.x.toFixed(1)},${item[key]!.toFixed(1)}`);
        return out;
      }, [])
      .join(" ")
      .trim();

  if (series.length === 0) {
    return <div className="empty">ยังไม่มีตัวเลขพอจะวาดกราฟ — อัปโหลดภาพแล้วให้ AI ถอดตัวเลขก่อน</div>;
  }

  const active = hover !== null ? scaled[hover] : null;
  const dayBoundaries = scaled.filter((item, index) => index > 0 && item.point.date !== scaled[index - 1].point.date);

  return (
    <div className="chart-frame">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="ราคา Intraday เทียบกับ Open Interest">
        {[0, 1, 2, 3, 4].map((i) => (
          <line
            key={`grid-${i}`}
            x1={0}
            x2={W}
            y1={PAD.top + (i * (H - PAD.top - PAD.bottom)) / 4}
            y2={PAD.top + (i * (H - PAD.top - PAD.bottom)) / 4}
            stroke="rgba(255,255,255,.055)"
            strokeWidth={1}
          />
        ))}
        {dayBoundaries.map((item) => (
          <line
            key={`sep-${item.point.date}`}
            x1={item.x}
            x2={item.x}
            y1={0}
            y2={H - PAD.bottom}
            stroke="rgba(255,255,255,.06)"
            strokeWidth={1}
          />
        ))}

        <path d={path("oi")} fill="none" stroke="#6f9fd8" strokeWidth={2} strokeDasharray="6 5" strokeLinejoin="round" />
        <path d={path("price")} fill="none" stroke="#d9b26a" strokeWidth={2.4} strokeLinejoin="round" />

        {active ? (
          <line x1={active.x} x2={active.x} y1={0} y2={H - PAD.bottom} stroke="rgba(217,178,106,.5)" strokeWidth={1} />
        ) : null}

        {scaled.map((item, index) => (
          <rect
            key={`hit-${item.point.date}-${item.point.slot}`}
            x={item.x - (W / Math.max(series.length, 1)) / 2}
            y={0}
            width={W / Math.max(series.length, 1)}
            height={H}
            fill="transparent"
            onMouseEnter={() => setHover(index)}
            onMouseLeave={() => setHover((current) => (current === index ? null : current))}
          />
        ))}
      </svg>

      {active ? (
        <div
          className="chart-tip"
          style={{ left: `${(active.x / W) * 100}%` }}
          role="tooltip"
        >
          <b>
            {shortThaiDate(active.point.date)} · {slotDef(active.point.slot).th}
          </b>
          <span>
            <i style={{ background: "#d9b26a" }} />
            ราคา {num(active.point.priceClose, 1)}
          </span>
          <span>
            <i style={{ background: "#6f9fd8" }} />
            OI {num(active.point.oi)}
          </span>
          {active.point.pcRatio !== null ? <span>P/C {num(active.point.pcRatio, 2)}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
