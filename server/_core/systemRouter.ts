import { publicProcedure, router } from "./trpc";

export const systemRouter = router({
  health: publicProcedure.query(() => ({
    ok: true,
    service: "switchos-operator-dashboard",
    timestamp: new Date().toISOString(),
  })),
});
