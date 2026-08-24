import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { CloudSun, GitBranch, Gauge } from "lucide-react";
import type { ReactNode } from "react";

import type { GitWorkspaceCachePayload } from "../../contracts/gitWorkspace.ts";
import type {
    QuotaCachePayload,
    QuotaProviderProjection,
} from "../../contracts/quota.ts";
import type { WeatherCachePayload } from "../../contracts/weather.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import {
    formatDashboardDateTime,
    formatDashboardDateTimeToMinute,
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
        <Card className="min-w-0">
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
    return `${Math.round(value)} °C`;
}

function WeatherDetails({ payload }: { readonly payload: WeatherCachePayload }) {
    return (
        <div>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <Text as="span" className="text-primary-50 text-3xl font-semibold">
                    {formatTemperature(payload.temperatureC)}
                </Text>
                <Text as="span" tone="muted">
                    Feels like {formatTemperature(payload.apparentTemperatureC)}
                </Text>
            </div>
            <Text className="mt-2 capitalize">
                {payload.condition} · {Math.round(payload.humidityPercent)}% humidity ·{" "}
                {Math.round(payload.windKilometresPerHour)} km/h wind
            </Text>
            <ul className="mt-4 grid grid-cols-3 gap-2">
                {payload.forecast.map((day) => (
                    <li className="bg-primary-900/45 rounded-lg p-2" key={day.date}>
                        <Text size="sm" tone="muted">
                            {day.date}
                        </Text>
                        <Text className="mt-1 capitalize" size="sm">
                            {day.condition}
                        </Text>
                        <Text className="mt-1" size="sm">
                            {formatTemperature(day.minimumTemperatureC)}–
                            {formatTemperature(day.maximumTemperatureC)}
                        </Text>
                    </li>
                ))}
            </ul>
        </div>
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
                                {windows.map((window) => (
                                    <li
                                        className="flex flex-wrap justify-between gap-x-3 gap-y-1"
                                        key={`${window.windowDurationMinutes}:${window.resetsAtMs}`}
                                    >
                                        <Text as="span" size="sm" tone="muted">
                                            {quotaWindowDuration(
                                                window.windowDurationMinutes
                                            )}
                                        </Text>
                                        <Text as="span" size="sm">
                                            {Math.round(window.usedPercent)}% used ·
                                            resets{" "}
                                            <QuotaResetTime
                                                resetsAtMs={window.resetsAtMs}
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

/** @returns Independent weather, quota, and managed-Git overview cards. */
export function OverviewEnvironmentSection() {
    const client = useDashboardTrpcClient();
    const weather = useQuery(weatherOverviewQueryOptions(client));
    const quota = useQuery(quotaOverviewQueryOptions(client));
    const git = useQuery(gitOverviewQueryOptions(client));

    return (
        <section aria-labelledby="environment-overview-heading">
            <Heading id="environment-overview-heading" level={2}>
                Environment
            </Heading>
            <Text className="mt-1" tone="muted">
                Weather, provider limits, and managed repository state from independent
                background checks.
            </Text>
            <div className="mt-5 grid gap-5 lg:grid-cols-3">
                <ProviderCard
                    description="Current conditions and three-day forecast for Spydeberg."
                    icon={CloudSun}
                    query={weather}
                    title="Weather"
                >
                    {(payload) => <WeatherDetails payload={payload} />}
                </ProviderCard>
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
