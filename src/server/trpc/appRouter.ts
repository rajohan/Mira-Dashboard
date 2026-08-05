import { eventsRouter } from "../domains/realtime/procedures.ts";
import { systemRouter } from "../domains/system/procedures.ts";
import { router } from "./trpc.ts";

/** Root tRPC router for the application. */
export const appRouter = router({ events: eventsRouter, system: systemRouter });

/** Type-only root API contract consumed by TypeScript clients. */
export type AppRouter = typeof appRouter;
