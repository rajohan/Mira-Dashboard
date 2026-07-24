import { authActions } from "../stores/authStore";

export const UNAUTHORIZED_EVENT_NAME = "openclaw:unauthorized";

/** Clears local authentication and routes the app through its login boundary. */
export function handleUnauthorizedSession(): void {
    authActions.clearSession();
    dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT_NAME));
}
