import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { clsx } from "clsx";
import {
    Cloud,
    CloudDrizzle,
    CloudFog,
    CloudLightning,
    CloudRain,
    CloudSnow,
    CloudSun,
    Clock,
    Droplets,
    GitBranch,
    Gauge,
    Sun,
    Thermometer,
    Wind,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import type { GitWorkspaceCachePayload } from "../../contracts/gitWorkspace.ts";
import type {
    QuotaCachePayload,
    QuotaProviderProjection,
} from "../../contracts/quota.ts";
import type { WeatherCachePayload } from "../../contracts/weather.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import {
    formatDashboardDateTime,
    formatDashboardDateTimeParts,
    formatDashboardDateTimeToMinute,
    formatDashboardWeekdayDate,
} from "../lib/formatDateTime.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { PageState } from "../ui/PageState.tsx";
import { Text } from "../ui/Text.tsx";
import {
    gitOverviewQueryOptions,
    type OverviewProviderProjection,
    quotaOverviewQueryOptions,
    weatherOverviewQueryOptions,
} from "./overviewProviderQueries.ts";

interface ProviderCardProps<TPayload extends { readonly observedAtMs: number }> {
    readonly children: (payload: TPayload) => ReactNode;
    readonly className?: string;
    readonly description: string;
    readonly icon: typeof CloudSun;
    readonly query: UseQueryResult<OverviewProviderProjection<TPayload>, Error>;
    readonly title: string;
}

function freshnessLabel<TPayload>(
    query: UseQueryResult<OverviewProviderProjection<TPayload>, Error>
): { readonly label: string; readonly variant: "success" | "warning" } | undefined {
    if (query.data === undefined) return undefined;
    if (query.error !== null) return { label: "Browser retained", variant: "warning" };
    if (query.data.entry.freshness === "fresh") {
        return { label: "Fresh", variant: "success" };
    }
    return { label: "Last known good", variant: "warning" };
}

function ProviderCard<TPayload extends { readonly observedAtMs: number }>({
    children,
    className,
    description,
    icon: Icon,
    query,
    title,
}: ProviderCardProps<TPayload>) {
    const freshness = freshnessLabel(query);
    let content: ReactNode;
    if (query.isPending && query.data === undefined) {
        content = (
            <PageState label={`Loading ${title.toLowerCase()}…`} status="loading" />
        );
    } else if (query.data === undefined) {
        content = (
            <PageState
                headingLevel={3}
                message="The latest validated projection is not available."
                onRetry={() => void query.refetch()}
                retryBusy={query.isFetching}
                status="error"
                title={`${title} unavailable`}
            />
        );
    } else {
        content = children(query.data.payload);
    }

    return (
        <Card className={clsx("min-w-0", className)}>
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <Icon aria-hidden="true" className="text-accent-300 size-5" />
                        <Heading level={3}>{title}</Heading>
                    </div>
                    <Text className="mt-1" tone="muted">
                        {description}
                    </Text>
                </div>
                {freshness !== undefined && (
                    <Badge variant={freshness.variant}>{freshness.label}</Badge>
                )}
            </div>
            {query.error !== null && query.data !== undefined && (
                <Alert
                    className="mt-4"
                    focusOnError={false}
                    message="The refresh failed. Showing the retained validated result."
                />
            )}
            <div className="mt-5">{content}</div>
            {query.data !== undefined && (
                <Text className="mt-4" size="sm" tone="muted">
                    Observed {formatDashboardDateTime(query.data.payload.observedAtMs)}
                </Text>
            )}
        </Card>
    );
}

function formatTemperature(value: number): string {
    return `${Math.round(value)}°`;
}

function weatherIcon(condition: WeatherCachePayload["condition"], className: string) {
    const properties = { "aria-hidden": true, className } as const;
    if (condition === "clear") return <Sun {...properties} />;
    if (condition === "cloudy") return <CloudSun {...properties} />;
    if (condition === "drizzle") return <CloudDrizzle {...properties} />;
    if (condition === "fog") return <CloudFog {...properties} />;
    if (condition === "rain") return <CloudRain {...properties} />;
    if (condition === "snow") return <CloudSnow {...properties} />;
    if (condition === "thunderstorm") return <CloudLightning {...properties} />;
    return <Cloud {...properties} />;
}

function forecastDayLabel(date: string, index: number): string {
    if (index === 0) return "Today";
    return new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Oslo",
        weekday: "short",
    }).format(new Date(`${date}T12:00:00+02:00`));
}

function WeatherDetails({ payload }: { readonly payload: WeatherCachePayload }) {
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        const timer = globalThis.setInterval(() => setNow(new Date()), 1000);
        return () => globalThis.clearInterval(timer);
    }, []);
    const [, localTime] = formatDashboardDateTimeParts(now.getTime());
    const localDate = formatDashboardWeekdayDate(now.getTime());

    return (
        <div>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between xl:flex-col xl:items-stretch 2xl:flex-row 2xl:items-center">
                <div className="min-w-0">
                    <div className="text-primary-400 mb-1 flex items-center gap-2 text-xs tracking-wide uppercase">
                        <Clock aria-hidden="true" className="size-3.5" />
                        {payload.location}
                    </div>
                    <div className="text-primary-50 text-2xl font-semibold tabular-nums">
                        {localTime}
                    </div>
                    <div className="text-primary-300 text-sm capitalize">{localDate}</div>
                </div>
                <div className="border-primary-700 bg-primary-900/30 xl:bg-primary-900/30 flex items-center gap-3 rounded-lg border p-3 sm:border-0 sm:bg-transparent sm:p-0 xl:border xl:p-3 2xl:border-0 2xl:bg-transparent 2xl:p-0">
                    {weatherIcon(payload.condition, "size-7 shrink-0 text-amber-300")}
                    <div className="min-w-0">
                        <div className="text-primary-50 text-2xl font-semibold">
                            {formatTemperature(payload.temperatureC)}C
                        </div>
                        <div className="text-primary-300 text-xs capitalize">
                            {payload.condition}
                        </div>
                    </div>
                </div>
            </div>

            <div className="text-primary-200 mt-3 grid grid-cols-3 gap-1 text-xs sm:gap-2 xl:grid-cols-1 2xl:grid-cols-3">
                <span className="border-primary-700 bg-primary-800/40 flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-md border p-1 text-center">
                    <span className="text-primary-400">Feels</span>
                    <span className="text-primary-100 inline-flex items-center gap-1 whitespace-nowrap tabular-nums">
                        <Thermometer
                            aria-hidden="true"
                            className="text-primary-300 size-4 shrink-0"
                        />
                        {formatTemperature(payload.apparentTemperatureC)}
                    </span>
                </span>
                <span className="border-primary-700 bg-primary-800/40 flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-md border p-1 text-center">
                    <span className="text-primary-400">Humidity</span>
                    <span className="text-primary-100 inline-flex items-center gap-1 whitespace-nowrap tabular-nums">
                        <Droplets
                            aria-hidden="true"
                            className="text-accent-300 size-4 shrink-0"
                        />
                        {Math.round(payload.humidityPercent)}%
                    </span>
                </span>
                <span className="border-primary-700 bg-primary-800/40 flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-md border p-1 text-center">
                    <span className="text-primary-400">Wind</span>
                    <span className="text-primary-100 inline-flex items-center gap-1 whitespace-nowrap tabular-nums">
                        <Wind
                            aria-hidden="true"
                            className="text-primary-300 size-4 shrink-0"
                        />
                        {Math.round(payload.windKilometresPerHour)} km/h
                    </span>
                </span>
            </div>

            <ul className="mt-3 grid grid-cols-3 gap-1 sm:gap-2 xl:grid-cols-1 2xl:grid-cols-3">
                {payload.forecast.map((day, index) => (
                    <li
                        className="border-primary-700 bg-primary-800/40 flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-md border p-1 text-center text-xs sm:px-2"
                        key={day.date}
                    >
                        <span className="text-primary-400 whitespace-nowrap">
                            {forecastDayLabel(day.date, index)}
                        </span>
                        <span className="text-primary-100 inline-flex min-w-0 items-center gap-0.5 text-[11px] leading-none whitespace-nowrap tabular-nums sm:gap-1 sm:text-xs">
                            {weatherIcon(
                                day.condition,
                                "size-4 shrink-0 text-primary-300"
                            )}
                            {formatTemperature(day.maximumTemperatureC)}/
                            {formatTemperature(day.minimumTemperatureC)}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

/** @returns The independently degradable Spydeberg weather card. */
export function WeatherOverviewCard({ className }: { readonly className?: string }) {
    const client = useDashboardTrpcClient();
    const weather = useQuery(weatherOverviewQueryOptions(client));

    let content: ReactNode;
    if (weather.isPending && weather.data === undefined) {
        content = <PageState label="Loading weather…" status="loading" />;
    } else if (weather.data === undefined) {
        content = (
            <PageState
                headingLevel={3}
                message="The latest validated projection is not available."
                onRetry={() => void weather.refetch()}
                retryBusy={weather.isFetching}
                status="error"
                title="Weather unavailable"
            />
        );
    } else {
        content = <WeatherDetails payload={weather.data.payload} />;
    }

    return (
        <Card className={clsx("min-w-0", className)}>
            <Heading className="sr-only" level={3}>
                Weather
            </Heading>
            {weather.error !== null && weather.data !== undefined && (
                <Alert
                    className="mb-3"
                    focusOnError={false}
                    message="The refresh failed. Showing the retained validated result."
                />
            )}
            {content}
        </Card>
    );
}

function quotaSummary(provider: QuotaProviderProjection): string {
    if (provider.status === "not-configured") return "Not configured";
    if (provider.status === "unavailable") return "Unavailable";
    if (provider.remainingPercent !== undefined) {
        return `${Math.round(provider.remainingPercent)}% remaining`;
    }
    if (provider.usedPercent !== undefined) {
        return `${Math.round(provider.usedPercent)}% used`;
    }
    if (provider.windows !== undefined)
        return `${provider.windows.length} active window${provider.windows.length === 1 ? "" : "s"}`;
    if (provider.remaining !== undefined) return `${provider.remaining} remaining`;
    return `${provider.used ?? 0} used`;
}

function quotaWindowDuration(minutes: number): string {
    if (minutes % 1440 === 0) return `${minutes / 1440}d window`;
    if (minutes % 60 === 0) return `${minutes / 60}h window`;
    return `${minutes} min window`;
}

export function QuotaResetTime({ resetsAtMs }: { readonly resetsAtMs: number }) {
    const resetDate = new Date(resetsAtMs);
    if (Number.isNaN(resetDate.getTime())) {
        return <span>Unavailable</span>;
    }
    return (
        <time dateTime={resetDate.toISOString()}>
            {formatDashboardDateTimeToMinute(resetsAtMs)}
        </time>
    );
}

function QuotaDetails({ payload }: { readonly payload: QuotaCachePayload }) {
    return (
        <ul className="space-y-2">
            {payload.providers.map((provider) => {
                const windows = provider.windows ?? [];
                return (
                    <li
                        className="bg-primary-900/45 rounded-lg px-3 py-2"
                        key={provider.id}
                    >
                        <div className="flex items-center justify-between gap-3">
                            <Text className="font-medium">{provider.label}</Text>
                            <Text
                                as="span"
                                size="sm"
                                tone={
                                    provider.status === "available" ? "default" : "muted"
                                }
                            >
                                {quotaSummary(provider)}
                            </Text>
                        </div>
                        {provider.resetsAtMs === undefined ||
                        windows.length > 0 ? null : (
                            <Text className="mt-1" size="sm" tone="muted">
                                Resets <QuotaResetTime resetsAtMs={provider.resetsAtMs} />
                            </Text>
                        )}
                        {windows.length === 0 ? null : (
                            <ul
                                aria-label={`${provider.label} quota windows`}
                                className="border-primary-700/70 mt-2 space-y-1 border-t pt-2"
                            >
                                {windows.map((quotaWindow) => (
                                    <li
                                        className="flex flex-wrap justify-between gap-x-3 gap-y-1"
                                        key={`${quotaWindow.windowDurationMinutes}:${quotaWindow.resetsAtMs}`}
                                    >
                                        <Text as="span" size="sm" tone="muted">
                                            {quotaWindowDuration(
                                                quotaWindow.windowDurationMinutes
                                            )}
                                        </Text>
                                        <Text as="span" size="sm">
                                            {Math.round(quotaWindow.usedPercent)}% used ·
                                            resets{" "}
                                            <QuotaResetTime
                                                resetsAtMs={quotaWindow.resetsAtMs}
                                            />
                                        </Text>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </li>
                );
            })}
        </ul>
    );
}

function gitRepositoryDetail(
    repository: GitWorkspaceCachePayload["repositories"][number]
): string {
    if (repository.state === "missing") return "Repository missing";
    if (repository.state === "unavailable") return "Status unavailable";
    return `${repository.branch ?? "Detached"} · ${repository.headSha?.slice(0, 7)}`;
}

function GitDetails({ payload }: { readonly payload: GitWorkspaceCachePayload }) {
    return (
        <ul className="space-y-2">
            {payload.repositories.map((repository) => {
                const changes = repository.changedFileCount;
                return (
                    <li
                        className="bg-primary-900/45 flex items-center justify-between gap-3 rounded-lg px-3 py-2"
                        key={repository.id}
                    >
                        <div className="min-w-0">
                            <Text className="font-medium capitalize">
                                {repository.id}
                            </Text>
                            <Text className="truncate" size="sm" tone="muted">
                                {gitRepositoryDetail(repository)}
                            </Text>
                            {repository.state === "available" && changes > 0 ? (
                                <Text size="sm" tone="muted">
                                    {repository.stagedFileCount} staged ·{" "}
                                    {repository.untrackedFileCount} untracked
                                </Text>
                            ) : null}
                        </div>
                        {repository.state === "available" && (
                            <Badge variant={changes === 0 ? "success" : "warning"}>
                                {changes === 0 ? "Clean" : `${changes} changed`}
                            </Badge>
                        )}
                    </li>
                );
            })}
        </ul>
    );
}

/** @returns Independent quota and managed-Git overview cards. */
export function OverviewEnvironmentSection() {
    const client = useDashboardTrpcClient();
    const quota = useQuery(quotaOverviewQueryOptions(client));
    const git = useQuery(gitOverviewQueryOptions(client));

    return (
        <section aria-labelledby="environment-overview-heading">
            <Heading id="environment-overview-heading" level={2}>
                Environment
            </Heading>
            <Text className="mt-1" tone="muted">
                Provider limits and managed repository state from independent background
                checks.
            </Text>
            <div className="mt-5 grid gap-5 lg:grid-cols-2">
                <ProviderCard
                    description="Normalized limits for configured AI and media providers."
                    icon={Gauge}
                    query={quota}
                    title="Provider quota"
                >
                    {(payload) => <QuotaDetails payload={payload} />}
                </ProviderCard>
                <ProviderCard
                    description="Path-free status for Dashboard, Docker, and OpenClaw."
                    icon={GitBranch}
                    query={git}
                    title="Managed Git"
                >
                    {(payload) => <GitDetails payload={payload} />}
                </ProviderCard>
            </div>
        </section>
    );
}
