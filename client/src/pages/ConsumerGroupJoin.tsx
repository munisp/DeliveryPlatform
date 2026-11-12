import { useState } from "react";
import { Link, useParams } from "wouter";
import { Users } from "lucide-react";

import { ConsumerLayout } from "@/components/ConsumerLayout";
import { trpc } from "@/lib/trpc";
import { normalizeGroupOrder } from "@/lib/consumerWire";

const SHARE_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/**
 * /shop/group/:shareCode — join a group order via its 8-character share
 * code (Crockford-ish alphabet, validated client-side before the call).
 *
 * joinGroupOrder is idempotent by construction (UNIQUE(group_id,
 * consumer_id)); a repeat join returns alreadyJoined and is rendered as a
 * friendly state, not an error. Group not found / not open / full are
 * surfaced from the server messages.
 */
export default function ConsumerGroupJoin() {
  const params = useParams<{ shareCode: string }>();
  const shareCode = (params.shareCode ?? "").trim().toUpperCase();
  const validCode = SHARE_CODE_RE.test(shareCode);

  const [joined, setJoined] = useState<ReturnType<
    typeof normalizeGroupOrder
  > | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const join = trpc.consumer.joinGroupOrder.useMutation({
    onSuccess: (result) => {
      setJoined(normalizeGroupOrder(result));
      setErrorMessage(null);
    },
    onError: (error) => setErrorMessage(error.message),
  });

  return (
    <ConsumerLayout
      title="Join a group order"
      description="Split a checkout with friends or colleagues using a shared group code."
    >
      <section className="mx-auto max-w-lg rounded-2xl border border-stone-200 bg-white p-6">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-50 text-amber-700">
            <Users className="h-5 w-5" />
          </span>
          <div>
            <p className="text-sm text-stone-500">Group code</p>
            <p className="font-mono text-lg font-semibold tracking-widest text-stone-900">
              {shareCode || "—"}
            </p>
          </div>
        </div>

        {!validCode ? (
          <p
            className="mt-6 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
            role="alert"
          >
            This link does not contain a valid group code. Ask the host to
            resend the full link.
          </p>
        ) : joined ? (
          <div className="mt-6 space-y-3">
            <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              {joined.alreadyJoined
                ? "You are already a participant in this group order."
                : "You joined the group order."}
            </p>
            <dl className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <dt className="text-stone-500">Status</dt>
                <dd className="font-medium capitalize text-stone-900">
                  {joined.status.replace(/_/g, " ")}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-stone-500">Participants</dt>
                <dd className="font-medium text-stone-900">
                  {joined.participantCount} of {joined.maxParticipants}
                </dd>
              </div>
            </dl>
            <Link href="/shop">
              <span className="mt-2 inline-flex rounded-full bg-amber-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-amber-800">
                Start adding items
              </span>
            </Link>
          </div>
        ) : (
          <div className="mt-6 space-y-4">
            {errorMessage ? (
              <p
                className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
                role="alert"
              >
                {errorMessage}
              </p>
            ) : null}
            <button
              type="button"
              disabled={join.isPending}
              onClick={() => join.mutate({ shareCode })}
              className="w-full rounded-full bg-amber-700 px-5 py-3 text-sm font-medium text-white transition hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {join.isPending ? "Joining…" : "Join this group order"}
            </button>
          </div>
        )}
      </section>
    </ConsumerLayout>
  );
}
