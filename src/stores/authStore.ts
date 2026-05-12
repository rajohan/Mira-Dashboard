import { Store, useStore } from "@tanstack/react-store";

/** Describes auth user. */
export interface AuthUser {
    id: number;
    username: string;
}

/** Describes auth state. */
interface AuthState {
    user: AuthUser | null;
    isAuthenticated: boolean;
    isInitialized: boolean;
    bootstrapRequired: boolean;
}

/** Describes session response. */
interface SessionResponse {
    authenticated: boolean;
    bootstrapRequired: boolean;
    user: AuthUser | null;
}

/** Describes auth actions. */
interface AuthActions {
    initialize: () => Promise<void>;
    refreshSession: () => Promise<SessionResponse>;
    setSession: (payload: SessionResponse) => void;
    clearSession: () => void;
    logout: () => Promise<void>;
}

const initialState: AuthState = {
    user: null,
    isAuthenticated: false,
    isInitialized: false,
    bootstrapRequired: false,
};

/** Stores auth store. */
export const authStore = new Store<AuthState>(initialState);

let initializePromise: Promise<void> | null = null;

/** Handles fetch session. */
async function fetchSession(): Promise<SessionResponse> {
    const response = await fetch("/api/auth/session", {
        credentials: "include",
    });

    if (!response.ok) {
        throw new Error("Failed to fetch auth session");
    }

    return response.json() as Promise<SessionResponse>;
}

/** Stores auth actions. */
export const authActions: AuthActions = {
    async initialize() {
        if (!initializePromise) {
            initializePromise = authActions
                .refreshSession()
                .catch(() => {
                    authStore.setState(() => ({
                        ...initialState,
                        isInitialized: true,
                    }));
                })
                .then(() => {})
                .finally(() => {
                    initializePromise = null;
                });
        }

        return initializePromise;
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
            bootstrapRequired: payload.bootstrapRequired,
        }));
    },

    clearSession() {
        authStore.setState(() => ({
            ...initialState,
            isInitialized: true,
        }));
    },

    async logout() {
        await fetch("/api/auth/logout", {
            method: "POST",
            credentials: "include",
        }).catch(() => {});
        authActions.clearSession();
    },
};

/** Handles use auth store. */
export function useAuthStore(): AuthState & AuthActions {
    const state = useStore(authStore, (s) => s);
    return {
        ...state,
        ...authActions,
    };
}

/** Handles use auth user. */
export function useAuthUser(): AuthUser | null {
    return useStore(authStore, (state) => state.user);
}

/** Handles use is authenticated. */
export function useIsAuthenticated(): boolean {
    return useStore(authStore, (state) => state.isAuthenticated);
}
