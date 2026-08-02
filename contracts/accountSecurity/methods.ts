import * as v from "valibot";

export const DASHBOARD_AUTH_METHODS = [
    "password",
    "recovery",
    "totp",
    "webauthn",
] as const;
export const DASHBOARD_MFA_METHODS = ["recovery", "totp", "webauthn"] as const;

export const dashboardAuthMethodSchema = v.picklist(DASHBOARD_AUTH_METHODS);
export const dashboardMfaMethodSchema = v.picklist(DASHBOARD_MFA_METHODS);

export type DashboardAuthMethod = v.InferOutput<typeof dashboardAuthMethodSchema>;
export type DashboardMfaMethod = v.InferOutput<typeof dashboardMfaMethodSchema>;
