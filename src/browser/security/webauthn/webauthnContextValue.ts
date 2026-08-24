import { createContext, use } from "react";

import type { DashboardWebAuthnClient } from "./webauthnClient.ts";

/** Internal context shared by the WebAuthn provider and typed consumer hook. */
export const dashboardWebAuthnContext = createContext<
    DashboardWebAuthnClient | undefined
>(undefined);

/**
 * Reads the browser-owned WebAuthn ceremony adapter.
 * @returns The configured adapter.
 */
export function useDashboardWebAuthnClient(): DashboardWebAuthnClient {
    const client = use(dashboardWebAuthnContext);
    if (client === undefined) {
        throw new TypeError("Dashboard WebAuthn provider is missing");
    }
    return client;
}
