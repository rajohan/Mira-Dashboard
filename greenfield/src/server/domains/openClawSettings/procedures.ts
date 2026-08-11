import { router } from "../../trpc/trpc.ts";
import { openClawSettingsRoutes } from "./routes.ts";

/** Leaf procedure names owned by the bounded OpenClaw Settings router. */
export const openClawSettingsProcedureNames = Object.freeze(
    Object.keys(openClawSettingsRoutes)
);

/** Session-only settings queries and recent-MFA exact controls. */
export const openClawSettingsRouter = router(openClawSettingsRoutes);
