import { createContext, use } from "react";

/** Transient presenter for one server-issued recovery-code set. */
export interface RecoveryCodesPresenter {
    present(ownerUserId: string, codes: readonly string[]): boolean;
}

/** Internal context shared by the application presenter and MFA controls. */
export const recoveryCodesPresentationContext = createContext<
    RecoveryCodesPresenter | undefined
>(undefined);

/** @returns The required application-wide one-time recovery-code presenter. */
export function useRecoveryCodesPresenter(): RecoveryCodesPresenter {
    const presenter = use(recoveryCodesPresentationContext);
    if (presenter === undefined) {
        throw new TypeError("Recovery-code presentation provider is unavailable");
    }
    return presenter;
}
