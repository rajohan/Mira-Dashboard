import { useQuery } from "@tanstack/react-query";

import { apiFetch } from "./useApi";

export interface WeatherData {
    location: string;
    temperatureC: number | null;
    feelsLikeC: number | null;
    humidityPercent: number | null;
    windKph: number | null;
    description: string;
    minTempC: number | null;
    maxTempC: number | null;
    forecast: Array<{
        date: string;
        minTempC: number | null;
        maxTempC: number | null;
        description: string;
    }>;
    fetchedAt: number;
}

function fetchWeather(): Promise<WeatherData> {
    return apiFetch<WeatherData>("/weather");
}

export function useWeather(refreshInterval: number | false = false) {
    return useQuery({
        queryKey: ["weather"],
        queryFn: fetchWeather,
        refetchInterval: refreshInterval,
        staleTime: 120000,
    });
}
