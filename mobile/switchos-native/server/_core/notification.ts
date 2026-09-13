import { TRPCError } from "@trpc/server";
import { ENV } from "./env";

export type NotificationPayload = {
  title: string;
  content: string;
};

const TITLE_MAX_LENGTH = 1200;
const CONTENT_MAX_LENGTH = 20_000;

function validatePayload(input: NotificationPayload): NotificationPayload {
  const title = input.title?.trim();
  const content = input.content?.trim();
  if (!title) throw new TRPCError({ code: "BAD_REQUEST", message: "Notification title is required." });
  if (!content) throw new TRPCError({ code: "BAD_REQUEST", message: "Notification content is required." });
  if (title.length > TITLE_MAX_LENGTH) throw new TRPCError({ code: "BAD_REQUEST", message: `Notification title must be at most ${TITLE_MAX_LENGTH} characters.` });
  if (content.length > CONTENT_MAX_LENGTH) throw new TRPCError({ code: "BAD_REQUEST", message: `Notification content must be at most ${CONTENT_MAX_LENGTH} characters.` });
  return { title, content };
}

/**
 * Dispatches to an explicitly configured self-hosted notification webhook.
 * Callers receive `false` for unavailable transport and may use their own email,
 * SMS, or chat fallback; no owner data is sent to a platform-managed service.
 */
export async function notifyOwner(payload: NotificationPayload): Promise<boolean> {
  const notification = validatePayload(payload);
  if (!ENV.notificationWebhookUrl || !ENV.notificationWebhookToken) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Notification webhook is not configured." });
  }

  try {
    const response = await fetch(ENV.notificationWebhookUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${ENV.notificationWebhookToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(notification),
    });
    if (!response.ok) {
      console.warn("[Notification] webhook delivery failed", { status: response.status });
      return false;
    }
    return true;
  } catch (error) {
    console.warn("[Notification] webhook transport failed", { error });
    return false;
  }
}
