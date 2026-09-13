import { ForbiddenError } from "../../shared/_core/errors.js";
import { COOKIE_NAME, ONE_YEAR_MS } from "../../shared/const.js";
import axios, { type AxiosInstance } from "axios";
import { parse as parseCookieHeader } from "cookie";
import type { Request } from "express";
import { SignJWT, jwtVerify } from "jose";
import type { User } from "../../drizzle/schema";
import * as db from "../db";
import { ENV } from "./env";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const AXIOS_TIMEOUT_MS = 10_000;

export type SessionPayload = {
  openId: string;
  appId: string;
  name: string;
};

type OidcTokenResponse = {
  access_token: string;
  token_type?: string;
  expires_in?: number;
};

type OidcUserInfo = {
  sub?: string;
  preferred_username?: string;
  name?: string;
  email?: string;
};

type NormalizedUserInfo = {
  openId: string;
  name: string | null;
  email: string | null;
  loginMethod: string;
  platform: string;
};

class OidcService {
  constructor(private client: AxiosInstance) {
    if (!ENV.oAuthServerUrl || !ENV.oAuthClientId || !ENV.oAuthClientSecret) {
      console.warn("[OAuth] OIDC configuration is incomplete");
    }
  }

  private decodeRedirectUri(state: string): string {
    try {
      const value = Buffer.from(state, "base64url").toString("utf8");
      const redirect = new URL(value);
      if (redirect.protocol !== "https:" && !(redirect.protocol === "http:" && redirect.hostname === "localhost")) {
        throw new Error("redirect_uri_not_allowed");
      }
      return redirect.toString();
    } catch {
      throw new Error("oauth_state_invalid");
    }
  }

  async exchangeCode(code: string, state: string): Promise<OidcTokenResponse> {
    const redirectUri = this.decodeRedirectUri(state);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: ENV.oAuthClientId,
      client_secret: ENV.oAuthClientSecret,
    });
    const { data } = await this.client.post<OidcTokenResponse>(ENV.oAuthTokenPath, body, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    if (!data?.access_token) throw new Error("oidc_token_response_invalid");
    return data;
  }

  async getUserInfo(accessToken: string): Promise<NormalizedUserInfo> {
    const { data } = await this.client.get<OidcUserInfo>(ENV.oAuthUserInfoPath, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const openId = data.sub ?? data.preferred_username;
    if (!isNonEmptyString(openId)) throw new Error("oidc_userinfo_missing_subject");
    return {
      openId,
      name: data.name ?? null,
      email: data.email ?? null,
      loginMethod: "oidc",
      platform: "oidc",
    };
  }
}

const createOidcHttpClient = (): AxiosInstance =>
  axios.create({
    baseURL: ENV.oAuthServerUrl,
    timeout: AXIOS_TIMEOUT_MS,
  });

class SDKServer {
  private readonly client: AxiosInstance;
  private readonly oauthService: OidcService;

  constructor(client: AxiosInstance = createOidcHttpClient()) {
    this.client = client;
    this.oauthService = new OidcService(this.client);
  }

  async exchangeCodeForToken(code: string, state: string): Promise<{ accessToken: string }> {
    const token = await this.oauthService.exchangeCode(code, state);
    return { accessToken: token.access_token };
  }

  async getUserInfo(accessToken: string): Promise<NormalizedUserInfo> {
    return this.oauthService.getUserInfo(accessToken);
  }

  private parseCookies(cookieHeader: string | undefined) {
    if (!cookieHeader) return new Map<string, string>();
    return new Map(Object.entries(parseCookieHeader(cookieHeader)));
  }

  private getSessionSecret() {
    if (!ENV.cookieSecret) throw new Error("jwt_secret_missing");
    return new TextEncoder().encode(ENV.cookieSecret);
  }

  async createSessionToken(
    openId: string,
    options: { expiresInMs?: number; name?: string } = {},
  ): Promise<string> {
    return this.signSession(
      { openId, appId: ENV.appId, name: options.name || "Unknown user" },
      options,
    );
  }

  async signSession(
    payload: SessionPayload,
    options: { expiresInMs?: number } = {},
  ): Promise<string> {
    const issuedAt = Date.now();
    const expirationSeconds = Math.floor((issuedAt + (options.expiresInMs ?? ONE_YEAR_MS)) / 1000);
    return new SignJWT({ openId: payload.openId, appId: payload.appId, name: payload.name })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setExpirationTime(expirationSeconds)
      .sign(this.getSessionSecret());
  }

  async verifySession(cookieValue: string | undefined | null): Promise<SessionPayload | null> {
    if (!cookieValue) return null;
    try {
      const { payload } = await jwtVerify(cookieValue, this.getSessionSecret(), { algorithms: ["HS256"] });
      const { openId, appId, name } = payload as Record<string, unknown>;
      if (!isNonEmptyString(openId) || !isNonEmptyString(appId) || !isNonEmptyString(name)) return null;
      return { openId, appId, name };
    } catch {
      return null;
    }
  }

  async authenticateRequest(req: Request): Promise<AuthenticatedUser> {
    const authHeader = req.headers.authorization || req.headers.Authorization;
    const bearer = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : undefined;
    const cookies = this.parseCookies(req.headers.cookie);
    const session = await this.verifySession(bearer || cookies.get(COOKIE_NAME));
    if (!session) throw ForbiddenError("Invalid session");

    const signedInAt = new Date();
    let user = await db.getUserByOpenId(session.openId);
    if (!user) {
      await db.upsertUser({
        openId: session.openId,
        name: session.name,
        email: null,
        loginMethod: "oidc",
        lastSignedIn: signedInAt,
      });
      user = await db.getUserByOpenId(session.openId);
    }
    if (!user) throw ForbiddenError("User not found");
    await db.upsertUser({ openId: user.openId, lastSignedIn: signedInAt });
    return user;
  }
}

export type AuthenticatedUser = User;
export const sdk = new SDKServer();
