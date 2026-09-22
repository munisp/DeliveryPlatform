import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const source = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("consumer account surface", () => {
  it("scopes every consumer procedure to the authenticated caller", () => {
    const router = source("server/_core/consumerRouter.ts");
    expect(router).toContain("export const consumerRouter = router({");
    expect(router).not.toContain("publicProcedure");
    expect(router).not.toContain("workspaceReadProcedure");
    expect(router).not.toContain("protectedProcedure");
    expect(router).not.toContain("operatorMutationProcedure");
    for (const name of [
      "myOrders",
      "myOrderDetail",
      "mySupportCases",
      "openSupportCase",
      "myWallet",
    ]) {
      expect(router).toContain(`${name}: authenticatedProcedure`);
    }
    // every wrapper resolves the caller into the public.users ID space and
    // passes THAT id through — never a raw session/credential id.
    expect(router).toContain(
      'import { resolvePublicUser } from "./publicUsers";',
    );
    expect(router).toContain("const publicUser = await resolvePublicUser(ctx.user)");
    expect(router).toContain("consumerUserId: publicUser.id");
    expect(router).not.toContain("consumerUserId: ctx.user.id");
    // the dispute write path requires an idempotency key
    expect(router).toContain("idempotencyKey: idempotencyKeySchema");
  });

  it("reads only real consumer-scoped tables through the shared pool", () => {
    const queries = source("server/_core/consumerQueries.ts");
    expect(queries).toContain('import { getPool } from "../db";');
    expect(queries).toContain("await getPool()");
    // order reads are pinned to the caller
    expect(queries).toContain("WHERE o.customer_id = $1");
    expect(queries).toContain("WHERE o.id = $1 AND o.customer_id = $2");
    // support cases are pinned to the caller and tied to real orders
    expect(queries).toContain("FROM public.support_tickets st");
    expect(queries).toContain("WHERE st.customer_id = $1");
    // wallet + ledger read real tables
    expect(queries).toContain("FROM public.wallets");
    expect(queries).toContain("WHERE user_id = $1");
    expect(queries).toContain("FROM public.transactions t");
    expect(queries).toContain("FROM public.loyalty_points");
    // mojaloop transfer/refund state joined where relevant
    expect(queries).toContain(
      "LEFT JOIN mojaloop_transfers mt ON mt.transfer_id = t.transaction_id",
    );
    expect(queries).toContain(
      "LEFT JOIN mojaloop_refunds mr ON mr.original_transfer_id = t.transaction_id",
    );
    // no fabricated data
    expect(queries).not.toMatch(/Math\.random/);
    expect(queries).not.toMatch(/catch\s*[{(][^)]*\)\s*{\s*return \[\]/);
  });

  it("opens disputes idempotently against the real support_tickets table", () => {
    const queries = source("server/_core/consumerQueries.ts");
    expect(queries).toContain("export async function openConsumerSupportCase");
    expect(queries).toContain("INSERT INTO public.support_tickets");
    expect(queries).toContain("ON CONFLICT (ticket_number) DO NOTHING");
    // the ticket number is derived deterministically from consumer + key
    expect(queries).toContain('createHash("sha256")');
    expect(queries).toContain("`${input.consumerUserId}:${input.idempotencyKey}`");
    // order linkage is verified against ownership before insert
    expect(queries).toContain("order_not_found_for_consumer");
    expect(queries).toContain(
      "SELECT 1 FROM public.orders WHERE id = $1 AND customer_id = $2 LIMIT 1",
    );
  });

  it("registers the router key and the /account page routes", () => {
    const routers = source("server/routers.ts");
    expect(routers).toContain(
      'import { consumerRouter } from "./_core/consumerRouter";',
    );
    expect(routers).toContain("consumer: consumerRouter,");

    const app = source("client/src/App.tsx");
    expect(app).toContain('import("@/pages/ConsumerOrders")');
    expect(app).toContain('import("@/pages/ConsumerOrderDetail")');
    expect(app).toContain('import("@/pages/ConsumerSupport")');
    expect(app).toContain('import("@/pages/ConsumerWallet")');
    expect(app).toContain(
      '<Route path="/account/orders/:orderId" component={ConsumerOrderDetail} />',
    );
    expect(app).toContain(
      '<Route path="/account/orders" component={ConsumerOrders} />',
    );
    expect(app).toContain(
      '<Route path="/account/support" component={ConsumerSupport} />',
    );
    expect(app).toContain(
      '<Route path="/account/wallet" component={ConsumerWallet} />',
    );
    // entry point where consumers land
    expect(app).toContain('href="/account"');
  });

  it("ships pages wired to the consumer router with honest states", () => {
    const orders = source("client/src/pages/ConsumerOrders.tsx");
    expect(orders).toContain("trpc.consumer.myOrders.useQuery");
    expect(orders).toContain("QueryErrorState");
    expect(orders).toContain("EmptyState");

    const detail = source("client/src/pages/ConsumerOrderDetail.tsx");
    expect(detail).toContain("trpc.consumer.myOrderDetail.useQuery");
    expect(detail).toContain("Timeline");
    expect(detail).toContain("/account/support?orderId=");

    const support = source("client/src/pages/ConsumerSupport.tsx");
    expect(support).toContain("trpc.consumer.mySupportCases.useQuery");
    expect(support).toContain("trpc.consumer.openSupportCase.useMutation");
    expect(support).toContain("idempotencyKey");

    const wallet = source("client/src/pages/ConsumerWallet.tsx");
    expect(wallet).toContain("trpc.consumer.myWallet.useQuery");
    expect(wallet).toContain("QueryErrorState");
    expect(wallet).toContain("EmptyState");

    const layout = source("client/src/components/ConsumerLayout.tsx");
    expect(layout).toContain('href: "/account/orders"');
    expect(layout).toContain('href: "/account/support"');
    expect(layout).toContain('href: "/account/wallet"');

    // no fabricated demo data anywhere in the consumer surface
    for (const page of [orders, detail, support, wallet, layout]) {
      expect(page).not.toMatch(/Math\.random/);
      expect(page).not.toMatch(/lorem/i);
    }
  });
});
