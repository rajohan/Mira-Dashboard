import { afterEach, describe, expect, it, vi } from "vitest";

import { authActions, authStore } from "./authStore";

describe("authStore", () => {
    afterEach(() => {
        authStore.setState(() => ({
            user: null,
            isAuthenticated: false,
            isInitialized: false,
            bootstrapRequired: false,
        }));
    });

    it("starts with default state", () => {
        const state = authStore.state;
        expect(state.user).toBe(null);
        expect(state.isAuthenticated).toBe(false);
        expect(state.isInitialized).toBe(false);
        expect(state.bootstrapRequired).toBe(false);
    });

    it("setSession updates state", () => {
        authActions.setSession({
            authenticated: true,
            bootstrapRequired: false,
            user: { id: 1, username: "test" },
        });
        const state = authStore.state;
        expect(state.isAuthenticated).toBe(true);
        expect(state.user?.username).toBe("test");
        expect(state.isInitialized).toBe(true);
    });

    it("setSession with bootstrapRequired", () => {
        authActions.setSession({
            authenticated: false,
            bootstrapRequired: true,
            user: null,
        });
        expect(authStore.state.bootstrapRequired).toBe(true);
    });

    it("clearSession resets to unauthenticated", () => {
        authActions.setSession({
            authenticated: true,
            bootstrapRequired: false,
            user: { id: 1, username: "test" },
        });
        authActions.clearSession();
        expect(authStore.state.isAuthenticated).toBe(false);
        expect(authStore.state.user).toBe(null);
        expect(authStore.state.isInitialized).toBe(true);
    });

    it("refreshSession fetches and sets session", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                authenticated: true,
                bootstrapRequired: false,
                user: { id: 2, username: "mira" },
            }),
        });
        vi.stubGlobal("fetch", fetchMock);

        await authActions.refreshSession();
        expect(authStore.state.isAuthenticated).toBe(true);
        expect(authStore.state.user?.username).toBe("mira");
    });

    it("refreshSession throws on non-ok response", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: false,
        });
        vi.stubGlobal("fetch", fetchMock);

        await expect(authActions.refreshSession()).rejects.toThrow("Failed to fetch auth session");
    });

    it("logout calls API and clears session", async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal("fetch", fetchMock);

        authActions.setSession({
            authenticated: true,
            bootstrapRequired: false,
            user: { id: 1, username: "test" },
        });

        await authActions.logout();
        expect(authStore.state.isAuthenticated).toBe(false);
        expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", expect.objectContaining({ method: "POST" }));
    });

    it("logout handles fetch failure gracefully", async () => {
        const fetchMock = vi.fn().mockRejectedValue(new Error("Network error"));
        vi.stubGlobal("fetch", fetchMock);

        authActions.setSession({
            authenticated: true,
            bootstrapRequired: false,
            user: { id: 1, username: "test" },
        });

        await authActions.logout();
        expect(authStore.state.isAuthenticated).toBe(false);
    });
});
