import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createQueryWrapper } from "../test/queryClient";
import { useWeather } from "./useWeather";

describe("useWeather", () => {
    it("unwraps cached weather entry data", async () => {
        const weather = { location: "Spydeberg", temperatureC: 5, forecast: [] };
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ key: "weather.spydeberg", data: weather }),
        });
        vi.stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useWeather(false), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() => expect(result.current.data).toBe(weather));
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/cache/weather.spydeberg",
            expect.any(Object)
        );
    });
});
