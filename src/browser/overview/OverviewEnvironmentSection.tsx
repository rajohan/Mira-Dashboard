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
    DollarSign,
    Droplets,
    GitBranch,
    GitCommitHorizontal,
    Gauge,
    Sun,
    Thermometer,
    Waves,
    Wind,
    Zap,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import type { GitWorkspaceCachePayload } from "../../contracts/gitWorkspace.ts";
import type {
    QuotaCachePayload,
    QuotaProviderProjection,
} from "../../contracts/quota.ts";
import type { WeatherCachePayload } from "../../contracts/weather.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { formatDashboardDateTimeParts } from "../lib/formatDateTime.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Card } from "../ui/Card.tsx";
import { ExternalLink } from "../ui/ExternalLink.tsx";
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
    readonly icon: typeof CloudSun;
    readonly query: UseQueryResult<OverviewProviderProjection<TPayload>, Error>;
    readonly showFreshness?: boolean;
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
    icon: Icon,
    query,
    showFreshness = true,
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
                </div>
                {showFreshness && freshness !== undefined && (
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

function dateInTimeZone(date: Date, timeZone: string): string {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-GB", {
            day: "2-digit",
            month: "2-digit",
            timeZone,
            year: "numeric",
        })
            .formatToParts(date)
            .map((part) => [part.type, part.value])
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
}

function forecastDayLabel(date: string, now: Date, timeZone: string): string {
    if (date === dateInTimeZone(now, timeZone)) return "Today";
    return new Intl.DateTimeFormat("en-GB", {
        timeZone,
        weekday: "short",
    }).format(new Date(`${date}T12:00:00Z`));
}

function WeatherDetails({ payload }: { readonly payload: WeatherCachePayload }) {
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        const timer = globalThis.setInterval(() => setNow(new Date()), 1000);
        return () => globalThis.clearInterval(timer);
    }, []);
    const localTime = new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        hourCycle: "h23",
        minute: "2-digit",
        second: "2-digit",
        timeZone: payload.timezone,
    }).format(now);
    const localDate = Object.fromEntries(
        new Intl.DateTimeFormat("en-GB", {
            day: "2-digit",
            month: "2-digit",
            timeZone: payload.timezone,
            weekday: "long",
            year: "numeric",
        })
            .formatToParts(now)
            .map((part) => [part.type, part.value])
    );
    const localDateLabel = `${localDate.weekday}, ${localDate.day}.${localDate.month}.${localDate.year}`;

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
                    <div className="text-primary-300 text-sm capitalize">
                        {localDateLabel}
                    </div>
                </div>
                <div className="border-primary-700 bg-primary-900/35 xl:bg-primary-900/35 flex items-center gap-3 rounded-lg border p-3 sm:border-0 sm:bg-transparent sm:p-0 xl:border xl:p-3 2xl:border-0 2xl:bg-transparent 2xl:p-0">
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
                <span className="border-primary-700 bg-primary-900/35 flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-md border p-1 text-center">
                    <span className="text-primary-400">Feels</span>
                    <span className="text-primary-100 inline-flex items-center gap-1 whitespace-nowrap tabular-nums">
                        <Thermometer
                            aria-hidden="true"
                            className="text-primary-300 size-4 shrink-0"
                        />
                        {formatTemperature(payload.apparentTemperatureC)}
                    </span>
                </span>
                <span className="border-primary-700 bg-primary-900/35 flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-md border p-1 text-center">
                    <span className="text-primary-400">Humidity</span>
                    <span className="text-primary-100 inline-flex items-center gap-1 whitespace-nowrap tabular-nums">
                        <Droplets
                            aria-hidden="true"
                            className="text-accent-300 size-4 shrink-0"
                        />
                        {Math.round(payload.humidityPercent)}%
                    </span>
                </span>
                <span className="border-primary-700 bg-primary-900/35 flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-md border p-1 text-center">
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
                {payload.forecast.map((day) => (
                    <li
                        className="border-primary-700 bg-primary-900/35 flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-md border p-1 text-center text-xs sm:px-2"
                        key={day.date}
                    >
                        <span className="text-primary-400 whitespace-nowrap">
                            {forecastDayLabel(day.date, now, payload.timezone)}
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
    if (
        (provider.id === "synthetic" || provider.id === "openai") &&
        provider.windows !== undefined
    ) {
        return provider.windows
            .map((window) => {
                const label =
                    window.windowDurationMinutes === 10_080
                        ? "weekly"
                        : quotaWindowDuration(window.windowDurationMinutes).replace(
                              " window",
                              ""
                          );
                return `${label} ${Math.round(100 - window.usedPercent)}% left`;
            })
            .join(" · ");
    }
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

function formatDollarAmount(value: number, maximumFractionDigits: number): string {
    return `$${value.toLocaleString("en-US", {
        maximumFractionDigits,
        minimumFractionDigits: 0,
        useGrouping: false,
    })}`;
}

function openRouterQuotaSummary(provider: QuotaProviderProjection): string | undefined {
    if (provider.remaining === undefined || provider.limit === undefined)
        return undefined;
    return `${formatDollarAmount(provider.remaining, 3)} left / ${formatDollarAmount(provider.limit, 3)} monthly quota`;
}

function openRouterBalanceSummary(provider: QuotaProviderProjection): string | undefined {
    if (provider.balance === undefined || provider.periodUsage === undefined)
        return undefined;
    return `${formatDollarAmount(provider.balance, 2)} balance · ${formatDollarAmount(provider.periodUsage, 4)} this month`;
}

function quotaUsedPercent(provider: QuotaProviderProjection): number | undefined {
    if (provider.usedPercent !== undefined) return provider.usedPercent;
    if (provider.remainingPercent !== undefined) return 100 - provider.remainingPercent;
    return undefined;
}

function quotaBadgeVariant(percent: number): "danger" | "success" | "warning" {
    if (percent < 80) return "success";
    if (percent < 95) return "warning";
    return "danger";
}

function quotaProviderIcon(providerId: QuotaProviderProjection["id"]): ReactNode {
    const className = "text-primary-300 size-4 shrink-0";
    if (providerId === "openrouter") {
        return <Waves aria-hidden="true" className={className} />;
    }
    if (providerId === "openai") {
        return <DollarSign aria-hidden="true" className={className} />;
    }
    return <Zap aria-hidden="true" className={className} />;
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
    const [date, time] = formatDashboardDateTimeParts(resetsAtMs);
    return (
        <time dateTime={resetDate.toISOString()}>
            {date}, {time.slice(0, 5)}
        </time>
    );
}

function quotaWindowReset(
    window: NonNullable<QuotaProviderProjection["windows"]>[number]
): string {
    const [date, time] = formatDashboardDateTimeParts(window.resetsAtMs);
    return window.windowDurationMinutes < 1440
        ? time.slice(0, 5)
        : `${date}, ${time.slice(0, 5)}`;
}

function quotaRegenerationSummary(
    windows: NonNullable<QuotaProviderProjection["windows"]>
): string {
    const segments = windows.map((window) => {
        const label =
            window.windowDurationMinutes === 10_080
                ? "weekly"
                : quotaWindowDuration(window.windowDurationMinutes).replace(
                      " window",
                      ""
                  );
        const regeneration =
            window.regenerationPercent === undefined
                ? ""
                : ` (+${Math.round(window.regenerationPercent)}%)`;
        return `${label} ${quotaWindowReset(window)}${regeneration}`;
    });
    return `Regen: ${segments.join(" · ")}`;
}

function quotaWindowResetSummary(
    windows: NonNullable<QuotaProviderProjection["windows"]>
): string {
    return `Resets: ${windows
        .map((window) => {
            const label =
                window.windowDurationMinutes === 10_080
                    ? "weekly"
                    : quotaWindowDuration(window.windowDurationMinutes).replace(
                          " window",
                          ""
                      );
            return `${label} ${quotaWindowReset(window)}`;
        })
        .join(" · ")}`;
}

function QuotaDetails({ payload }: { readonly payload: QuotaCachePayload }) {
    const providers = payload.providers.toSorted(
        (left, right) =>
            ["openrouter", "elevenlabs", "synthetic", "openai"].indexOf(left.id) -
            ["openrouter", "elevenlabs", "synthetic", "openai"].indexOf(right.id)
    );
    return (
        <ul className="space-y-2">
            {providers.map((provider) => {
                const windows = provider.windows ?? [];
                const usedPercent = quotaUsedPercent(provider);
                let windowDetails: ReactNode;
                if (provider.id === "synthetic" && windows.length > 0) {
                    windowDetails = (
                        <Text className="mt-1" size="sm" tone="muted">
                            {quotaRegenerationSummary(windows)}
                        </Text>
                    );
                } else if (provider.id === "openai" && windows.length > 0) {
                    windowDetails = (
                        <Text className="mt-1" size="sm" tone="muted">
                            {quotaWindowResetSummary(windows)}
                        </Text>
                    );
                } else if (windows.length > 0) {
                    windowDetails = (
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
                    );
                }
                return (
                    <li
                        className="border-primary-700 bg-primary-900/35 rounded-lg border px-3 py-2"
                        key={provider.id}
                    >
                        <div className="mb-1 flex items-start justify-between gap-2">
                            <div className="text-primary-100 inline-flex min-w-0 items-center gap-2 text-sm">
                                {quotaProviderIcon(provider.id)}
                                <span>{provider.label}</span>
                            </div>
                            {usedPercent !== undefined && (
                                <Badge variant={quotaBadgeVariant(usedPercent)}>
                                    {Math.round(usedPercent)}%
                                </Badge>
                            )}
                        </div>
                        <Text size="sm">
                            {provider.id === "openrouter"
                                ? (openRouterQuotaSummary(provider) ??
                                  quotaSummary(provider))
                                : quotaSummary(provider)}
                        </Text>
                        {provider.id === "openrouter" && (
                            <Text className="mt-1" size="sm" tone="muted">
                                {openRouterBalanceSummary(provider)}
                            </Text>
                        )}
                        {provider.resetsAtMs === undefined ||
                        windows.length > 0 ? null : (
                            <Text className="mt-1" size="sm" tone="muted">
                                Reset <QuotaResetTime resetsAtMs={provider.resetsAtMs} />
                            </Text>
                        )}
                        {windowDetails}
                    </li>
                );
            })}
        </ul>
    );
}

function QuotaOverviewCard({
    query,
}: {
    readonly query: UseQueryResult<OverviewProviderProjection<QuotaCachePayload>, Error>;
}) {
    let content: ReactNode;
    if (query.isPending && query.data === undefined) {
        content = <PageState label="Loading provider quota…" status="loading" />;
    } else if (query.data === undefined) {
        content = (
            <PageState
                headingLevel={3}
                message="The latest validated projection is not available."
                onRetry={() => void query.refetch()}
                retryBusy={query.isFetching}
                status="error"
                title="Provider quota unavailable"
            />
        );
    } else {
        content = <QuotaDetails payload={query.data.payload} />;
    }

    return (
        <Card className="min-w-0">
            <div className="mb-3 flex items-center gap-2">
                <Gauge aria-hidden="true" className="text-accent-300 size-5" />
                <Heading level={3}>Provider quota</Heading>
            </div>
            {query.error !== null && query.data !== undefined && (
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

function gitRepositoryDetail(
    repository: GitWorkspaceCachePayload["repositories"][number]
): string {
    if (repository.state === "missing") return "Repository missing";
    if (repository.state === "unavailable") return "Status unavailable";
    return `${repository.branch ?? "Detached"} · ${repository.headSha?.slice(0, 7)}`;
}

const managedGitRepositoryPresentation = Object.freeze({
    dashboard: Object.freeze({
        label: "Mira Dashboard",
        url: "https://github.com/rajohan/Mira-Dashboard",
    }),
    docker: Object.freeze({
        label: "Docker infrastructure",
        url: "https://github.com/rajohan/stremio",
    }),
    openclaw: Object.freeze({
        label: "Mira Workspace",
        url: "https://github.com/rajohan/Mira-Workspace",
    }),
});

function GitDetails({ payload }: { readonly payload: GitWorkspaceCachePayload }) {
    return (
        <ul className="space-y-2">
            {payload.repositories.map((repository) => {
                const changes = repository.changedFileCount;
                const modified = Math.max(0, changes - repository.untrackedFileCount);
                const presentation = managedGitRepositoryPresentation[repository.id];
                return (
                    <li
                        className="border-primary-700 bg-primary-900/35 flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
                        key={repository.id}
                    >
                        <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-2">
                                <GitCommitHorizontal
                                    aria-hidden="true"
                                    className="text-primary-400 size-3.5 shrink-0"
                                />
                                <ExternalLink
                                    aria-label={`Open ${presentation.label} on GitHub`}
                                    className="min-w-0 truncate text-sm font-medium"
                                    href={presentation.url}
                                >
                                    <span className="truncate">{presentation.label}</span>
                                </ExternalLink>
                            </div>
                            <Text className="truncate" size="sm" tone="muted">
                                {gitRepositoryDetail(repository)}
                            </Text>
                            {repository.state === "available" && changes > 0 ? (
                                <Text size="sm" tone="muted">
                                    {modified} modified · {repository.stagedFileCount}{" "}
                                    staged · {repository.untrackedFileCount} untracked
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
export function OverviewEnvironmentCards() {
    const client = useDashboardTrpcClient();
    const quota = useQuery(quotaOverviewQueryOptions(client));
    const git = useQuery(gitOverviewQueryOptions(client));

    return (
        <>
            <QuotaOverviewCard query={quota} />
            <ProviderCard
                icon={GitBranch}
                query={git}
                showFreshness={false}
                title="Managed Git"
            >
                {(payload) => <GitDetails payload={payload} />}
            </ProviderCard>
        </>
    );
}
