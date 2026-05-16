import { renderHook } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { createQueryWrapper, createTestQueryClient } from "../test/queryClient";
import { sessionKeys, useDeleteSession, useSessionAction } from "./useSessions";

vi.mock("../collections/sessions", () => ({
    deleteSessionFromCollection: vi.fn(),
}));

const { deleteSessionFromCollection } = await import("../collections/sessions");

describe("session hooks", () => {
    it("exposes session list query key", () => {
        const queryClient = createTestQueryClient();
        queryClient.setQueryData(sessionKeys.all, ["cached"]);
        expect(queryClient.getQueryData(sessionKeys.all)).toEqual(["cached"]);
    });

    it("posts session actions", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ ok: true }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useSessionAction(), {
            wrapper: createQueryWrapper(),
        });

        await act(async () => {
            await result.current.mutateAsync({ key: "session:key", action: "compact" });
        });

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/sessions/session%3Akey/action",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({ action: "compact" }),
            })
        );
    });

    it("deletes sessions and updates the collection", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useDeleteSession(), {
            wrapper: createQueryWrapper(),
        });

        await act(async () => {
            await result.current.mutateAsync("session:key");
        });

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/sessions/session%3Akey",
            expect.objectContaining({ method: "DELETE" })
        );
        expect(deleteSessionFromCollection).toHaveBeenCalledWith("session:key");
    });
});
