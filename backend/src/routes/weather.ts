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

const WEATHER_CACHE_TTL_MS = 10 * 60 * 1000;
let weatherCache: WeatherResponse | null = null;
let weatherFetchInFlight: Promise<WeatherResponse> | null = null;

async function fetchWeather(): Promise<WeatherResponse> {
    const location = "Spydeberg";
    const response = await fetch(`https://wttr.in/${encodeURIComponent(location)}?format=j1`, {
        headers: {
            "User-Agent": "mira-dashboard/1.0",
        },
    });

    if (!response.ok) {
        throw new Error(`wttr.in HTTP ${response.status}`);
    }

    const data = (await response.json()) as WttrResponse;
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
