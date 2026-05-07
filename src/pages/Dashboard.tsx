import {
    ArrowDown,
    ArrowUp,
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

import {
    BackupOverviewCard,
    CacheStatusCard,
    CronOverviewCard,
    GitOverviewCard,
    LogRotationCard,
    QuotaOverviewCard,
    ServiceActionsCard,
} from "../components/features/dashboard";
import { Alert } from "../components/ui/Alert";
import { Card } from "../components/ui/Card";
import { MetricCard } from "../components/ui/MetricCard";
import { useMetrics, useQuotas, useWeather } from "../hooks";
import { useOpenClawSocket } from "../hooks/useOpenClawSocket";
import { AUTO_REFRESH_MS } from "../lib/queryClient";
import {
    formatLoad,
    formatOsloDate,
    formatOsloTime,
    formatUptime,
    formatWeekdayShort,
} from "../utils/format";

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

function formatTemp(value: number | null | undefined): string {
    if (value === null || value === undefined || Number.isNaN(value)) {
        return "--";
    }

    return Math.round(value).toString();
}

interface WeatherTimeCardProps {
    className?: string;
}

function WeatherTimeCard({ className }: WeatherTimeCardProps) {
    const [now, setNow] = useState(() => new Date());
    const { data: weather, isLoading, isError } = useWeather(AUTO_REFRESH_MS);

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
        <Card className={className}>
            <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                <div className="min-w-0">
                    <div className="mb-1 flex items-center gap-2 text-xs uppercase tracking-wide text-primary-400">
                        <Clock className="h-3.5 w-3.5" />
                        {weather?.location || "Spydeberg"}
                    </div>
                    <div className="text-2xl font-semibold text-primary-50">
                        {localTime}
                    </div>
                    <div className="text-sm text-primary-300">{localDate}</div>
                </div>

                <div className="flex items-center gap-3 rounded-lg border border-primary-700 bg-primary-900/30 p-3 sm:border-0 sm:bg-transparent sm:p-0">
                    <CurrentWeatherIcon className="h-7 w-7 text-amber-300" />
                    <div className="min-w-0">
                        <div className="text-2xl font-semibold text-primary-50">
                            {formatTemp(weather?.temperatureC)}°C
                        </div>
                        <div className="truncate text-xs text-primary-300">
                            {isLoading
                                ? "Loading weather..."
                                : weather?.description || "Unknown"}
                        </div>
                    </div>
                </div>

                <div className="grid grid-cols-3 gap-2 text-xs text-primary-200 sm:flex sm:flex-wrap sm:items-center sm:gap-3 sm:text-sm">
                    <span className="inline-flex min-w-0 items-center gap-1 rounded-md border border-primary-700 px-2 py-1">
                        <Cloud className="h-4 w-4 text-primary-400" />
                        <span className="truncate">
                            Feels {formatTemp(weather?.feelsLikeC)}°
                        </span>
                    </span>
                    <span className="inline-flex min-w-0 items-center gap-1 rounded-md border border-primary-700 px-2 py-1">
                        <Droplets className="h-4 w-4 text-accent-300" />
                        <span className="truncate">
                            {weather?.humidityPercent ?? "--"}%
                        </span>
                    </span>
                    <span className="inline-flex min-w-0 items-center gap-1 rounded-md border border-primary-700 px-2 py-1">
                        <Wind className="h-4 w-4 text-primary-400" />
                        <span className="truncate">{weather?.windKph ?? "--"} km/h</span>
                    </span>
                </div>
            </div>

            {isError && (
                <div className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-sm text-rose-300">
                    Couldn't retrieve weather data right now.
                </div>
            )}

            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3 xl:grid-cols-1 2xl:grid-cols-3">
                {(weather?.forecast || []).slice(0, 3).map((day, index) => {
                    const dayLabel = formatWeekdayShort(new Date(day.date));
                    const ForecastIcon = getWeatherIcon(day.description);

                    return (
                        <div
                            key={day.date}
                            className="inline-flex min-w-0 items-center justify-between gap-2 rounded-md border border-primary-700 bg-primary-800/40 px-2 py-1 text-sm sm:justify-start"
                        >
                            <span className="text-primary-400">
                                {index === 0 ? "Today" : dayLabel}
                            </span>
                            <ForecastIcon className="h-4 w-4 text-primary-300" />
                            <span className="text-primary-100">
                                {formatTemp(day.maxTempC)}°/{formatTemp(day.minTempC)}°
                            </span>
                        </div>
                    );
                })}
            </div>
        </Card>
    );
}

export function Dashboard() {
    const { error } = useOpenClawSocket();
    const { data: metrics } = useMetrics(AUTO_REFRESH_MS);
    const { data: quotas } = useQuotas(AUTO_REFRESH_MS);

    return (
        <div className="space-y-4 p-3 sm:p-4 lg:space-y-6 lg:p-6">
            {error && <Alert variant="error">{error}</Alert>}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 xl:gap-6">
                <WeatherTimeCard className="sm:col-span-2 lg:col-span-3 xl:col-span-1 xl:row-span-2" />
                <MetricCard
                    title="CPU"
                    subtitle={metrics ? formatLoad(metrics.cpu.loadAvg) : "Loading..."}
                    percent={metrics?.cpu.loadPercent}
                    showValue={false}
                    icon={<Cpu className="h-5 w-5" />}
                />
                <MetricCard
                    title="Memory"
                    subtitle={
                        metrics
                            ? metrics.memory.usedGB +
                              " GB of " +
                              metrics.memory.totalGB +
                              " GB"
                            : "Loading..."
                    }
                    percent={metrics?.memory.percent}
                    showValue={false}
                    icon={<MemoryStick className="h-5 w-5" />}
                />
                <MetricCard
                    title="Disk"
                    subtitle={
                        metrics
                            ? metrics.disk.usedGB +
                              " GB of " +
                              metrics.disk.totalGB +
                              " GB"
                            : "Loading..."
                    }
                    percent={metrics?.disk.percent}
                    showValue={false}
                    icon={<HardDrive className="h-5 w-5" />}
                />
                <MetricCard
                    title="Uptime"
                    value={metrics ? formatUptime(metrics.system.uptime) : "—"}
                    subtitle={metrics ? metrics.system.hostname : "Loading..."}
                    color="green"
                    icon={<Clock className="h-5 w-5" />}
                />
                <MetricCard
                    title="Download"
                    value={
                        metrics?.network
                            ? `${metrics.network.downloadMbps.toFixed(2)} Mbit/s`
                            : "—"
                    }
                    subtitle="Current throughput"
                    color="blue"
                    icon={<ArrowDown className="h-5 w-5" />}
                />
                <MetricCard
                    title="Upload"
                    value={
                        metrics?.network
                            ? `${metrics.network.uploadMbps.toFixed(2)} Mbit/s`
                            : "—"
                    }
                    subtitle="Current throughput"
                    color="blue"
                    icon={<ArrowUp className="h-5 w-5" />}
                />
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-4 xl:gap-6">
                <QuotaOverviewCard quotas={quotas} />
                <GitOverviewCard />
                <CronOverviewCard />
                <CacheStatusCard
                    title="Cache controls"
                    items={[
                        {
                            key: "weather.spydeberg",
                            label: "Weather",
                            description: "Weather cache producer",
                        },
                        {
                            key: "quotas.summary",
                            label: "Quotas",
                            description: "Provider quota snapshot",
                        },
                        {
                            key: "moltbook.home",
                            label: "Moltbook",
                            description:
                                "Refresh home, feed, profile, and my content caches",
                            refreshKeys: [
                                "moltbook.home",
                                "moltbook.feed.hot",
                                "moltbook.feed.new",
                                "moltbook.profile",
                                "moltbook.my-content",
                            ],
                        },
                        {
                            key: "git.workspace",
                            label: "Git workspace",
                            description: "Dirty repo + push state snapshot",
                        },
                        {
                            key: "system.host",
                            label: "Host",
                            description: "Disk, memory and host warnings",
                        },
                        {
                            key: "backup.kopia.status",
                            label: "Kopia backup",
                            description: "Filesystem backup snapshot status",
                        },
                        {
                            key: "backup.walg.status",
                            label: "Postgres backup",
                            description: "Daily Postgres backup status",
                        },
                        {
                            key: "log_rotation.state",
                            label: "Log rotation",
                            description: "Docker file log rotation status",
                        },
                    ]}
                />
            </div>

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2 xl:gap-6">
                <BackupOverviewCard />
                <ServiceActionsCard />
            </div>

            <LogRotationCard />
        </div>
    );
}
