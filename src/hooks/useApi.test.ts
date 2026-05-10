import { describe, expect, it, vi } from "vitest";

import { authStore } from "../stores/authStore";
import { apiDelete, apiFetch, apiPost, apiPut, UnauthorizedError } from "./useApi";

function mockFetch(response: Partial<Response> & { json?: () => Promise<unknown> }) {
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}

describe("apiFetch", () => {
    it("sends JSON requests with credentials", async () => {
        const fetchMock = mockFetch({
            ok: true,
            status: 200,
            json: async () => ({ ok: true }),
        });

        await expect(apiPost("/tasks", { title: "Test" })).resolves.toEqual({ ok: true });
        await apiPut("/tasks/1", { title: "Updated" });
        await apiDelete("/tasks/1");

        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            "/api/tasks",
            expect.objectContaining({
                method: "POST",
                credentials: "include",
                body: JSON.stringify({ title: "Test" }),
                headers: expect.objectContaining({ "Content-Type": "application/json" }),
            })
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            "/api/tasks/1",
            expect.objectContaining({ method: "PUT" })
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            3,
            "/api/tasks/1",
            expect.objectContaining({ method: "DELETE" })
        );
    });

    it("throws API error messages", async () => {
        mockFetch({
            ok: false,
            status: 500,
            json: async () => ({ error: "Broken" }),
        });

        await expect(apiFetch("/broken")).rejects.toThrow("Broken");
    });

    it("falls back to HTTP status when error response has no message", async () => {
        mockFetch({
            ok: false,
            status: 418,
            json: async () => ({}),
        });

        await expect(apiFetch("/teapot")).rejects.toThrow("HTTP 418");
    });

    it("falls back to unknown error when error JSON parsing fails", async () => {
        mockFetch({
            ok: false,
            status: 500,
            json: async () => {
                throw new Error("bad json");
            },
        });

        await expect(apiFetch("/broken-json")).rejects.toThrow("Unknown error");
    });

    it("clears auth and dispatches event on unauthorized", async () => {
        authStore.setState(() => ({
            user: { id: 1, username: "mira" },
            isAuthenticated: true,
            isInitialized: true,
            bootstrapRequired: false,
        }));
        const listener = vi.fn();
        window.addEventListener("openclaw:unauthorized", listener);
        mockFetch({ ok: false, status: 401, json: async () => ({}) });

        await expect(apiFetch("/private")).rejects.toBeInstanceOf(UnauthorizedError);

        expect(authStore.state.isAuthenticated).toBe(false);
        expect(listener).toHaveBeenCalledTimes(1);
        window.removeEventListener("openclaw:unauthorized", listener);
    });
});
