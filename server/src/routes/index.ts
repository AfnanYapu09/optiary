import { Router } from "express";
import { authRoutes } from "./auth.js";
import { dayRoutes } from "./days.js";
import { imageRoutes } from "./images.js";
import { chatRoutes } from "./chat.js";
import { insightRoutes } from "./insights.js";
import { settingsRoutes } from "./settings.js";

export const api = Router();

api.get("/health", (_req, res) => {
  res.json({ ok: true });
});

api.use(authRoutes);
api.use(dayRoutes);
api.use(imageRoutes);
api.use(chatRoutes);
api.use(insightRoutes);
api.use(settingsRoutes);
