import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { createQueryWrapper, createTestQueryClient } from "../test/queryClient";
import {
    taskKeys,
    useAssignTask,
    useCreateTask,
    useCreateTaskUpdate,
    useDeleteTask,
    useDeleteTaskUpdate,
    useMoveTask,
    useTasks,
    useTaskUpdates,
    useUpdateTask,
    useUpdateTaskUpdate,
} from "./useTasks";

describe("task hooks", () => {
    it("fetches task lists and enabled task updates", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => [{ number: 1 }],
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => [{ id: 2, messageMd: "done" }],
            });
        vi.stubGlobal("fetch", fetchMock);
        const wrapper = createQueryWrapper();

        const { result: tasks } = renderHook(() => useTasks(), { wrapper });
        await waitFor(() => expect(tasks.current.data?.[0]?.number).toBe(1));

        const { result: updates } = renderHook(() => useTaskUpdates(1), { wrapper });
        await waitFor(() => expect(updates.current.data?.[0]?.id).toBe(2));

        expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/tasks", expect.any(Object));
        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            "/api/tasks/1/updates",
            expect.any(Object)
        );
    });

    it("does not fetch task updates without a task id", () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useTaskUpdates(null), {
            wrapper: createQueryWrapper(),
        });

        expect(result.current.fetchStatus).toBe("idle");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("posts task mutations and invalidates task lists", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ number: 1 }),
        });
        vi.stubGlobal("fetch", fetchMock);
        const queryClient = createTestQueryClient();
        const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
        const wrapper = createQueryWrapper(queryClient);

        const { result: createTask } = renderHook(() => useCreateTask(), { wrapper });
        const { result: updateTask } = renderHook(() => useUpdateTask(), { wrapper });
        const { result: moveTask } = renderHook(() => useMoveTask(), { wrapper });
        const { result: assignTask } = renderHook(() => useAssignTask(), { wrapper });
        const { result: deleteTask } = renderHook(() => useDeleteTask(), { wrapper });

        await act(async () => {
            await createTask.current.mutateAsync({
                title: "T",
                body: "B",
                labels: ["todo"],
                assignee: "mira-2026",
            });
            await updateTask.current.mutateAsync({
                number: 1,
                updates: { title: "New" },
            });
            await moveTask.current.mutateAsync({ number: 1, columnLabel: "done" });
            await assignTask.current.mutateAsync({ number: 1, assignee: "rajohan" });
            await deleteTask.current.mutateAsync({ number: 1 });
        });

        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            "/api/tasks",
            expect.objectContaining({ method: "POST" })
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            "/api/tasks/1",
            expect.objectContaining({ method: "PATCH" })
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            3,
            "/api/tasks/1/move",
            expect.objectContaining({ body: JSON.stringify({ columnLabel: "done" }) })
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            4,
            "/api/tasks/1/assign",
            expect.objectContaining({ body: JSON.stringify({ assignee: "rajohan" }) })
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            5,
            "/api/tasks/1",
            expect.objectContaining({ method: "DELETE" })
        );
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: taskKeys.list() });
    });

    it("posts task update mutations and invalidates update/list queries", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 2 }) });
        vi.stubGlobal("fetch", fetchMock);
        const queryClient = createTestQueryClient();
        const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
        const wrapper = createQueryWrapper(queryClient);

        const { result: createUpdate } = renderHook(() => useCreateTaskUpdate(), {
            wrapper,
        });
        const { result: updateUpdate } = renderHook(() => useUpdateTaskUpdate(), {
            wrapper,
        });
        const { result: deleteUpdate } = renderHook(() => useDeleteTaskUpdate(), {
            wrapper,
        });

        await act(async () => {
            await createUpdate.current.mutateAsync({
                taskId: 1,
                author: "mira-2026",
                messageMd: "hello",
            });
            await updateUpdate.current.mutateAsync({
                taskId: 1,
                updateId: 2,
                author: "rajohan",
                messageMd: "edited",
            });
            await deleteUpdate.current.mutateAsync({ taskId: 1, updateId: 2 });
        });

        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            "/api/tasks/1/updates",
            expect.objectContaining({ method: "POST" })
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            "/api/tasks/1/updates/2",
            expect.objectContaining({ method: "PATCH" })
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            3,
            "/api/tasks/1/updates/2",
            expect.objectContaining({ method: "DELETE" })
        );
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: taskKeys.updates(1) });
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: taskKeys.list() });
    });
});
