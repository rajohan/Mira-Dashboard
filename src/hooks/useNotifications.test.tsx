import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { createQueryWrapper, createTestQueryClient } from "../test/queryClient";
import {
    useClearReadNotifications,
    useCreateNotification,
    useDeleteNotification,
    useMarkAllNotificationsRead,
    useMarkNotificationRead,
    useNotifications,
} from "./useNotifications";

describe("notification hooks", () => {
    it("fetches notifications", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                items: [{ id: 1, title: "Test", isRead: false }],
                unreadCount: 1,
            }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useNotifications(), {
            wrapper: createQueryWrapper(),
        });
        await waitFor(() => expect(result.current.data?.unreadCount).toBe(1));
    });

    it("mutation hooks invalidate notifications", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ ok: true }),
        });
        vi.stubGlobal("fetch", fetchMock);
        const queryClient = createTestQueryClient();
        const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
        const wrapper = createQueryWrapper(queryClient);

        const { result: create } = renderHook(() => useCreateNotification(), { wrapper });
        await act(async () => {
            await create.current.mutateAsync({ title: "t", description: "d" });
        });
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["notifications"] });

        const { result: markRead } = renderHook(() => useMarkNotificationRead(), {
            wrapper,
        });
        await act(async () => {
            await markRead.current.mutateAsync(1);
        });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/notifications/1/read",
            expect.objectContaining({ method: "POST" })
        );

        const { result: markAll } = renderHook(() => useMarkAllNotificationsRead(), {
            wrapper,
        });
        await act(async () => {
            await markAll.current.mutateAsync();
        });

        const { result: clearRead } = renderHook(() => useClearReadNotifications(), {
            wrapper,
        });
        await act(async () => {
            await clearRead.current.mutateAsync();
        });

        const { result: del } = renderHook(() => useDeleteNotification(), { wrapper });
        await act(async () => {
            await del.current.mutateAsync(5);
        });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/notifications/5",
            expect.objectContaining({ method: "DELETE" })
        );
    });
});
