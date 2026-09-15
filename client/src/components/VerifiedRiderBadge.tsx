import { BadgeCheck, ShieldAlert } from "lucide-react";

import { useOfferRiderBadge } from "@/lib/trpcTrust";

/**
 * Rider identity assurance pill shown on driver offer cards (R1 — drivers
 * must know whether the passenger on an offer has completed identity
 * verification before accepting).
 */
export default function VerifiedRiderBadge({ offerId }: { offerId: string }) {
  const badge = useOfferRiderBadge(offerId);

  if (badge.isLoading) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 px-3 py-1 text-sm text-slate-400">
        Checking rider…
      </span>
    );
  }

  if (badge.isError || !badge.data) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 px-3 py-1 text-sm text-slate-400"
        title="Rider verification status could not be loaded"
      >
        <ShieldAlert className="h-4 w-4" />
        Rider status unavailable
      </span>
    );
  }

  if (badge.data.verified) {
    const detail = [
      badge.data.firstName ? `Rider: ${badge.data.firstName}` : null,
      badge.data.rating !== null
        ? `Rating: ${badge.data.rating.toFixed(1)}`
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/40 bg-emerald-500/10 px-3 py-1 text-sm text-emerald-200"
        title={detail || "Identity-verified rider"}
      >
        <BadgeCheck className="h-4 w-4" />
        Verified rider
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/40 bg-amber-500/10 px-3 py-1 text-sm text-amber-200"
      title="This rider has not completed identity verification"
    >
      <ShieldAlert className="h-4 w-4" />
      Unverified rider
    </span>
  );
}
