import { useCacheEntry } from "./useCache";

/** Describes weather data. */
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

/** Handles use weather. */
export function useWeather(refreshInterval: number | false = false) {
    const query = useCacheEntry<WeatherData>("weather.spydeberg", refreshInterval);

    return {
        ...query,
        data: query.data?.data,
    };
}
