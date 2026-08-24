import * as v from "valibot";

import {
    type WeatherCachePayload,
    weatherCachePayloadSchema,
    weatherConditionSchema,
} from "../../contracts/weather.ts";
import { fetchBoundedJson } from "./boundedJsonFetch.ts";

const spydebergWeatherUrl = new URL(
    "https://api.open-meteo.com/v1/forecast?latitude=59.62&longitude=11.08&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=Europe%2FOslo&forecast_days=3"
);

const finiteNumberSchema = v.pipe(v.number(), v.finite());
const openMeteoResponseSchema = v.object({
    current: v.object({
        apparent_temperature: finiteNumberSchema,
        relative_humidity_2m: finiteNumberSchema,
        temperature_2m: finiteNumberSchema,
        weather_code: finiteNumberSchema,
        wind_speed_10m: finiteNumberSchema,
    }),
    daily: v.object({
        temperature_2m_max: v.array(finiteNumberSchema),
        temperature_2m_min: v.array(finiteNumberSchema),
        time: v.array(v.pipe(v.string(), v.isoDate())),
        weather_code: v.array(finiteNumberSchema),
    }),
});

type WeatherCondition = v.InferOutput<typeof weatherConditionSchema>;

/**
 * Maps an Open-Meteo weather code to a bounded presentation category.
 * @param code Open-Meteo weather code.
 * @returns The bounded presentation category for the code.
 */
export function weatherConditionFromCode(code: number): WeatherCondition {
    if (code === 0) return "clear";
    if ([1, 2, 3].includes(code)) return "cloudy";
    if ([45, 48].includes(code)) return "fog";
    if ([51, 53, 55, 56, 57].includes(code)) return "drizzle";
    if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "rain";
    if ([71, 73, 75, 77, 85, 86].includes(code)) return "snow";
    if ([95, 96, 99].includes(code)) return "thunderstorm";
    return "unknown";
}

export interface WeatherCollectorOptions {
    readonly fetch?: typeof globalThis.fetch;
    readonly nowMs?: () => number;
}

/**
 * Collects the fixed Spydeberg projection without retaining upstream response data.
 * @returns The normalized current weather and three-day forecast.
 */
export async function collectWeatherPayload(
    signal?: AbortSignal,
    options: WeatherCollectorOptions = {}
): Promise<WeatherCachePayload> {
    const upstream = v.parse(
        openMeteoResponseSchema,
        await fetchBoundedJson({
            fetch: options.fetch,
            maximumBytes: 64 * 1024,
            signal,
            timeoutMs: 10_000,
            url: spydebergWeatherUrl,
        })
    );
    const forecast = upstream.daily.time.slice(0, 3).map((date, index) => ({
        condition: weatherConditionFromCode(upstream.daily.weather_code[index]!),
        date,
        maximumTemperatureC: upstream.daily.temperature_2m_max[index]!,
        minimumTemperatureC: upstream.daily.temperature_2m_min[index]!,
    }));
    return v.parse(weatherCachePayloadSchema, {
        apparentTemperatureC: upstream.current.apparent_temperature,
        condition: weatherConditionFromCode(upstream.current.weather_code),
        forecast,
        humidityPercent: upstream.current.relative_humidity_2m,
        location: "Spydeberg",
        observedAtMs: (options.nowMs ?? Date.now)(),
        temperatureC: upstream.current.temperature_2m,
        timezone: "Europe/Oslo",
        windKilometresPerHour: upstream.current.wind_speed_10m,
    });
}
