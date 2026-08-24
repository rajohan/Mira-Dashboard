import { eventsRouter } from "../domains/realtime/procedures.ts";
import { accountSecurityRouter } from "../domains/security/mfa/procedures.ts";
import { authRouter } from "../domains/security/procedures.ts";
import { systemRouter } from "../domains/system/procedures.ts";
import { router } from "./trpc.ts";

/** Root tRPC router for the application. */
export const appRouter = router({
    accountSecurity: accountSecurityRouter,
    auth: authRouter,
    events: eventsRouter,
    system: systemRouter,
});

/** Type-only root API contract consumed by TypeScript clients. */
export type AppRouter = typeof appRouter;
