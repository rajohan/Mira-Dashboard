import { Store, useStore } from "@tanstack/react-store";

interface AuthState {
    token: string | null;
    isAuthenticated: boolean;
}

interface AuthActions {
    login: (token: string) => void;
    logout: () => void;
}

// Load initial state from localStorage
const getInitialState = (): AuthState => {
    if (typeof window === "undefined") {
        return { token: null, isAuthenticated: false };
    }
    const token = localStorage.getItem("openclaw_token");
    return {
        token,
        isAuthenticated: !!token,
    };
};

// Create the store
export const authStore = new Store<AuthState>(getInitialState());

// Actions
export const authActions: AuthActions = {
    login: (token: string) => {
        localStorage.setItem("openclaw_token", token);
        authStore.setState(() => ({
            token,
            isAuthenticated: true,
        }));
    },
    logout: () => {
        localStorage.removeItem("openclaw_token");
        authStore.setState(() => ({
            token: null,
            isAuthenticated: false,
        }));
    },
};

// Hook for reading auth state with actions
export function useAuthStore(): AuthState & AuthActions {
    const state = useStore(authStore, (s) => s);
    return {
        ...state,
        ...authActions,
    };
}

// Hook for just the token (optimized - won't re-render on isAuthenticated change)
export function useAuthToken(): string | null {
    return useStore(authStore, (state) => state.token);
}

// Hook for just the auth status
export function useIsAuthenticated(): boolean {
    return useStore(authStore, (state) => state.isAuthenticated);
}
