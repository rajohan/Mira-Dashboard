import { authActions } from "../stores/authStore";

export const UNAUTHORIZED_EVENT_NAME = "openclaw:unauthorized";
export const AUTH_SESSION_ROTATED_EVENT_NAME = "openclaw:auth-session-rotated";

/** Clears local authentication and routes the app through its login boundary. */
export function handleUnauthorizedSession(): void {
    authActions.clearSession();
    dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT_NAME));
}

/** Tells long-lived transports to reconnect with the newly rotated session cookie. */
export function notifyAuthSessionRotated(): void {
    dispatchEvent(new Event(AUTH_SESSION_ROTATED_EVENT_NAME));
}
