import { getPool } from "../db";
import { sendEmail } from "./notificationGateway";

/**
 * supportNotifications.ts — consumer notification hooks for the support
 * agent surface (P3-S / WS-SUPPORT).
 *
 * public.notifications has ZERO writers on main (recon §WS-SUPPORT). This
 * module is the first: every support lifecycle event inserts one in-app
 * notification row (user_id = ticket customer, type 'system', metadata
 * { supportTicketId, kind }) and then sends a fail-open email through the
 * notification dispatcher, exactly per the merchantCommerce.ts pattern
 * (notification is attempted AFTER the row write, and a dispatcher failure
 * is logged and swallowed — it NEVER blocks or fails the mutation).
 *
 * NOTHING here throws: all entry points catch everything and log, so a
 * notification outage can never break support mutations or queue reads.
 *
 * DESIGN NOTE (P3_SPEC §WS-SUPPORT): the consumer-opened ticket paths
 * (consumerQueries.openConsumerSupportCase, powersyncUpload) are NOT
 * editable in this wave and fire no notification hook. Resolution: the
 * agent queue read (supportAgent.listTicketQueue) lazily calls
 * notifyUnnotifiedOpenTickets() for the open tickets on the page being
 * listed; any open ticket with no 'opened' notification row gets one
 * (INSERT-first dedupe on metadata->>'supportTicketId'/'kind' keeps it
 * once-only even under concurrent queue reads). This is deliberate and
 * documented; when those writers become editable the same
 * notifySupportEvent({ kind: "opened" }) hook can be called inline.
 */

export type SupportNotificationKind = "opened" | "assigned" | "resolved" | "closed";

const KIND_TITLES: Record<SupportNotificationKind, string> = {
  opened: "Support case opened",
  assigned: "Support case assigned",
  resolved: "Support case resolved",
  closed: "Support case closed",
};

function kindMessage(
  kind: SupportNotificationKind,
  ticketNumber: string,
  subject: string,
): string {
  switch (kind) {
    case "opened":
      return `We've opened support case ${ticketNumber} for "${subject}". Our team will follow up here.`;
    case "assigned":
      return `Support case ${ticketNumber} ("${subject}") has been assigned to an agent.`;
    case "resolved":
      return `Support case ${ticketNumber} ("${subject}") has been resolved. Reply in the app if anything is still wrong.`;
    case "closed":
      return `Support case ${ticketNumber} ("${subject}") is now closed.`;
  }
}

interface TicketContactRow {
  id: number;
  ticket_number: string;
  subject: string;
  customer_id: number | null;
  customer_email: string | null;
}

/**
 * Insert the in-app notification for a support lifecycle event and then
 * fail-open email the customer. Never throws.
 */
export async function notifySupportEvent(input: {
  kind: SupportNotificationKind;
  ticketId: number;
}): Promise<void> {
  try {
    const pool = await getPool();
    const ticketResult = await pool.query(
      `SELECT st.id, st.ticket_number, st.subject, st.customer_id,
              u.email AS customer_email
       FROM public.support_tickets st
       LEFT JOIN public.users u ON u.id = st.customer_id
       WHERE st.id = $1
       LIMIT 1`,
      [input.ticketId],
    );
    const ticket = ticketResult.rows[0] as TicketContactRow | undefined;
    if (!ticket || ticket.customer_id === null) return;

    const title = KIND_TITLES[input.kind];
    const message = kindMessage(input.kind, ticket.ticket_number, ticket.subject);
    // metadata carries the dedupe/lookup keys used by the lazy
    // consumer-opened path below (supportTicketId + kind).
    const metadata = {
      supportTicketId: String(ticket.id),
      ticketNumber: ticket.ticket_number,
      kind: input.kind,
    };
    await pool.query(
      `INSERT INTO public.notifications (user_id, type, title, message, priority, metadata)
       VALUES ($1, 'system', $2, $3, 'medium', $4::json)`,
      [ticket.customer_id, title, message, JSON.stringify(metadata)],
    );

    // Fail-open email (merchantCommerce pattern): dispatcher errors are
    // logged and swallowed — never propagated to the caller.
    if (ticket.customer_email) {
      try {
        await sendEmail(ticket.customer_email, title, message, metadata);
      } catch (error) {
        console.warn(
          `[support-notifications] email dispatch failed for ticket ${ticket.ticket_number}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  } catch (error) {
    console.warn(
      `[support-notifications] notify (${input.kind}) failed for ticket ${input.ticketId}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * DESIGN NOTE lazy path: given open ticket ids from an agent queue page,
 * insert the missing 'opened' notifications for consumer-opened tickets
 * (whose writers cannot be edited this wave). Once-only per ticket: the
 * existence check on metadata->>'supportTicketId'/'kind' gates the insert.
 * Never throws; safe to call from a read path.
 */
export async function notifyUnnotifiedOpenTickets(ticketIds: number[]): Promise<void> {
  if (ticketIds.length === 0) return;
  try {
    const pool = await getPool();
    const existing = await pool.query(
      `SELECT DISTINCT (metadata->>'supportTicketId') AS ticket_id
       FROM public.notifications
       WHERE type = 'system'
         AND metadata->>'kind' = 'opened'
         AND (metadata->>'supportTicketId') = ANY($1::text[])`,
      [ticketIds.map(String)],
    );
    const notified = new Set(
      existing.rows.map((row: { ticket_id: string }) => String(row.ticket_id)),
    );
    for (const ticketId of ticketIds) {
      if (!notified.has(String(ticketId))) {
        await notifySupportEvent({ kind: "opened", ticketId });
      }
    }
  } catch (error) {
    console.warn(
      "[support-notifications] lazy opened-notification sweep failed:",
      error instanceof Error ? error.message : error,
    );
  }
}
