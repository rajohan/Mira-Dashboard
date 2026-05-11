import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { createQueryWrapper, createTestQueryClient } from "../test/queryClient";
import {
    configKeys,
    useConfig,
    useCreateBackup,
    useRestartGateway,
    useSkills,
    useToggleSkill,
    useUpdateConfig,
} from "./useConfig";

describe("config hooks", () => {
    it("fetches config and skills", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    agents: { defaults: { model: { primary: "codex" } } },
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    skills: [{ name: "weather", path: "/s/weather", enabled: true }],
                }),
            });
        vi.stubGlobal("fetch", fetchMock);
        const wrapper = createQueryWrapper();

        const { result: cfg } = renderHook(() => useConfig(), { wrapper });
        await waitFor(() =>
            expect(cfg.current.data?.agents?.defaults?.model?.primary).toBe("codex")
        );

        const { result: skills } = renderHook(() => useSkills(), { wrapper });
        await waitFor(() => expect(skills.current.data?.[0]?.name).toBe("weather"));
    });

    it("updates config and invalidates", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
        vi.stubGlobal("fetch", fetchMock);
        const queryClient = createTestQueryClient();
        const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
        const wrapper = createQueryWrapper(queryClient);

        const { result } = renderHook(() => useUpdateConfig(), { wrapper });
        await act(async () => {
            await result.current.mutateAsync({ agents: { defaults: {} } });
        });

        expect(fetchMock).toHaveBeenCalledWith(
            "/api/config",
            expect.objectContaining({ method: "PUT" })
        );
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: configKeys.config() });
    });

    it("toggles skill and restarts gateway", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
        vi.stubGlobal("fetch", fetchMock);
        const queryClient = createTestQueryClient();
        const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
        const wrapper = createQueryWrapper(queryClient);

        const { result: toggle } = renderHook(() => useToggleSkill(), { wrapper });
        await act(async () => {
            await toggle.current.mutateAsync({ name: "weather", enabled: false });
        });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/skills/weather",
            expect.objectContaining({ method: "POST" })
        );
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: configKeys.skills() });

        const { result: restart } = renderHook(() => useRestartGateway(), { wrapper });
        await act(async () => {
            await restart.current.mutateAsync();
        });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/restart",
            expect.objectContaining({ method: "POST" })
        );

        const { result: backup } = renderHook(() => useCreateBackup(), { wrapper });
        await act(async () => {
            await backup.current.mutateAsync();
        });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/backup",
            expect.objectContaining({ method: "POST" })
        );
    });
});
