import { Router } from "express";
import { requireUser } from "../auth.js";
import { isDateString, isSlotId } from "../domain.js";
import { getCalendar, getDay, getStreak, saveEntry } from "../store.js";

export const dayRoutes = Router();

dayRoutes.use(["/calendar", "/days", "/days/*"], requireUser);

dayRoutes.get("/calendar", (req, res) => {
  const month = typeof req.query.month === "string" ? req.query.month : "";
  if (!/^\d{4}-\d{2}$/.test(month)) {
    res.status(400).json({ error: "month must be YYYY-MM" });
    return;
  }
  res.json({ month, days: getCalendar(req.user!.id, month), streak: getStreak(req.user!.id) });
});

dayRoutes.get("/days/:date", (req, res) => {
  const date = String(req.params.date ?? "");
  if (!isDateString(date)) {
    res.status(400).json({ error: "date must be YYYY-MM-DD" });
    return;
  }
  res.json(getDay(req.user!.id, date));
});

dayRoutes.put("/days/:date/:slot", (req, res) => {
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

  res.json(saveEntry(req.user!.id, date, slot, { note, tags, metrics }));
});
