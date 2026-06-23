import { Store, useSelector } from "@tanstack/react-store";

/** Represents auth user. */
export interface AuthUser {
    id: number;
    username: string;
}

/** Represents auth state. */
interface AuthState {
    user: AuthUser | undefined;
    isAuthenticated: boolean;
    isInitialized: boolean;
    isBootstrapRequired: boolean;
}

/** Represents the session API response. */
interface SessionResponse {
    authenticated: boolean;
    isBootstrapRequired: boolean;
    user: AuthUser | undefined;
}

/** Represents auth actions. */
interface AuthActions {
    initialize: () => Promise<void>;
    refreshSession: () => Promise<SessionResponse>;
    setSession: (payload: SessionResponse) => void;
    clearSession: () => void;
    logout: () => Promise<void>;
}

const initialState: AuthState = {
    user: undefined,
    isAuthenticated: false,
    isInitialized: false,
    isBootstrapRequired: false,
};

/** Defines auth store. */
export const authStore = new Store<AuthState>(initialState);

const authRuntimeState: { initializePromise: Promise<void> | undefined } = {
    initializePromise: undefined,
};

/** Fetches session. */
async function fetchSession(): Promise<SessionResponse> {
    const response = await fetch("/api/auth/session", {
        credentials: "include",
    });

    if (!response.ok) {
        throw new Error("Failed to fetch auth session");
    }

    return response.json() as Promise<SessionResponse>;
}

/** Defines auth actions. */
export const authActions: AuthActions = {
    async initialize() {
        if (!authRuntimeState.initializePromise) {
            authRuntimeState.initializePromise = (async () => {
                try {
                    await authActions.refreshSession();
                } catch {
                    authStore.setState(() => ({
                        ...initialState,
                        isInitialized: true,
                    }));
                } finally {
                    authRuntimeState.initializePromise = undefined;
                }
            })();
        }

        return authRuntimeState.initializePromise;
    },

    async refreshSession() {
        const session = await fetchSession();
        authActions.setSession(session);
        return session;
    },

    setSession(payload) {
        authStore.setState(() => ({
            user: payload.user,
            isAuthenticated: payload.authenticated,
            isInitialized: true,
            isBootstrapRequired: payload.isBootstrapRequired,
        }));
    },

    clearSession() {
        authStore.setState(() => ({
            ...initialState,
            isInitialized: true,
        }));
    },

    async logout() {
        try {
            await fetch("/api/auth/logout", {
                method: "POST",
                credentials: "include",
            });
        } catch {
            // Clear local auth state even if the logout request fails.
        }
        authActions.clearSession();
    },
};

/** Provides auth store. */
export function useAuthStore(): AuthState & AuthActions {
    const state = useSelector(authStore, (s) => s);
    return {
        ...state,
        ...authActions,
    };
}

/** Provides auth user. */
export function useAuthUser(): AuthUser | undefined {
    return useSelector(authStore, (state) => state.user);
}
