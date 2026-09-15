import { z } from "zod";

import {
  authenticatedProcedure,
  operatorMutationProcedure,
  router,
} from "./trpc";
import { resolvePublicUser } from "./publicUsers";
import {
  activateConsultation,
  addCouncilMember,
  closeConsultation,
  getConsultation,
  listConsultations,
  postConsultation,
  respondToConsultation,
  CONSULTATION_KINDS,
  CONSULTATION_STANCES,
} from "./workerCouncil";

export const councilRouter = router({
  listConsultations: authenticatedProcedure
    .input(
      z
        .object({
          status: z.enum(["open", "closed", "activated", "withdrawn"]).optional(),
        })
        .optional(),
    )
    .query(({ input }) => listConsultations(input)),

  getConsultation: authenticatedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return getConsultation(input.id, publicUser.id);
    }),

  respondToConsultation: authenticatedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        stance: z.enum(CONSULTATION_STANCES),
        body: z.string().trim().min(1).max(10000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const publicUser = await resolvePublicUser(ctx.user);
      return respondToConsultation(publicUser.id, input);
    }),

  postConsultation: operatorMutationProcedure("write_platform")
    .input(
      z.object({
        kind: z.enum(CONSULTATION_KINDS),
        title: z.string().trim().min(3).max(500),
        payload: z.record(z.string(), z.unknown()),
        responseSlaHours: z.number().int().min(1).max(24 * 90),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await resolvePublicUser(ctx.user);
      return postConsultation(actor.id, input);
    }),

  closeConsultation: operatorMutationProcedure("write_platform")
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ input }) => closeConsultation(input)),

  activateConsultation: operatorMutationProcedure("write_platform")
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ input }) => activateConsultation(input)),

  addCouncilMember: operatorMutationProcedure("write_platform")
    .input(
      z.object({
        userId: z.number().int().positive(),
        constituency: z.string().trim().min(1).max(100).optional(),
      }),
    )
    .mutation(({ input }) => addCouncilMember(input)),
});
