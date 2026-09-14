import { randomUUID } from "crypto";

import { ENV } from "./env";
import { resilientFetch } from "./resilientFetch";

type NotificationChannel = "sms" | "email" | "push" | "voice";

type DispatchPayload = {
  type: string;
  recipient: {
    phone?: string | null;
    email?: string | null;
    name?: string | null;
    token?: string | null;
  };
  channels: NotificationChannel[];
  metadata?: Record<string, string>;
  payload?: Record<string, unknown>;
};

type DispatchResponse = {
  accepted?: boolean;
  requestId?: string;
  results?: Array<{
    success?: boolean;
    channel?: NotificationChannel;
    messageId?: string;
    provider?: string;
    error?: string;
    renderedBody?: string;
  }>;
  degradedMode?: boolean;
  fallbackUsed?: boolean;
};

export type NotificationDispatchResult = {
  accepted: boolean;
  requestId: string;
  degradedMode: boolean;
  fallbackUsed: boolean;
  results: Array<{
    success: boolean;
    channel: NotificationChannel;
    messageId: string | null;
    provider: string | null;
    error: string | null;
    renderedBody: string | null;
  }>;
};

function buildRequestId(prefix: string) {
  return `${prefix}-${randomUUID()}`;
}

async function dispatchNotification(requestId: string, input: DispatchPayload): Promise<NotificationDispatchResult> {
  if (!ENV.notificationDispatcherUrl) {
    throw new Error("notification_dispatcher_not_configured");
  }

  const response = await resilientFetch(`${ENV.notificationDispatcherUrl.replace(/\/$/, "")}/dispatch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Service-Token": ENV.internalServiceToken,
      "X-Request-Id": requestId,
    },
    body: JSON.stringify({
      type: input.type,
      recipient: {
        phone: input.recipient.phone ?? "",
        email: input.recipient.email ?? "",
        name: input.recipient.name ?? "",
        token: input.recipient.token ?? "",
      },
      channels: input.channels,
      metadata: input.metadata ?? {},
      payload: input.payload ?? {},
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const payload = (await response.json().catch(() => ({}))) as DispatchResponse;
  if (!response.ok) {
    throw new Error(`notification_dispatch_http_${response.status}`);
  }

  return {
    accepted: Boolean(payload.accepted ?? true),
    requestId: payload.requestId ?? requestId,
    degradedMode: Boolean(payload.degradedMode),
    fallbackUsed: Boolean(payload.fallbackUsed),
    results: Array.isArray(payload.results)
      ? payload.results.map((result) => ({
          success: Boolean(result.success),
          channel: (result.channel ?? input.channels[0] ?? "sms") as NotificationChannel,
          messageId: result.messageId ?? null,
          provider: result.provider ?? null,
          error: result.error ?? null,
          renderedBody: result.renderedBody ?? null,
        }))
      : [],
  };
}

export async function sendSMS(phone: string, message: string, metadata?: Record<string, string>) {
  return dispatchNotification(buildRequestId("sms"), {
    type: "generic_sms",
    recipient: { phone },
    channels: ["sms"],
    metadata,
    payload: { message },
  });
}

export async function sendEmail(email: string, subject: string, message: string, metadata?: Record<string, string>) {
  return dispatchNotification(buildRequestId("email"), {
    type: "generic_email",
    recipient: { email },
    channels: ["email"],
    metadata,
    payload: { subject, message },
  });
}

export async function sendPush(token: string, title: string, message: string, metadata?: Record<string, string>) {
  return dispatchNotification(buildRequestId("push"), {
    type: "generic_push",
    recipient: { token },
    channels: ["push"],
    metadata,
    payload: { title, message },
  });
}

export async function sendVoice(phone: string, message: string, metadata?: Record<string, string>) {
  return dispatchNotification(buildRequestId("voice"), {
    type: "generic_voice",
    recipient: { phone },
    channels: ["voice"],
    metadata,
    payload: { message },
  });
}

export async function dispatchLongCatMessage(input: {
  customerPhone: string;
  customerName?: string | null;
  sessionId: string;
  message: string;
  channel?: "sms" | "voice";
  reason?: string;
}) {
  const channel = input.channel ?? "sms";
  return dispatchNotification(buildRequestId(`longcat-${channel}`), {
    type: channel === "voice" ? "longcat_voice_callback" : "longcat_chat_followup",
    recipient: {
      phone: input.customerPhone,
      name: input.customerName ?? "",
    },
    channels: [channel],
    metadata: {
      sessionId: input.sessionId,
      reason: input.reason ?? "longcat_follow_up",
    },
    payload: channel === "voice"
      ? {
          callback_reason: input.reason ?? "longcat_follow_up",
          customer_name: input.customerName ?? "",
        }
      : {
          message: input.message,
          customer_name: input.customerName ?? "",
        },
  });
}
