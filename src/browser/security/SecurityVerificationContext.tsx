import type { ReactNode } from "react";

import { securityVerificationContext as SecurityVerificationContext } from "./securityVerificationContextValue.ts";
import type { SecurityVerificationCoordinator } from "./securityVerificationCoordinator.ts";

interface SecurityVerificationProviderProps {
    readonly children: ReactNode;
    readonly coordinator: SecurityVerificationCoordinator | undefined;
}

/** @returns The provider for payload-free application-wide security verification. */
export function SecurityVerificationProvider({
    children,
    coordinator,
}: SecurityVerificationProviderProps) {
    return (
        <SecurityVerificationContext value={coordinator}>
            {children}
        </SecurityVerificationContext>
    );
}
