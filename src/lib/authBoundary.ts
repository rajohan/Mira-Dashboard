import { authActions, authStore } from "../stores/authStore";

export const UNAUTHORIZED_EVENT_NAME = "openclaw:unauthorized";
export const AUTH_SESSION_ROTATED_EVENT_NAME = "openclaw:auth-session-rotated";
export const AUTH_SESSION_ROTATED_STORAGE_KEY = "mira-dashboard:auth-session-rotated";

const authBoundaryRuntimeState = {
    isSessionRotationSyncInstalled: false,
    unauthorizedRecoveryPromise: undefined as Promise<number | undefined> | undefined,
};

function dispatchAuthSessionRotated(): void {
    dispatchEvent(new Event(AUTH_SESSION_ROTATED_EVENT_NAME));
}

function onCrossTabAuthSessionRotated(event: StorageEvent): void {
    if (event.key !== AUTH_SESSION_ROTATED_STORAGE_KEY || event.newValue === null) {
        return;
    }
    dispatchAuthSessionRotated();
    void authActions
        .refreshSession()
        .then(() => {
            if (!authStore.state.isAuthenticated) {
                handleUnauthorizedSession();
            }
        })
        .catch(() => {
            // A transient refresh failure must not clear a valid shared browser session.
        });
}

/** Installs same-origin cross-tab synchronization for rotated Dashboard sessions. */
export function installAuthSessionRotationSync(): void {
    if (authBoundaryRuntimeState.isSessionRotationSyncInstalled) {
        return;
    }
    addEventListener("storage", onCrossTabAuthSessionRotated);
    authBoundaryRuntimeState.isSessionRotationSyncInstalled = true;
}

/** Removes cross-tab synchronization so isolated runtimes can release the listener. */
export function uninstallAuthSessionRotationSync(): void {
    if (!authBoundaryRuntimeState.isSessionRotationSyncInstalled) {
        return;
    }
    removeEventListener("storage", onCrossTabAuthSessionRotated);
    authBoundaryRuntimeState.isSessionRotationSyncInstalled = false;
}

/** Clears local authentication and routes the app through its login boundary. */
export function handleUnauthorizedSession(): void {
    authActions.clearSession();
    dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT_NAME));
}

/**
 * Confirms the browser's current cookie before treating a transport rejection
 * as logout. A concurrent step-up may have invalidated only the request's old
 * cookie while already installing a valid same-user rotated cookie. A different
 * authenticated user remains signed in, but the old user's action is not resumed.
 */
export async function recoverOrHandleUnauthorizedSession(): Promise<boolean> {
    const expectedUserId = authStore.state.user?.id;
    if (!authBoundaryRuntimeState.unauthorizedRecoveryPromise) {
        authBoundaryRuntimeState.unauthorizedRecoveryPromise = (async () => {
            try {
                await authActions.refreshSession();
                return authStore.state.isAuthenticated
                    ? authStore.state.user?.id
                    : undefined;
            } catch {
                return;
            }
        })();
    }
    const recoveryPromise = authBoundaryRuntimeState.unauthorizedRecoveryPromise;
    try {
        const recoveredUserId = await recoveryPromise;
        if (expectedUserId !== undefined && recoveredUserId === expectedUserId) {
            return true;
        }
        if (recoveredUserId !== undefined) {
            return false;
        }
        handleUnauthorizedSession();
        return false;
    } finally {
        if (authBoundaryRuntimeState.unauthorizedRecoveryPromise === recoveryPromise) {
            authBoundaryRuntimeState.unauthorizedRecoveryPromise = undefined;
        }
    }
}

/** Tells long-lived transports to reconnect with the newly rotated session cookie. */
export function notifyAuthSessionRotated(): void {
    dispatchAuthSessionRotated();
    try {
        localStorage.setItem(AUTH_SESSION_ROTATED_STORAGE_KEY, crypto.randomUUID());
    } catch {
        // Local reconnect still works when browser storage is unavailable.
    }
}
