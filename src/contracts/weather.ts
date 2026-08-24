import * as v from "valibot";

import {
    boundedControlSafeTextSchema,
    nonnegativeSafeIntegerSchema,
} from "../shared/validation.ts";

/** Stable cache identity for the code-owned Spydeberg weather projection. */
export const weatherCacheKey = "weather.spydeberg";
/** Exact schema identity retained with the weather cache row. */
export const weatherCacheSchemaId = "weather.spydeberg.v1";
/** Direct provider identity; no upstream response details cross this boundary. */
export const weatherCacheSource = "weather.open-meteo";
/** Maximum fresh lifetime retained by the Dashboard cache. */
export const weatherCacheTtlMs = 90 * 60_000;

const weatherTemperatureSchema = v.pipe(
    v.number("Weather temperature is invalid"),
    v.finite("Weather temperature is invalid"),
    v.minValue(-100, "Weather temperature is invalid"),
    v.maxValue(100, "Weather temperature is invalid")
);

const weatherPercentageSchema = v.pipe(
    v.number("Weather percentage is invalid"),
    v.finite("Weather percentage is invalid"),
    v.minValue(0, "Weather percentage is invalid"),
    v.maxValue(100, "Weather percentage is invalid")
);

const weatherWindSchema = v.pipe(
    v.number("Weather wind speed is invalid"),
    v.finite("Weather wind speed is invalid"),
    v.minValue(0, "Weather wind speed is invalid"),
    v.maxValue(500, "Weather wind speed is invalid")
);

export const weatherConditionSchema = v.picklist(
    ["clear", "cloudy", "drizzle", "fog", "rain", "snow", "thunderstorm", "unknown"],
    "Weather condition is invalid"
);

export const weatherForecastDaySchema = v.strictObject({
    condition: weatherConditionSchema,
    date: v.pipe(
        v.string("Weather date is invalid"),
        v.isoDate("Weather date is invalid")
    ),
    maximumTemperatureC: weatherTemperatureSchema,
    minimumTemperatureC: weatherTemperatureSchema,
});

export const weatherCachePayloadSchema = v.strictObject({
    apparentTemperatureC: weatherTemperatureSchema,
    condition: weatherConditionSchema,
    forecast: v.pipe(
        v.array(weatherForecastDaySchema, "Weather forecast is invalid"),
        v.length(3, "Weather forecast must contain exactly three days")
    ),
    humidityPercent: weatherPercentageSchema,
    location: v.literal("Spydeberg", "Weather location is invalid"),
    observedAtMs: nonnegativeSafeIntegerSchema("Weather timestamp is invalid"),
    temperatureC: weatherTemperatureSchema,
    timezone: v.literal("Europe/Oslo", "Weather timezone is invalid"),
    windKilometresPerHour: weatherWindSchema,
});

export type WeatherCachePayload = v.InferOutput<typeof weatherCachePayloadSchema>;

/** Bounded human-readable label used only for fixed weather presentation. */
export const weatherConditionLabelSchema = boundedControlSafeTextSchema(
    32,
    "Weather condition label is invalid"
);
