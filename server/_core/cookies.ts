import type { IncomingMessage } from "http";
import { ENV } from "./env";

export function getCookieOptions(_req?: IncomingMessage) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: ENV.isProduction,
    path: "/",
    maxAge: 1000 * 60 * 60 * 24 * 7,
  };
}

export const getSessionCookieOptions = getCookieOptions;
