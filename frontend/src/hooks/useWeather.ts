import { parseWeatherData, type WeatherData } from "../../../contracts/weather";
import { useCacheEntry } from "./useCache";

/**
 * Provides weather.
 * @param refreshInterval Refresh interval value.
 * @returns The weather.
 */
export function useWeather(refreshInterval: number | false = false) {
    const query = useCacheEntry<WeatherData>(
        "weather.spydeberg",
        parseWeatherData,
        refreshInterval
    );

    return {
        ...query,
        data: query.data?.data,
    };
}
