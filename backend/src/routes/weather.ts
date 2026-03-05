import express, { type RequestHandler } from "express";

interface WttrCondition {
    temp_C: string;
    FeelsLikeC?: string;
    humidity?: string;
    windspeedKmph?: string;
    weatherDesc?: Array<{ value: string }>;
}

interface WttrDay {
    date: string;
    maxtempC: string;
    mintempC: string;
    hourly?: Array<{
        weatherDesc?: Array<{ value: string }>;
    }>;
}

interface WttrResponse {
    current_condition?: WttrCondition[];
    weather?: WttrDay[];
}

interface WeatherResponse {
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
    cacheAgeMs?: number;
}

interface OpenMeteoResponse {
    current?: {
        temperature_2m?: number;
        relative_humidity_2m?: number;
        apparent_temperature?: number;
        weather_code?: number;
        wind_speed_10m?: number;
    };
    daily?: {
        time?: string[];
        weather_code?: number[];
        temperature_2m_max?: number[];
        temperature_2m_min?: number[];
    };
}

const WEATHER_CACHE_TTL_MS = 60 * 60 * 1000;
let weatherCache: WeatherResponse | null = null;
let weatherFetchInFlight: Promise<WeatherResponse> | null = null;

async function fetchJsonWithTimeout<T>(url: string, timeoutMs = 10_000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                "User-Agent": "mira-dashboard/1.0",
            },
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        return (await response.json()) as T;
    } finally {
        clearTimeout(timer);
    }
}

function openMeteoCodeToDescription(code?: number): string {
    if (code === undefined || code === null) return "Unknown";
    if (code === 0) return "Clear";
    if ([1, 2, 3].includes(code)) return "Partly cloudy";
    if ([45, 48].includes(code)) return "Fog";
    if ([51, 53, 55, 56, 57].includes(code)) return "Drizzle";
    if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "Rain";
    if ([71, 73, 75, 77, 85, 86].includes(code)) return "Snow";
    if ([95, 96, 99].includes(code)) return "Thunderstorm";
    return "Unknown";
}

async function fetchWeatherFromWttr(location: string): Promise<WeatherResponse> {
    const data = await fetchJsonWithTimeout<WttrResponse>(
        `https://wttr.in/${encodeURIComponent(location)}?format=j1`
    );

    const current = data.current_condition?.[0];
    const today = data.weather?.[0];

    return {
        location,
        temperatureC: current?.temp_C ? Number(current.temp_C) : null,
        feelsLikeC: current?.FeelsLikeC ? Number(current.FeelsLikeC) : null,
        humidityPercent: current?.humidity ? Number(current.humidity) : null,
        windKph: current?.windspeedKmph ? Number(current.windspeedKmph) : null,
        description: current?.weatherDesc?.[0]?.value || "Unknown",
        minTempC: today?.mintempC ? Number(today.mintempC) : null,
        maxTempC: today?.maxtempC ? Number(today.maxtempC) : null,
        forecast: (data.weather || []).slice(0, 3).map((day) => ({
            date: day.date,
            minTempC: day.mintempC ? Number(day.mintempC) : null,
            maxTempC: day.maxtempC ? Number(day.maxtempC) : null,
            description: day.hourly?.[0]?.weatherDesc?.[0]?.value || "Unknown",
        })),
        fetchedAt: Date.now(),
        cacheAgeMs: 0,
    };
}

async function fetchWeatherFromOpenMeteo(location: string): Promise<WeatherResponse> {
    const latitude = 59.62;
    const longitude = 11.08;

    const data = await fetchJsonWithTimeout<OpenMeteoResponse>(
        `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=Europe%2FOslo&forecast_days=3`
    );

    const current = data.current || {};
    const daily = data.daily || {};

    return {
        location,
        temperatureC: current.temperature_2m ?? null,
        feelsLikeC: current.apparent_temperature ?? null,
        humidityPercent: current.relative_humidity_2m ?? null,
        windKph: current.wind_speed_10m ?? null,
        description: openMeteoCodeToDescription(current.weather_code),
        minTempC: daily.temperature_2m_min?.[0] ?? null,
        maxTempC: daily.temperature_2m_max?.[0] ?? null,
        forecast: (daily.time || []).slice(0, 3).map((date, index) => ({
            date,
            minTempC: daily.temperature_2m_min?.[index] ?? null,
            maxTempC: daily.temperature_2m_max?.[index] ?? null,
            description: openMeteoCodeToDescription(daily.weather_code?.[index]),
        })),
        fetchedAt: Date.now(),
        cacheAgeMs: 0,
    };
}

async function fetchWeather(): Promise<WeatherResponse> {
    const location = "Spydeberg";

    try {
        return await fetchWeatherFromWttr(location);
    } catch (error) {
        console.warn("[Weather] wttr.in failed, falling back to Open-Meteo", error);
        return fetchWeatherFromOpenMeteo(location);
    }
}

export async function refreshWeatherCache(force = false): Promise<WeatherResponse> {
    const now = Date.now();
    if (!force && weatherCache && now - weatherCache.fetchedAt < WEATHER_CACHE_TTL_MS) {
        return weatherCache;
    }

    if (!weatherFetchInFlight) {
        weatherFetchInFlight = fetchWeather()
            .then((payload) => {
                weatherCache = payload;
                return payload;
            })
            .finally(() => {
                weatherFetchInFlight = null;
            });
    }

    return weatherFetchInFlight;
}

export function startWeatherMonitor(intervalMs = WEATHER_CACHE_TTL_MS): void {
    const safeInterval = Number.isFinite(intervalMs) && intervalMs >= 60_000 ? intervalMs : WEATHER_CACHE_TTL_MS;

    void refreshWeatherCache(true).catch((error) => {
        console.error("[Weather] initial refresh failed", error);
    });

    setInterval(() => {
        void refreshWeatherCache(true).catch((error) => {
            console.error("[Weather] scheduled refresh failed", error);
        });
    }, safeInterval).unref();
}

export default function weatherRoutes(app: express.Application): void {
    app.get("/api/weather", (async (_req, res) => {
        try {
            const payload = await refreshWeatherCache();
            const now = Date.now();
            res.json({ ...payload, cacheAgeMs: now - payload.fetchedAt } satisfies WeatherResponse);
        } catch (error) {
            if (weatherCache) {
                const now = Date.now();
                res.json({
                    ...weatherCache,
                    cacheAgeMs: now - weatherCache.fetchedAt,
                } satisfies WeatherResponse);
                return;
            }

            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);
}
