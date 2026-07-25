import { authActions, authStore } from "../stores/authStore";

export const UNAUTHORIZED_EVENT_NAME = "openclaw:unauthorized";
export const AUTH_SESSION_ROTATED_EVENT_NAME = "openclaw:auth-session-rotated";
export const AUTH_SESSION_ROTATED_STORAGE_KEY = "mira-dashboard:auth-session-rotated";
const AUTH_SESSION_ROTATION_SIGNAL_TTL_MS = 60_000;

/** Identifies one authenticated user and browser session without its validator. */
export interface AuthSessionIdentity {
    sessionId: string;
    userId: number;
}

interface AuthSessionRotationSignal {
    from: AuthSessionIdentity;
    observedAt: number;
    toSessionId?: string;
}

const authBoundaryRuntimeState = {
    isSessionRotationSyncInstalled: false,
    sessionRotationSignal: undefined as AuthSessionRotationSignal | undefined,
    unauthorizedRecoveryPromise: undefined as
        Promise<AuthSessionIdentity | undefined> | undefined,
};

function currentAuthIdentity(): AuthSessionIdentity | undefined {
    const { isAuthenticated, sessionId, user } = authStore.state;
    return isAuthenticated && sessionId && user
        ? { sessionId, userId: user.id }
        : undefined;
}

function isSameAuthIdentity(
    first: AuthSessionIdentity,
    second: AuthSessionIdentity
): boolean {
    return first.userId === second.userId && first.sessionId === second.sessionId;
}

function activeSessionRotationSignal(): AuthSessionRotationSignal | undefined {
    const signal = authBoundaryRuntimeState.sessionRotationSignal;
    if (
        signal &&
        performance.now() - signal.observedAt <= AUTH_SESSION_ROTATION_SIGNAL_TTL_MS
    ) {
        return signal;
    }
    authBoundaryRuntimeState.sessionRotationSignal = undefined;
    return undefined;
}

function dispatchAuthSessionRotated(): void {
    const identity = currentAuthIdentity();
    authBoundaryRuntimeState.sessionRotationSignal = identity
        ? {
              from: identity,
              observedAt: performance.now(),
          }
        : undefined;
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

/** Removes cross-tab synchronization and its pending rotation signal. */
export function uninstallAuthSessionRotationSync(): void {
    if (authBoundaryRuntimeState.isSessionRotationSyncInstalled) {
        removeEventListener("storage", onCrossTabAuthSessionRotated);
        authBoundaryRuntimeState.isSessionRotationSyncInstalled = false;
    }
    authBoundaryRuntimeState.sessionRotationSignal = undefined;
}

/**
 * Returns whether a transition matches the latest short-lived rotation signal.
 * Its first match binds that signal to the exact replacement session.
 */
export function isSignaledAuthSessionRotation(
    previous: AuthSessionIdentity,
    current: AuthSessionIdentity
): boolean {
    if (previous.userId !== current.userId || previous.sessionId === current.sessionId) {
        return false;
    }
    const signal = activeSessionRotationSignal();
    if (!signal || !isSameAuthIdentity(signal.from, previous)) {
        return false;
    }
    if (signal.toSessionId && signal.toSessionId !== current.sessionId) {
        return false;
    }
    if (!signal.toSessionId) {
        authBoundaryRuntimeState.sessionRotationSignal = {
            ...signal,
            toSessionId: current.sessionId,
        };
    }
    return true;
}

/** Clears local authentication and routes the app through its login boundary. */
export function handleUnauthorizedSession(): void {
    authBoundaryRuntimeState.sessionRotationSignal = undefined;
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
    const expectedIdentity = currentAuthIdentity();
    if (!authBoundaryRuntimeState.unauthorizedRecoveryPromise) {
        authBoundaryRuntimeState.unauthorizedRecoveryPromise = (async () => {
            try {
                await authActions.refreshSession();
                return currentAuthIdentity();
            } catch {
                return;
            }
        })();
    }
    const recoveryPromise = authBoundaryRuntimeState.unauthorizedRecoveryPromise;
    try {
        const recoveredIdentity = await recoveryPromise;
        if (expectedIdentity && recoveredIdentity) {
            if (isSameAuthIdentity(expectedIdentity, recoveredIdentity)) {
                return true;
            }
            if (isSignaledAuthSessionRotation(expectedIdentity, recoveredIdentity)) {
                return true;
            }
        }
        if (recoveredIdentity) {
            return false;
        }
        const currentIdentity = currentAuthIdentity();
        if (
            currentIdentity &&
            (!expectedIdentity || !isSameAuthIdentity(expectedIdentity, currentIdentity))
        ) {
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
