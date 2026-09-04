import { Router } from "express";
import { requireUser } from "../auth.js";
import { getUser } from "../auth.js";
import { defaultSettings, SLOT_IDS, type UserSettings } from "../domain.js";
import { updateSettings } from "../store.js";

export const settingsRoutes = Router();

settingsRoutes.use("/settings", requireUser);

settingsRoutes.get("/settings", (req, res) => {
  res.json({ settings: req.user!.settings });
});

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Merges the incoming patch onto the current settings, dropping anything malformed. */
function sanitise(current: UserSettings, patch: unknown): UserSettings {
  if (!patch || typeof patch !== "object") return current;
  const input = patch as Partial<UserSettings>;
  const next: UserSettings = {
    ...current,
    slots: { ...current.slots },
  };

  if (input.slots && typeof input.slots === "object") {
    for (const id of SLOT_IDS) {
      const slot = input.slots[id];
      if (!slot || typeof slot !== "object") continue;
      next.slots[id] = {
        from: TIME.test(String(slot.from)) ? slot.from : current.slots[id].from,
        to: TIME.test(String(slot.to)) ? slot.to : current.slots[id].to,
        remind: TIME.test(String(slot.remind)) ? slot.remind : current.slots[id].remind,
        enabled: typeof slot.enabled === "boolean" ? slot.enabled : current.slots[id].enabled,
      };
    }
  }

  for (const key of ["autoExtract", "dailyDigest", "incompleteReminder", "contributeToModel"] as const) {
    if (typeof input[key] === "boolean") next[key] = input[key];
  }
  if (typeof input.contract === "string" && input.contract.trim()) {
    next.contract = input.contract.trim().slice(0, 40);
  }
  return next;
}

settingsRoutes.put("/settings", async (req, res) => {
  const next = sanitise(req.user!.settings, req.body?.settings ?? req.body);
  await updateSettings(req.user!.id, next);
  res.json({ settings: (await getUser(req.user!.id))?.settings ?? next });
});

settingsRoutes.post("/settings/reset", async (req, res) => {
  const next = defaultSettings();
  await updateSettings(req.user!.id, next);
  res.json({ settings: next });
});
