import * as v from "valibot";

import { finiteNumberSchema, parseContract } from "./runtime";

export const weatherForecastDaySchema = v.strictObject({
    date: v.pipe(v.string(), v.isoDate()),
    description: v.string(),
    maxTempC: v.optional(finiteNumberSchema),
    minTempC: v.optional(finiteNumberSchema),
});

export const weatherDataSchema = v.strictObject({
    description: v.string(),
    feelsLikeC: v.optional(finiteNumberSchema),
    fetchedAt: v.pipe(v.string(), v.isoTimestamp()),
    forecast: v.array(weatherForecastDaySchema),
    humidityPercent: v.optional(finiteNumberSchema),
    location: v.pipe(v.string(), v.nonEmpty()),
    maxTempC: v.optional(finiteNumberSchema),
    minTempC: v.optional(finiteNumberSchema),
    temperatureC: v.optional(finiteNumberSchema),
    windKph: v.optional(finiteNumberSchema),
});

export type WeatherForecastDay = v.InferOutput<typeof weatherForecastDaySchema>;
export type WeatherData = v.InferOutput<typeof weatherDataSchema>;

/**
 * Parses the stable Dashboard weather cache payload.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the stable Dashboard weather cache payload.
 */
export function parseWeatherData(value: unknown, path = "weather"): WeatherData {
    return parseContract(weatherDataSchema, value, path);
}
