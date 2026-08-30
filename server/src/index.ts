import fs from "node:fs";
import path from "node:path";
import express from "express";
import cookieParser from "cookie-parser";
import { config } from "./config.js";
import { attachUser } from "./auth.js";
import { api } from "./routes/index.js";
import { seedIfEmpty } from "./seed.js";

const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());

// Enable CORS in dev mode if accessed across ports
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || config.webOrigin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(attachUser);
app.use("/api", api);

function getWebRoot(): string {
  const p1 = path.resolve(process.cwd(), "web");
  if (fs.existsSync(p1)) return p1;
  const p2 = path.resolve(process.cwd(), "../web");
  if (fs.existsSync(p2)) return p2;
  return p1;
}

function getWebDist(): string {
  const p1 = path.resolve(process.cwd(), "web/dist");
  if (fs.existsSync(p1)) return p1;
  const p2 = path.resolve(process.cwd(), "../web/dist");
  if (fs.existsSync(p2)) return p2;
  return p1;
}

async function startServer() {
  // Ensure database has demo data if first run
  try {
    seedIfEmpty();
  } catch (err) {
    console.warn("Could not auto-seed demo data:", err);
  }

  if (process.env.NODE_ENV !== "production") {
    const webRoot = getWebRoot();
    const { createServer: createViteServer } = await (Function('return import("vite")')() as Promise<any>);
    const vite = await createViteServer({
      root: webRoot,
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const webDist = getWebDist();
    if (fs.existsSync(webDist)) {
      app.use(express.static(webDist));
      app.get("*", (_req, res) => res.sendFile(path.join(webDist, "index.html")));
    }
  }

  app.listen(config.port, "0.0.0.0", () => {
    console.log(`optiary server listening on http://0.0.0.0:${config.port}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
