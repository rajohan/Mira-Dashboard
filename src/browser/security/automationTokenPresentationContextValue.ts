import { createContext, use } from "react";

/** Transient presenter for one server-issued automation access token. */
export interface AutomationTokenPresenter {
    present(ownerUserId: string, token: string): boolean;
}

/** Internal context shared by the application presenter and automation controls. */
export const automationTokenPresentationContext = createContext<
    AutomationTokenPresenter | undefined
>(undefined);

/** @returns The required application-wide one-time automation-token presenter. */
export function useAutomationTokenPresenter(): AutomationTokenPresenter {
    const presenter = use(automationTokenPresentationContext);
    if (presenter === undefined) {
        throw new TypeError("Automation-token presentation provider is unavailable");
    }
    return presenter;
}
