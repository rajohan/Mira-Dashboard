import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, jest } from "bun:test";

import { createQueryWrapper } from "../test/queryClient";
import { stubGlobal } from "../test/testUtils";
import { useWeather } from "./useWeather";

describe("useWeather", () => {
    it("unwraps cached weather entry data", async () => {
        const weather = {
            description: "Sunny",
            feelsLikeC: 4,
            fetchedAt: 1,
            forecast: [],
            humidityPercent: 70,
            location: "Spydeberg",
            maxTempC: 8,
            minTempC: 2,
            temperatureC: 5,
            windKph: 12,
        };
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ key: "weather.spydeberg", data: weather }),
        });
        stubGlobal("fetch", fetchMock);

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
