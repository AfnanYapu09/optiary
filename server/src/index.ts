import fs from "node:fs";
import path from "node:path";
import express from "express";
import cookieParser from "cookie-parser";
import { config } from "./config.js";
import { attachUser } from "./auth.js";
import { api } from "./routes/index.js";

const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// The Vite dev server runs on a different origin; production serves the built
// bundle from this process, where no CORS handling is needed at all.
if (process.env.NODE_ENV !== "production") {
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", config.webOrigin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });
}

app.use(attachUser);
app.use("/api", api);

const webDist = path.resolve(process.cwd(), "../web/dist");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get("*", (_req, res) => res.sendFile(path.join(webDist, "index.html")));
}

app.listen(config.port, () => {
  console.log(`optiary api listening on http://localhost:${config.port}`);
});
