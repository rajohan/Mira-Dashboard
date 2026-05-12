import { Store, useStore } from "@tanstack/react-store";

/** Represents auth user. */
export interface AuthUser {
    id: number;
    username: string;
}

/** Represents auth state. */
interface AuthState {
    user: AuthUser | null;
    isAuthenticated: boolean;
    isInitialized: boolean;
    bootstrapRequired: boolean;
}

/** Represents the session API response. */
interface SessionResponse {
    authenticated: boolean;
    bootstrapRequired: boolean;
    user: AuthUser | null;
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
    user: null,
    isAuthenticated: false,
    isInitialized: false,
    bootstrapRequired: false,
};

/** Defines auth store. */
export const authStore = new Store<AuthState>(initialState);

let initializePromise: Promise<void> | null = null;

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

/** Provides auth store. */
export function useAuthStore(): AuthState & AuthActions {
    const state = useStore(authStore, (s) => s);
    return {
        ...state,
        ...authActions,
    };
}

/** Provides auth user. */
export function useAuthUser(): AuthUser | null {
    return useStore(authStore, (state) => state.user);
}

/** Provides is authenticated. */
export function useIsAuthenticated(): boolean {
    return useStore(authStore, (state) => state.isAuthenticated);
}
