import { useCacheEntry } from "./useCache";

/** Represents weather data. */
export interface WeatherData {
    location: string;
    temperatureC: number | undefined;
    feelsLikeC: number | undefined;
    humidityPercent: number | undefined;
    windKph: number | undefined;
    description: string;
    minTempC: number | undefined;
    maxTempC: number | undefined;
    forecast: Array<{
        date: string;
        minTempC: number | undefined;
        maxTempC: number | undefined;
        description: string;
    }>;
    fetchedAt: number;
}

/** Provides weather. */
export function useWeather(refreshInterval: number | false = false) {
    const query = useCacheEntry<WeatherData>("weather.spydeberg", refreshInterval);

    return {
        ...query,
        data: query.data?.data,
    };
}
