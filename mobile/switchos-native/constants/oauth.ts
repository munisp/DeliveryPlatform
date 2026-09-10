import * as Linking from "expo-linking";
import * as ReactNative from "react-native";

const env = {
  authorizationUrl: process.env.EXPO_PUBLIC_OAUTH_AUTHORIZATION_URL ?? "",
  clientId: process.env.EXPO_PUBLIC_OAUTH_CLIENT_ID ?? "",
  scope: process.env.EXPO_PUBLIC_OAUTH_SCOPE ?? "openid profile email",
  apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL ?? "",
  deepLinkScheme: process.env.EXPO_PUBLIC_SWITCHOS_URL_SCHEME ?? "switchos",
};

export const OAUTH_AUTHORIZATION_URL = env.authorizationUrl;
export const OAUTH_CLIENT_ID = env.clientId;
export const API_BASE_URL = env.apiBaseUrl;

export function getApiBaseUrl(): string {
  if (API_BASE_URL) return API_BASE_URL.replace(/\/$/, "");
  if (ReactNative.Platform.OS === "web" && typeof window !== "undefined") return window.location.origin;
  return "";
}

export const SESSION_TOKEN_KEY = "switchos_session_token";
export const USER_INFO_KEY = "switchos_oidc_user_info";

const encodeState = (value: string) => {
  if (typeof globalThis.btoa === "function") return globalThis.btoa(value);
  type BufferLike = { from: (input: string, encoding: string) => { toString: (encoding: string) => string } };
  const BufferImpl = (globalThis as unknown as { Buffer?: BufferLike }).Buffer;
  return BufferImpl ? BufferImpl.from(value, "utf-8").toString("base64url") : value;
};

export const getRedirectUri = () => {
  if (ReactNative.Platform.OS === "web") return `${getApiBaseUrl()}/api/oauth/callback`;
  return Linking.createURL("/oauth/callback", { scheme: env.deepLinkScheme });
};

export const getLoginUrl = () => {
  if (!OAUTH_AUTHORIZATION_URL || !OAUTH_CLIENT_ID) {
    throw new Error("OIDC authorization URL and client ID are required");
  }
  const redirectUri = getRedirectUri();
  const url = new URL(OAUTH_AUTHORIZATION_URL);
  url.searchParams.set("client_id", OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", env.scope);
  url.searchParams.set("state", encodeState(redirectUri));
  return url.toString();
};

export async function startOAuthLogin(): Promise<string | null> {
  const loginUrl = getLoginUrl();
  if (ReactNative.Platform.OS === "web") {
    if (typeof window !== "undefined") window.location.assign(loginUrl);
    return null;
  }
  if (!(await Linking.canOpenURL(loginUrl))) {
    console.warn("[OIDC] Authorization URL cannot be opened");
    return null;
  }
  try {
    await Linking.openURL(loginUrl);
  } catch (error) {
    console.error("[OIDC] Authorization launch failed", { error });
  }
  return null;
}
