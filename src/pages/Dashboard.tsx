import { useLiveQuery } from "@tanstack/react-db";
import {
    Clock,
    Cloud,
    CloudDrizzle,
    CloudFog,
    CloudLightning,
    CloudRain,
    CloudSnow,
    CloudSun,
    Cpu,
    Droplets,
    HardDrive,
    MemoryStick,
    Sun,
    Wind,
} from "lucide-react";
import { useEffect, useState } from "react";

import { sessionsCollection } from "../collections/sessions";
import { ActiveSessionsCard, QuotaOverviewCard } from "../components/features/dashboard";
import { Alert } from "../components/ui/Alert";
import { Card } from "../components/ui/Card";
import { ConnectionStatus } from "../components/ui/ConnectionStatus";
import { MetricCard } from "../components/ui/MetricCard";
import { PageHeader } from "../components/ui/PageHeader";
import { useMetrics, useQuotas, useWeather } from "../hooks";
import { useOpenClawSocket } from "../hooks/useOpenClawSocket";
import {
    formatLoad,
    formatOsloDate,
    formatOsloTime,
    formatUptime,
    formatWeekdayShort,
} from "../utils/format";
import { sortSessionsByTypeAndActivity } from "../utils/sessionUtils";

function getWeatherIcon(description?: string) {
    const text = (description || "").toLowerCase();

    if (text.includes("thunder")) return CloudLightning;
    if (text.includes("snow") || text.includes("sleet") || text.includes("blizzard")) {
        return CloudSnow;
    }
    if (text.includes("drizzle")) return CloudDrizzle;
    if (text.includes("rain") || text.includes("shower")) return CloudRain;
    if (text.includes("mist") || text.includes("fog") || text.includes("haze")) {
        return CloudFog;
    }
    if (text.includes("clear") || text.includes("sun")) return Sun;
    if (text.includes("partly") || text.includes("cloudy")) return CloudSun;

    return Cloud;
}

function WeatherTimeCard() {
    const [now, setNow] = useState(() => new Date());
    const { data: weather, isLoading, isError } = useWeather();

    useEffect(() => {
        const timer = setInterval(() => {
            setNow(new Date());
        }, 1000);

        return () => {
            clearInterval(timer);
        };
    }, []);

    const localTime = formatOsloTime(now);
    const localDate = formatOsloDate(now);

    const CurrentWeatherIcon = getWeatherIcon(weather?.description);

    return (
        <Card>
            <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                    <div className="mb-1 flex items-center gap-2 text-xs uppercase tracking-wide text-primary-400">
                        <Clock className="h-3.5 w-3.5" />
                        {weather?.location || "Spydeberg"}
                    </div>
                    <div className="text-2xl font-semibold text-primary-50">{localTime}</div>
                    <div className="text-sm text-primary-300">{localDate}</div>
                </div>

                <div className="flex items-center gap-3">
                    <CurrentWeatherIcon className="h-7 w-7 text-amber-300" />
                    <div>
                        <div className="text-2xl font-semibold text-primary-50">
                            {weather?.temperatureC ?? "--"}°C
                        </div>
                        <div className="text-xs text-primary-300">
                            {isLoading ? "Loading weather..." : weather?.description || "Unknown"}
                        </div>
                    </div>
                </div>

                <div className="flex flex-wrap items-center gap-3 text-sm text-primary-200">
                    <span className="inline-flex items-center gap-1 rounded-md border border-primary-700 px-2 py-1">
                        <Cloud className="h-4 w-4 text-primary-400" />
                        Feels {weather?.feelsLikeC ?? "--"}°
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-md border border-primary-700 px-2 py-1">
                        <Droplets className="h-4 w-4 text-accent-300" />
                        {weather?.humidityPercent ?? "--"}%
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-md border border-primary-700 px-2 py-1">
                        <Wind className="h-4 w-4 text-primary-400" />
                        {weather?.windKph ?? "--"} km/h
                    </span>
                </div>
            </div>

            {isError && (
                <div className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-sm text-rose-300">
                    Kunne ikke hente værdata akkurat nå.
                </div>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
                {(weather?.forecast || []).slice(0, 3).map((day, index) => {
                    const dayLabel = formatWeekdayShort(new Date(day.date));
                    const ForecastIcon = getWeatherIcon(day.description);

                    return (
                        <div
                            key={day.date}
                            className="inline-flex items-center gap-2 rounded-md border border-primary-700 bg-primary-800/40 px-2 py-1 text-sm"
                        >
                            <span className="text-primary-400">{index === 0 ? "Today" : dayLabel}</span>
                            <ForecastIcon className="h-4 w-4 text-primary-300" />
                            <span className="text-primary-100">{day.maxTempC ?? "--"}°/{day.minTempC ?? "--"}°</span>
                        </div>
                    );
                })}
            </div>
        </Card>
    );
}

export function Dashboard() {
    const { isConnected, error } = useOpenClawSocket();
    const { data: metrics } = useMetrics();
    const { data: quotas } = useQuotas();

    const { data: sessions = [] } = useLiveQuery((q) =>
        q.from({ session: sessionsCollection })
    );

    const sortedSessions = sessions ? sortSessionsByTypeAndActivity(sessions) : [];

    return (
        <div className="space-y-6 p-6">
            <PageHeader
                title="Dashboard"
                status={<ConnectionStatus isConnected={isConnected} />}
            />

            {error && <Alert variant="error">{error}</Alert>}

            <div className="max-w-sm">
                <WeatherTimeCard />
            </div>

            <h2 className="text-lg font-semibold text-primary-100">System Health</h2>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
                <MetricCard
                    title="CPU"
                    value={metrics ? metrics.cpu.loadPercent + "%" : "—"}
                    subtitle={metrics ? formatLoad(metrics.cpu.loadAvg) : "Loading..."}
                    percent={metrics?.cpu.loadPercent}
                    icon={<Cpu className="h-5 w-5" />}
                />
                <MetricCard
                    title="Memory"
                    value={metrics ? metrics.memory.usedGB + " GB" : "—"}
                    subtitle={
                        metrics ? "of " + metrics.memory.totalGB + " GB" : "Loading..."
                    }
                    percent={metrics?.memory.percent}
                    icon={<MemoryStick className="h-5 w-5" />}
                />
                <MetricCard
                    title="Disk"
                    value={metrics ? metrics.disk.usedGB + " GB" : "—"}
                    subtitle={
                        metrics ? "of " + metrics.disk.totalGB + " GB" : "Loading..."
                    }
                    percent={metrics?.disk.percent}
                    icon={<HardDrive className="h-5 w-5" />}
                />
                <MetricCard
                    title="Uptime"
                    value={metrics ? formatUptime(metrics.system.uptime) : "—"}
                    subtitle={metrics ? metrics.system.hostname : "Loading..."}
                    color="green"
                    icon={<Clock className="h-5 w-5" />}
                />
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <ActiveSessionsCard sessions={sortedSessions} />
                <QuotaOverviewCard quotas={quotas} />
            </div>
        </div>
    );
}
