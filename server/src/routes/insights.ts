import { Router } from "express";
import { requireUser } from "../auth.js";
import { SLOTS, type SlotId } from "../domain.js";
import { getDay, getSeries, getStreak } from "../store.js";
import { isDateString, isSlotId } from "../domain.js";

export const insightRoutes = Router();

insightRoutes.use(["/stats", "/compare", "/export.csv"], requireUser);

function mean(values: number[]): number | null {
  const usable = values.filter((v) => Number.isFinite(v));
  if (usable.length === 0) return null;
  return usable.reduce((a, b) => a + b, 0) / usable.length;
}

/** Pearson correlation, or null when either series has fewer than three points. */
function correlation(xs: number[], ys: number[]): number | null {
  const pairs = xs.map((x, i) => [x, ys[i]] as const).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pairs.length < 3) return null;
  const mx = mean(pairs.map((p) => p[0]))!;
  const my = mean(pairs.map((p) => p[1]))!;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (const [x, y] of pairs) {
    num += (x - mx) * (y - my);
    dx += (x - mx) ** 2;
    dy += (y - my) ** 2;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

insightRoutes.get("/stats", (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days ?? 30) || 30, 1), 365);
  const series = getSeries(req.user!.id, days);
  const streak = getStreak(req.user!.id);

  const bySlot = SLOTS.map((def) => {
    const points = series.filter((p) => p.slot === def.id);
    const chgs = points.map((p) => p.oiChg).filter((v): v is number => v !== null);
    return {
      slot: def.id,
      label: def.th,
      avgOiChg: mean(chgs),
      up: chgs.filter((v) => v > 0).length,
      down: chgs.filter((v) => v < 0).length,
      samples: points.length,
    };
  });

  const latest = [...series].reverse().find((p) => p.pcRatio !== null) ?? null;

  res.json({
    days,
    series,
    bySlot,
    streak,
    correlation: correlation(
      series.map((p) => p.priceClose ?? NaN),
      series.map((p) => p.oi ?? NaN),
    ),
    latestPcRatio: latest?.pcRatio ?? null,
    avgOiChg: mean(series.map((p) => p.oiChg).filter((v): v is number => v !== null)),
  });
});

/** Two (date, slot) pairs side by side, with the numeric deltas between them. */
insightRoutes.get("/compare", (req, res) => {
  const parse = (raw: unknown): { date: string; slot: SlotId } | null => {
    if (typeof raw !== "string") return null;
    const [date, slot] = raw.split("_");
    if (!date || !slot || !isDateString(date) || !isSlotId(slot)) return null;
    return { date, slot };
  };

  const left = parse(req.query.left);
  const right = parse(req.query.right);
  if (!left || !right) {
    res.status(400).json({ error: "left and right must look like YYYY-MM-DD_slot" });
    return;
  }

  const pick = (target: { date: string; slot: SlotId }) =>
    getDay(req.user!.id, target.date).slots.find((s) => s.slot === target.slot)!;

  const a = pick(left);
  const b = pick(right);

  const delta = (
    key:
      | "priceClose"
      | "intradayPut"
      | "intradayCall"
      | "vol"
      | "volChg"
      | "futureChg"
      | "callOi"
      | "putOi"
      | "pcRatio"
      | "callOiChg"
      | "putOiChg"
      | "oiChgTotal",
  ) => {
    const av = a.metrics[key];
    const bv = b.metrics[key];
    if (typeof av !== "number" || typeof bv !== "number") return null;
    return bv - av;
  };

  res.json({
    left: a,
    right: b,
    deltas: {
      priceClose: delta("priceClose"),
      intradayPut: delta("intradayPut"),
      intradayCall: delta("intradayCall"),
      vol: delta("vol"),
      volChg: delta("volChg"),
      futureChg: delta("futureChg"),
      callOi: delta("callOi"),
      putOi: delta("putOi"),
      pcRatio: delta("pcRatio"),
      callOiChg: delta("callOiChg"),
      putOiChg: delta("putOiChg"),
      oiChgTotal: delta("oiChgTotal"),
    },
  });
});

insightRoutes.get("/export.csv", (req, res) => {
  const series = getSeries(req.user!.id, 3650);
  const escape = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ["date", "slot", "price_close", "oi_total", "oi_chg", "pc_ratio", "note", "tags"];
  const lines = [header.join(",")];

  const noteCache = new Map<string, ReturnType<typeof getDay>>();
  for (const point of series) {
    if (!noteCache.has(point.date)) noteCache.set(point.date, getDay(req.user!.id, point.date));
    const entry = noteCache.get(point.date)!.slots.find((s) => s.slot === point.slot)!;
    lines.push(
      [
        point.date,
        point.slot,
        point.priceClose,
        point.oi,
        point.oiChg,
        point.pcRatio,
        entry.note.replace(/\n/g, " "),
        entry.tags.join(" "),
      ]
        .map(escape)
        .join(","),
    );
  }

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="optiary-dataset.csv"');
  res.send(`﻿${lines.join("\n")}\n`);
});
