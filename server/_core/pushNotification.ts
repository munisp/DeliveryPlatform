import { resilientFetch } from "./resilientFetch";

type PushPayload = {
  title: string;
  body: string;
  data?: Record<string, unknown>;
};

type PushAttemptResult = {
  token: string;
  success: boolean;
  status?: number;
  error?: string;
};

type PushBatchResult = {
  successCount: number;
  failureCount: number;
  results: PushAttemptResult[];
};

function configuredGatewayUrl() {
  return process.env.PUSH_GATEWAY_URL?.trim() || process.env.EXPO_PUSH_GATEWAY_URL?.trim() || "";
}

function configuredGatewayAuthHeader() {
  const token = process.env.PUSH_GATEWAY_AUTH_TOKEN?.trim() || process.env.EXPO_ACCESS_TOKEN?.trim() || "";
  if (!token) {
    return null;
  }
  return `Bearer ${token}`;
}

async function deliverViaGateway(
  gatewayUrl: string,
  authHeader: string | null,
  token: string,
  payload: PushPayload,
): Promise<PushAttemptResult> {
  const response = await resilientFetch(gatewayUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authHeader ? { Authorization: authHeader } : {}),
    },
    body: JSON.stringify({
      to: token,
      title: payload.title,
      body: payload.body,
      data: payload.data ?? {},
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      token,
      success: false,
      status: response.status,
      error: text || `Gateway returned status ${response.status}`,
    };
  }

  return {
    token,
    success: true,
    status: response.status,
  };
}

export async function sendPushNotificationToMultiple(
  deviceTokens: string[],
  payload: PushPayload,
): Promise<PushBatchResult> {
  const uniqueTokens = Array.from(new Set((deviceTokens || []).map((token) => `${token}`.trim()).filter(Boolean)));
  if (uniqueTokens.length === 0) {
    return {
      successCount: 0,
      failureCount: 0,
      results: [],
    };
  }

  const gatewayUrl = configuredGatewayUrl();
  const authHeader = configuredGatewayAuthHeader();
  if (!gatewayUrl) {
    return {
      successCount: 0,
      failureCount: uniqueTokens.length,
      results: uniqueTokens.map((token) => ({
        token,
        success: false,
        error: "Push gateway is not configured. Set PUSH_GATEWAY_URL or EXPO_PUSH_GATEWAY_URL.",
      })),
    };
  }

  const results = await Promise.all(
    uniqueTokens.map(async (token) => {
      try {
        return await deliverViaGateway(gatewayUrl, authHeader, token, payload);
      } catch (error) {
        return {
          token,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies PushAttemptResult;
      }
    }),
  );

  const successCount = results.filter((result) => result.success).length;
  return {
    successCount,
    failureCount: results.length - successCount,
    results,
  };
}
