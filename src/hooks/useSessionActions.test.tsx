import { renderHook, waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { createQueryWrapper } from "../test/queryClient";
import { useSessionActions } from "./useSessionActions";

describe("useSessionActions", () => {
    it("exposes convenience actions for session mutations", async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ ok: true }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useSessionActions(), {
            wrapper: createQueryWrapper(),
        });

        act(() => {
            result.current.stop("session:key");
            result.current.compact("session:key");
            result.current.reset("session:key");
        });
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

        await act(async () => {
            await result.current.remove("session:key");
        });

        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            "/api/sessions/session%3Akey/action",
            expect.objectContaining({ body: JSON.stringify({ action: "stop" }) })
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            "/api/sessions/session%3Akey/action",
            expect.objectContaining({ body: JSON.stringify({ action: "compact" }) })
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            3,
            "/api/sessions/session%3Akey/action",
            expect.objectContaining({ body: JSON.stringify({ action: "reset" }) })
        );
        expect(fetchMock).toHaveBeenNthCalledWith(
            4,
            "/api/sessions/session%3Akey",
            expect.objectContaining({ method: "DELETE" })
        );
    });
});
