import { createContext, use } from "react";

import type { SecurityVerificationCoordinator } from "./securityVerificationCoordinator.ts";

/** Internal context shared by the verification provider and enrollment controls. */
export const securityVerificationContext = createContext<
    SecurityVerificationCoordinator | undefined
>(undefined);

/** @returns The application-wide verification coordinator when one is configured. */
export function useSecurityVerificationCoordinator():
    | SecurityVerificationCoordinator
    | undefined {
    return use(securityVerificationContext);
}
