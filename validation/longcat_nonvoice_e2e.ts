import { IncomingMessage, ServerResponse } from "node:http";

import { Pool } from "pg";

import { appRouter } from "../server/routers";
import { ENV } from "../server/_core/env";

type CallerContext = {
  req: IncomingMessage;
  res: ServerResponse;
  user: {
    id: number;
    name: string;
    email: string;
    role: string;
    scopes: string[];
  };
};

function createOperatorContext(): CallerContext {
  return {
    req: new IncomingMessage(null as never),
    res: new ServerResponse({} as never),
    user: {
      id: 1,
      name: "LongCat Ops",
      email: "ops@switchos.local",
      role: "admin",
      scopes: ["platform:read", "platform:write", "analytics:read", "analytics:write"],
    },
  };
}

async function main() {
  const caller = appRouter.createCaller(createOperatorContext());

  const merchant = await caller.merchantChannels.workspace();
  const dispatch = await caller.driverMobility.summary({ limit: 5 });
  const phone = await caller.phoneOrdering.workspace();
  const memory = await caller.phoneOrdering.customerMemory({
    customerPhone: "+15550002222",
    customerName: "Messaging Validation Customer",
    accessibilityFlags: ["sms-confirmation-preferred"],
  });

  const session = await caller.phoneOrdering.startMessagingSession({
    customerPhone: "+15550002222",
    customerName: "Messaging Validation Customer",
    messageChannel: "sms_ordering",
    accessibilityFlags: ["sms-confirmation-preferred"],
    triggerReason: "non_voice_end_to_end_validation",
    idempotencyKey: `nonvoice-e2e-${Date.now()}`,
  });

  const turn = await caller.phoneOrdering.appendMessagingTurn({
    sessionId: session.session_id,
    speaker: "customer",
    utterance: "Please confirm the quickest reorder option and send me the summary by message.",
    channel: "sms_ordering",
    metadata: {
      allow_callback_dispatch: false,
      source: "non_voice_e2e",
    },
    dispatchReply: true,
  });

  const action = await caller.phoneOrdering.executeAction({
    sessionId: session.session_id,
    customerPhone: "+15550002222",
    customerName: "Messaging Validation Customer",
    merchantName: "Harbor Grill",
    kind: "reservation_booking",
    reason: "Customer requested a dinner reservation confirmation via agentic follow-up.",
    notes: "Reserve a high-priority table near the entrance and confirm by SMS.",
    reservation: {
      partySize: 4,
      requestedAt: "2026-07-10T19:00:00Z",
      location: "Harbor Grill Lagos",
    },
  });

  const pool = new Pool({
    connectionString: ENV.databaseUrl,
    ssl: ENV.databaseUrl.includes("sslmode=require") ? { rejectUnauthorized: false } : false,
  });

  try {
    const dispatchRows = await pool.query(
      `SELECT request_id, dispatch_type, accepted, created_at
       FROM notification_dispatches
       WHERE metadata_json ->> 'sessionId' = $1
       ORDER BY created_at DESC
       LIMIT 5`,
      [session.session_id],
    );

    const actionRows = await pool.query(
      `SELECT action_id, kind, status, booking_reference, execution_summary, created_at
       FROM longcat_action_runs
       WHERE session_id = $1::uuid
       ORDER BY created_at DESC
       LIMIT 5`,
      [session.session_id],
    );

    const result = {
      merchant: {
        summary: merchant.summary,
        benchmarks: (merchant as Record<string, unknown>).benchmarks ?? null,
        longcat: merchant.longcat,
      },
      dispatch: {
        summary: dispatch.summary,
        telemetry: (dispatch as Record<string, unknown>).telemetry ?? null,
        longcat: dispatch.longcat,
      },
      phone: {
        summary: phone.summary,
        messaging_assistant: (phone as Record<string, unknown>).messaging_assistant ?? null,
        longcat: phone.longcat,
      },
      memory,
      messaging_session: session,
      messaging_turn: turn,
      transactional_action: action,
      action_runs: actionRows.rows,
      notification_dispatches: dispatchRows.rows,
    };

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
