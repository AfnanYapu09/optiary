import { Router } from "express";
import { requireUser } from "../auth.js";
import { isDateString, isGammaRegime, isSlotId, type GammaRegime } from "../domain.js";
import { getCalendar, getDay, getStreak, saveDayMarks, saveEntry } from "../store.js";

export const dayRoutes = Router();

dayRoutes.use(["/calendar", "/days", "/days/*"], requireUser);

dayRoutes.get("/calendar", async (req, res) => {
  const month = typeof req.query.month === "string" ? req.query.month : "";
  if (!/^\d{4}-\d{2}$/.test(month)) {
    res.status(400).json({ error: "month must be YYYY-MM" });
    return;
  }
  const [days, streak] = await Promise.all([
    getCalendar(req.user!.id, month),
    getStreak(req.user!.id),
  ]);
  res.json({ month, days, streak });
});

dayRoutes.get("/days/:date", async (req, res) => {
  const date = String(req.params.date ?? "");
  if (!isDateString(date)) {
    res.status(400).json({ error: "date must be YYYY-MM-DD" });
    return;
  }
  res.json(await getDay(req.user!.id, date));
});

/**
 * The day's gamma call and the note that goes with the reveal chart.
 *
 * Declared before `/days/:date/:slot`, which would otherwise match this path
 * first and reject "marks" as an unknown slot.
 *
 * Saved as `user`, so a reading a person set here outranks the assistant's and
 * will not be quietly replaced the next time the model looks at the day.
 */
dayRoutes.put("/days/:date/marks", async (req, res) => {
  const date = String(req.params.date ?? "");
  if (!isDateString(date)) {
    res.status(400).json({ error: "date must be YYYY-MM-DD" });
    return;
  }

  const patch: { gamma?: GammaRegime | null; revealNote?: string } = {};
  if ("gamma" in (req.body ?? {})) {
    const raw = req.body.gamma;
    if (raw === null || raw === "") patch.gamma = null;
    else if (typeof raw === "string" && isGammaRegime(raw)) patch.gamma = raw;
    else {
      res.status(400).json({ error: "gamma must be 'short', 'long' or null" });
      return;
    }
  }
  if (typeof req.body?.revealNote === "string") {
    patch.revealNote = req.body.revealNote.slice(0, 2000);
  }

  res.json({ marks: await saveDayMarks(req.user!.id, date, patch, "user") });
});

dayRoutes.put("/days/:date/:slot", async (req, res) => {
  const date = String(req.params.date ?? "");
  const slot = String(req.params.slot ?? "");
  if (!isDateString(date) || !isSlotId(slot)) {
    res.status(400).json({ error: "bad date or slot" });
    return;
  }
  const note = typeof req.body?.note === "string" ? req.body.note : undefined;
  const tags = Array.isArray(req.body?.tags)
    ? (req.body.tags as unknown[]).filter((t): t is string => typeof t === "string").slice(0, 24)
    : undefined;
  const metrics =
    req.body?.metrics && typeof req.body.metrics === "object" ? req.body.metrics : undefined;

  res.json(await saveEntry(req.user!.id, date, slot, { note, tags, metrics }));
});
