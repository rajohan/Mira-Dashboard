import { unknownArray } from "../../lib/values.ts";
import { writeCacheSuccess } from "../cacheEntryWriter.ts";
import {
    asRecord,
    errorMessage,
    fetchJson,
    nowIso,
    toOptionalNumber,
} from "./cacheProducerSupport.ts";

const SPYDEBERG = {
    name: "Spydeberg",
    wttrUrl: "https://wttr.in/Spydeberg?format=j1",
    openMeteoUrl:
        "https://api.open-meteo.com/v1/forecast?latitude=59.62&longitude=11.08&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=Europe%2FOslo&forecast_days=3",
};

function openMeteoCodeToDescription(code: unknown): string {
    if (code === undefined || code === null) return "Unknown";
    if (typeof code === "string" && code.trim() === "") return "Unknown";
    const numericCode = Number(code);
    if (!Number.isFinite(numericCode)) return "Unknown";
    if (numericCode === 0) return "Clear";
    if ([1, 2, 3].includes(numericCode)) return "Partly cloudy";
    if ([45, 48].includes(numericCode)) return "Fog";
    if ([51, 53, 55, 56, 57].includes(numericCode)) return "Drizzle";
    if ([61, 63, 65, 66, 67, 80, 81, 82].includes(numericCode)) return "Rain";
    if ([71, 73, 75, 77, 85, 86].includes(numericCode)) return "Snow";
    if ([95, 96, 99].includes(numericCode)) return "Thunderstorm";
    return "Unknown";
}

async function fetchSpydebergWeather() {
    try {
        const data = asRecord(await fetchJson(SPYDEBERG.wttrUrl));
        const current = asRecord(
            Array.isArray(data.current_condition) ? data.current_condition[0] : undefined
        );
        const today = asRecord(Array.isArray(data.weather) ? data.weather[0] : undefined);
        return {
            source: "wttr.in",
            data: {
                location: SPYDEBERG.name,
                temperatureC: toOptionalNumber(current.temp_C),
                feelsLikeC: toOptionalNumber(current.FeelsLikeC),
                humidityPercent: toOptionalNumber(current.humidity),
                windKph: toOptionalNumber(current.windspeedKmph),
                description:
                    asRecord(
                        Array.isArray(current.weatherDesc)
                            ? current.weatherDesc[0]
                            : undefined
                    ).value || "Unknown",
                minTempC: toOptionalNumber(today.mintempC),
                maxTempC: toOptionalNumber(today.maxtempC),
                forecast: (Array.isArray(data.weather) ? data.weather : [])
                    .slice(0, 3)
                    .map((dayValue) => {
                        const day = asRecord(dayValue);
                        const hourly = asRecord(
                            Array.isArray(day.hourly) ? day.hourly[0] : undefined
                        );
                        return {
                            date: day.date,
                            minTempC: toOptionalNumber(day.mintempC),
                            maxTempC: toOptionalNumber(day.maxtempC),
                            description:
                                asRecord(
                                    Array.isArray(hourly.weatherDesc)
                                        ? hourly.weatherDesc[0]
                                        : undefined
                                ).value || "Unknown",
                        };
                    }),
                fetchedAt: nowIso(),
            },
            fallbackReason: undefined,
        };
    } catch (error) {
        const data = asRecord(await fetchJson(SPYDEBERG.openMeteoUrl));
        const current = asRecord(data.current);
        const daily = asRecord(data.daily);
        const minTemps = unknownArray(daily.temperature_2m_min);
        const maxTemps = unknownArray(daily.temperature_2m_max);
        const weatherCodes = unknownArray(daily.weather_code);
        return {
            source: "open-meteo",
            data: {
                location: SPYDEBERG.name,
                temperatureC: current.temperature_2m ?? undefined,
                feelsLikeC: current.apparent_temperature ?? undefined,
                humidityPercent: current.relative_humidity_2m ?? undefined,
                windKph: current.wind_speed_10m ?? undefined,
                description: openMeteoCodeToDescription(current.weather_code),
                minTempC: minTemps[0] ?? undefined,
                maxTempC: maxTemps[0] ?? undefined,
                forecast: unknownArray(daily.time)
                    .slice(0, 3)
                    .map((date, index) => ({
                        date: typeof date === "string" ? date : "",
                        minTempC: minTemps[index] ?? undefined,
                        maxTempC: maxTemps[index] ?? undefined,
                        description: openMeteoCodeToDescription(weatherCodes[index]),
                    })),
                fetchedAt: nowIso(),
            },
            fallbackReason: errorMessage(error),
        };
    }
}

export async function refreshWeatherCache() {
    const result = await fetchSpydebergWeather();
    writeCacheSuccess({
        key: "weather.spydeberg",
        data: result.data,
        source: result.source,
        ttl: 6,
        ttlUnit: "hours",
        metadata: {
            workflow: "Cache Foundation - Weather Spydeberg",
            location: SPYDEBERG.name,
            country: "NO",
            fallbackUsed: result.source !== "wttr.in",
            fallbackReason: result.fallbackReason,
            providerPriority: ["wttr.in", "open-meteo"],
        },
    });
    return { refreshed: ["weather.spydeberg"] };
}
