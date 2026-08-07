import type { ReactNode } from "react";

import type { DashboardWebAuthnClient } from "./webauthnClient.ts";
import { dashboardWebAuthnContext as DashboardWebAuthnContext } from "./webauthnContextValue.ts";

/** WebAuthn provider dependencies. */
export interface DashboardWebAuthnProviderProps {
    readonly children: ReactNode;
    readonly client: DashboardWebAuthnClient;
}

/**
 * Provides the single browser-owned WebAuthn adapter to security routes.
 * @returns The provider boundary.
 */
export function DashboardWebAuthnProvider({
    children,
    client,
}: DashboardWebAuthnProviderProps) {
    return <DashboardWebAuthnContext value={client}>{children}</DashboardWebAuthnContext>;
}
