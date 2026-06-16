import express from "express";
import cookie from "cookie";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { appRouter } from "../routers";
import { ENV } from "./env";
import { COOKIE_NAME } from "../../shared/const";
import type { SessionUser } from "./trpc";

function decodeUserFromCookieHeader(cookieHeader?: string): SessionUser | null {
  if (!cookieHeader) return null;

  const parsed = cookie.parse(cookieHeader);
  const raw = parsed[COOKIE_NAME];
  if (!raw) return null;

  try {
    const json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof json?.id !== "number") return null;
    return {
      id: json.id,
      name: json.name ?? "Operator",
      email: json.email ?? null,
      role: json.role ?? "admin",
      openId: json.openId ?? null,
    };
  } catch {
    return null;
  }
}

const app = express();
app.use(express.json({ limit: ENV.apiBodyLimit }));
app.use(express.urlencoded({ extended: true, limit: ENV.apiBodyLimit }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "switchos-operator-dashboard", timestamp: new Date().toISOString() });
});

app.use(
  "/api/trpc",
  createHTTPHandler({
    router: appRouter,
    createContext({ req, res }) {
      return {
        req,
        res,
        user: decodeUserFromCookieHeader(req.headers.cookie),
      };
    },
  }),
);

app.get("*", (_req, res) => {
  res.status(200).send("SwitchOS API is running.");
});

const port = Number(process.env.PORT || 3005);
app.listen(port, () => {
  console.log(`[SwitchOS] API listening on http://127.0.0.1:${port}`);
});
