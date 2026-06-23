import { type Stats } from "node:fs";
import {
    type FileHandle,
    mkdir,
    open,
    rename,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import os from "node:os";

import { database } from "../database.ts";
import { runProcess } from "../lib/processes.ts";
import { nonEmptyEnvironmentFallback } from "../lib/values.ts";
import { writeCacheSuccess } from "./cacheEntryWriter.ts";
import {
    getScheduledJob,
    registerScheduledJobAction,
    removeScheduledJobsNotInAction,
    type ScheduledJob,
    upsertScheduledJob,
} from "./scheduledJobs.ts";

function dateToISOString(date: Date): string {
    return date.toISOString();
}

function dateGetTime(date: Date): number {
    return date.getTime();
}

const codexTrustConfigLocks = new Map<string, Promise<void>>();
const CODEX_TRUST_LOCK_TIMEOUT_MS = 5000;
const CODEX_TRUST_LOCK_RETRY_MS = 100;
const CODEX_TRUST_STALE_LOCK_MS = 5 * 60 * 1000;
const KOPIA_EXPECTED_SOURCE_PATHS = [
    "/source/docker",
    "/source/projects",
    "/source/openclaw",
] as const;
const BACKUP_STATUS_STALE_HOURS = 30;
const BACKUP_STATUS_MAX_TTL_HOURS = 25;

type JsonRecord = Record<string, unknown>;
type CacheTtlUnit = "hours" | "minutes";

interface CacheFailureOptions {
    key: string;
    source: string;
    ttl: number;
    ttlUnit: CacheTtlUnit;
    error: unknown;
    metadata: Record<string, unknown>;
}

const MOLTBOOK_API = "https://www.moltbook.com/api/v1";
const SPYDEBERG = {
    name: "Spydeberg",
    wttrUrl: "https://wttr.in/Spydeberg?format=j1",
    openMeteoUrl:
        "https://api.open-meteo.com/v1/forecast?latitude=59.62&longitude=11.08&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=Europe%2FOslo&forecast_days=3",
};
const CODEX_TRUSTED_DIRS = [
    "/home/ubuntu/.openclaw",
    "/home/ubuntu/projects",
    "/home/ubuntu/projects/mira-dashboard",
];
const MOLTBOOK_CACHE_KEY_LIST = [
    "moltbook.home",
    "moltbook.feed.hot",
    "moltbook.feed.new",
    "moltbook.profile",
    "moltbook.my-content",
] as const;
type MoltbookCacheKey = (typeof MOLTBOOK_CACHE_KEY_LIST)[number];
const MOLTBOOK_CACHE_KEYS = new Set<string>(MOLTBOOK_CACHE_KEY_LIST);
const LOG_ROTATION_STATE_KEY = "log_rotation.state";

const gitRepos = [
    {
        key: "openclaw",
        name: ".openclaw",
        path: "/home/ubuntu/.openclaw",
        category: "workspace",
    },
    {
        key: "mira-dashboard",
        name: "mira-dashboard",
        path: "/home/ubuntu/projects/mira-dashboard",
        category: "project",
    },
    {
        key: "docker",
        name: "docker",
        path: "/opt/docker",
        category: "infra",
    },
    {
        key: "n8n",
        name: "n8n",
        path: "/home/ubuntu/projects/n8n",
        category: "project",
    },
];

function nowIso(): string {
    return dateToISOString(new Date());
}

function ttlDate(ttl: number, unit: CacheTtlUnit): string {
    const multiplier = 60 * 1000 * (unit === "hours" ? 60 : 1);
    return dateToISOString(new Date(Date.now() + ttl * multiplier));
}

function backupStatusTtlHours(timestamps: Array<string | undefined>): number {
    let ttl = BACKUP_STATUS_MAX_TTL_HOURS;
    const now = Date.now();
    for (const timestamp of timestamps) {
        if (!timestamp) {
            continue;
        }
        const timeMs = dateGetTime(new Date(timestamp));
        if (!Number.isFinite(timeMs)) {
            continue;
        }
        const remainingHours =
            BACKUP_STATUS_STALE_HOURS - Math.max(0, (now - timeMs) / 36e5);
        ttl = Math.min(ttl, Math.max(0, remainingHours));
    }
    return ttl;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function toNumber(value: unknown, fallback = 0): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function toOptionalNumber(value: unknown): number | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value === "string" && value.trim() === "") {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function toOptionalString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function toOptionalFiniteNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toCurrencyNumber(value: unknown): number | undefined {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value !== "string") {
        return undefined;
    }
    const cleaned = value.replaceAll(/[^0-9.-]/gu, "");
    if (cleaned === "" || !/\d/u.test(cleaned)) {
        return undefined;
    }
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

type CodexTrustConfigFileHandle = Pick<FileHandle, "close">;

type AsyncCodexTrustConfigLockDependencies = {
    now?: () => number;
    open?: (
        path: string,
        flags: string,
        mode: number
    ) => Promise<CodexTrustConfigFileHandle>;
    remove?: typeof rm;
    rename?: typeof rename;
    sleep?: typeof sleep;
    stat?: typeof stat;
};

function isSameFileStat(left: Stats, right: Stats): boolean {
    return (
        left.mtimeMs === right.mtimeMs && left.dev === right.dev && left.ino === right.ino
    );
}

async function acquireCodexTrustConfigLockAsync(
    lockPath: string,
    dependencies: AsyncCodexTrustConfigLockDependencies = {}
): Promise<CodexTrustConfigFileHandle> {
    const now = dependencies.now ?? Date.now;
    const openFile = dependencies.open ?? open;
    const removeFile = dependencies.remove ?? rm;
    const renameFile = dependencies.rename ?? rename;
    const sleepFor = dependencies.sleep ?? sleep;
    const statFile = dependencies.stat ?? stat;
    const startedAt = now();
    let isStaleRecoveryAttempted = false;
    for (;;) {
        try {
            return await openFile(lockPath, "wx", 0o600);
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
                throw error;
            }
            const elapsedMs = now() - startedAt;
            if (elapsedMs < CODEX_TRUST_LOCK_TIMEOUT_MS) {
                await sleepFor(CODEX_TRUST_LOCK_RETRY_MS);
                continue;
            }
            if (!isStaleRecoveryAttempted) {
                isStaleRecoveryAttempted = true;
                try {
                    const lockStat = await statFile(lockPath);
                    if (now() - lockStat.mtimeMs > CODEX_TRUST_STALE_LOCK_MS) {
                        const reclaimedPath = `${lockPath}.reclaimed.${process.pid}`;
                        try {
                            await renameFile(lockPath, reclaimedPath);
                            const reclaimedStat = await statFile(reclaimedPath);
                            if (isSameFileStat(lockStat, reclaimedStat)) {
                                await removeFile(reclaimedPath, { force: true });
                                continue;
                            }
                            try {
                                if (
                                    isSameFileStat(
                                        lockStat,
                                        await statFile(reclaimedPath)
                                    )
                                ) {
                                    await renameFile(reclaimedPath, lockPath);
                                }
                            } catch {
                                // Best effort: preserve the live lock path if a newer owner won.
                            }
                        } catch (renameError) {
                            if (
                                renameError instanceof Error &&
                                "code" in renameError &&
                                renameError.code === "ENOENT"
                            ) {
                                continue;
                            }
                        }
                        throw error;
                    }
                } catch (statError) {
                    if (
                        statError instanceof Error &&
                        "code" in statError &&
                        statError.code === "ENOENT"
                    ) {
                        continue;
                    }
                    throw statError;
                }
            }
            throw error;
        }
    }
}

export { writeCacheSuccess } from "./cacheEntryWriter.ts";

export function writeCacheFailure(options: CacheFailureOptions): void {
    const timestamp = nowIso();
    database
        .prepare(
            `INSERT INTO cache_entries (
            key, data_json, source, updated_at, last_attempt_at, expires_at,
            status, error_code, error_message, consecutive_failures, metadata_json
         ) VALUES (?, NULL, ?, ?, ?, ?, 'error', 'check_failed', ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
            last_attempt_at = excluded.last_attempt_at,
            expires_at = excluded.expires_at,
            status = 'error',
            error_code = excluded.error_code,
            error_message = excluded.error_message,
            consecutive_failures = COALESCE(cache_entries.consecutive_failures, 0) + 1,
            metadata_json = excluded.metadata_json`
        )
        .run(
            options.key,
            options.source,
            timestamp,
            timestamp,
            ttlDate(options.ttl, options.ttlUnit),
            errorMessage(options.error),
            1,
            JSON.stringify({ ...options.metadata, lastFailureAt: timestamp })
        );
}

async function fetchJson(url: string, headers: Record<string, string> = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                Accept: "application/json",
                "User-Agent": "mira-dashboard-cache/1.0",
                ...headers,
            },
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} for ${url}`);
        }
        return (await response.json()) as unknown;
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
            throw new Error(`Request timeout for ${url}`, { cause: error });
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchMoltbookJson(path: string) {
    const apiKey = process.env.MOLTBOOK_API_KEY?.trim();
    if (!apiKey) {
        throw new Error("MOLTBOOK_API_KEY is not configured");
    }
    return fetchJson(`${MOLTBOOK_API}${path}`, {
        Authorization: `Bearer ${apiKey}`,
    });
}

function asRecord(value: unknown): JsonRecord {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as JsonRecord)
        : {};
}

function normalizeMoltbookHome(value: unknown) {
    const data = asRecord(value);
    const dm = asRecord(data.your_direct_messages);
    const activity = Array.isArray(data.activity_on_your_posts)
        ? data.activity_on_your_posts
        : [];
    const next = Array.isArray(data.what_to_do_next) ? data.what_to_do_next : [];
    const announcement = asRecord(data.latest_moltbook_announcement);
    return {
        pendingRequestCount: toNumber(dm.pending_request_count),
        unreadMessageCount: toNumber(dm.unread_message_count),
        activityOnYourPostsCount: activity.length,
        activityOnYourPosts: activity.slice(0, 10),
        latestAnnouncement:
            Object.keys(announcement).length > 0
                ? {
                      postId: announcement.post_id ?? undefined,
                      title: announcement.title ?? undefined,
                      authorName: announcement.author_name ?? undefined,
                      createdAt: announcement.created_at ?? undefined,
                      previewText:
                          announcement.preview ?? announcement.isPreview ?? undefined,
                  }
                : undefined,
        postsFromAccountsYouFollowCount: Array.isArray(
            data.posts_from_accounts_you_follow
        )
            ? data.posts_from_accounts_you_follow.length
            : undefined,
        exploreCount: Array.isArray(data.explore) ? data.explore.length : undefined,
        nextActions: next,
        fetchedAt: nowIso(),
    };
}

function normalizeMoltbookFeed(value: unknown, sort: "hot" | "new") {
    const data = asRecord(value);
    return {
        posts: Array.isArray(data.posts) ? data.posts : [],
        feedType: data.feed_type ?? sort,
        feedFilter: data.feed_filter ?? undefined,
        hasMore: Boolean(data.has_more),
        tip: data.tip ?? undefined,
    };
}

type MoltbookFetchTask =
    | { kind: "home"; promise: Promise<unknown> }
    | {
          kind: "feed";
          key: MoltbookCacheKey;
          sort: "hot" | "new";
          promise: Promise<unknown>;
      }
    | { kind: "profile"; promise: Promise<unknown> };

function createMoltbookRefreshError(
    message: string,
    options: { cause: unknown; failedKeys: MoltbookCacheKey[] }
): Error & { failedKeys: MoltbookCacheKey[] } {
    return Object.assign(new Error(message, { cause: options.cause }), {
        failedKeys: options.failedKeys,
    });
}

function failedKeysForMoltbookTask(
    task: MoltbookFetchTask,
    requestedKeys: readonly MoltbookCacheKey[]
): MoltbookCacheKey[] {
    if (task.kind === "home") {
        return ["moltbook.home"];
    }
    if (task.kind === "feed") {
        return [task.key];
    }
    return ["moltbook.profile", "moltbook.my-content"].filter((key) =>
        requestedKeys.includes(key as MoltbookCacheKey)
    ) as MoltbookCacheKey[];
}

function getMoltbookFailureKeys(error: unknown): MoltbookCacheKey[] | undefined {
    const failedKeys = asRecord(error).failedKeys;
    return Array.isArray(failedKeys) ? (failedKeys as MoltbookCacheKey[]) : undefined;
}

export async function refreshMoltbookCache(targetKey?: MoltbookCacheKey) {
    const requestedKeys = targetKey ? [targetKey] : MOLTBOOK_CACHE_KEY_LIST;
    const writes: Array<{
        key: MoltbookCacheKey;
        data: unknown;
        metadata: Record<string, unknown>;
    }> = [];
    const tasks: MoltbookFetchTask[] = [];
    const failedKeys = new Set<MoltbookCacheKey>();

    if (requestedKeys.includes("moltbook.home")) {
        tasks.push({ kind: "home", promise: fetchMoltbookJson("/home") });
    }

    for (const sort of ["hot", "new"] as const) {
        const key = `moltbook.feed.${sort}` as MoltbookCacheKey;
        if (!requestedKeys.includes(key)) continue;
        tasks.push({
            kind: "feed",
            key,
            sort,
            promise: fetchMoltbookJson(`/feed?sort=${sort}&limit=25`),
        });
    }

    if (
        requestedKeys.includes("moltbook.profile") ||
        requestedKeys.includes("moltbook.my-content")
    ) {
        tasks.push({
            kind: "profile",
            promise: fetchMoltbookJson("/agents/profile?name=mira_2026"),
        });
    }

    const results = await Promise.allSettled(
        tasks.map(async (task) => {
            try {
                return { task, value: await task.promise };
            } catch (error) {
                throw { task, error };
            }
        })
    );
    let firstFailure: unknown;
    for (const result of results) {
        if (result.status === "rejected") {
            const failed = result.reason as {
                error: unknown;
                task: MoltbookFetchTask;
            };
            firstFailure ??= failed.error;
            for (const failedKey of failedKeysForMoltbookTask(
                failed.task,
                requestedKeys
            )) {
                failedKeys.add(failedKey);
            }
            continue;
        }
        const { task, value } = result.value;

        if (task.kind === "home") {
            writes.push({
                key: "moltbook.home",
                data: normalizeMoltbookHome(value),
                metadata: { workflow: "Cache Foundation - Moltbook", kind: "home" },
            });
            continue;
        }

        if (task.kind === "feed") {
            writes.push({
                key: task.key,
                data: normalizeMoltbookFeed(value, task.sort),
                metadata: {
                    workflow: "Cache Foundation - Moltbook",
                    kind: "feed",
                    sort: task.sort,
                },
            });
            continue;
        }

        const profile = asRecord(value);
        if (requestedKeys.includes("moltbook.profile")) {
            writes.push({
                key: "moltbook.profile",
                data: { agent: profile.agent ?? undefined },
                metadata: { workflow: "Cache Foundation - Moltbook", kind: "profile" },
            });
        }
        if (requestedKeys.includes("moltbook.my-content")) {
            writes.push({
                key: "moltbook.my-content",
                data: {
                    posts: Array.isArray(profile.recentPosts) ? profile.recentPosts : [],
                    comments: Array.isArray(profile.recentComments)
                        ? profile.recentComments
                        : [],
                },
                metadata: { workflow: "Cache Foundation - Moltbook", kind: "my-content" },
            });
        }
    }

    if (writes.length === 0 && firstFailure !== undefined) {
        throw createMoltbookRefreshError(
            `Moltbook refresh failed: ${errorMessage(firstFailure)}`,
            {
                cause: firstFailure,
                failedKeys: [...failedKeys],
            }
        );
    }

    database.run("SAVEPOINT moltbook_cache_write");
    try {
        for (const item of writes) {
            writeCacheSuccess({
                key: item.key,
                data: item.data,
                source: "moltbook-api",
                ttl: 30,
                ttlUnit: "minutes",
                metadata: item.metadata,
            });
        }
        database.run("RELEASE SAVEPOINT moltbook_cache_write");
    } catch (error) {
        database.run("ROLLBACK TO SAVEPOINT moltbook_cache_write");
        database.run("RELEASE SAVEPOINT moltbook_cache_write");
        throw error;
    }
    if (firstFailure !== undefined) {
        throw createMoltbookRefreshError("Moltbook refresh had sub-request failures", {
            cause: firstFailure,
            failedKeys: [...failedKeys],
        });
    }
    return { refreshed: writes.map((item) => item.key) };
}

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
        const minTemps = Array.isArray(daily.temperature_2m_min)
            ? daily.temperature_2m_min
            : [];
        const maxTemps = Array.isArray(daily.temperature_2m_max)
            ? daily.temperature_2m_max
            : [];
        const weatherCodes = Array.isArray(daily.weather_code) ? daily.weather_code : [];
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
                forecast: (Array.isArray(daily.time) ? daily.time : [])
                    .slice(0, 3)
                    .map((date: string, index: number) => ({
                        date,
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

async function runCommand(
    file: string,
    arguments_: string[],
    cwd?: string
): Promise<string> {
    const { code, stderr, stdout } = await runProcess(file, arguments_, {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
        timeoutMs: 90_000,
    });
    if (code !== 0) {
        throw new Error(
            `${file} ${arguments_.join(" ")} failed with exit code ${code}: ${
                stderr.trim() || stdout.trim()
            }`
        );
    }
    return stdout.trimEnd();
}

function latestOpenClawVersionFromUpdateStatus(value: unknown): string | undefined {
    const updateStatus = asRecord(value);
    const availability = asRecord(updateStatus.availability);
    const update = asRecord(updateStatus.update);
    const registry = asRecord(update.registry);
    return (
        toOptionalString(availability.latestVersion) ||
        toOptionalString(registry.latestVersion)
    );
}

function getDockerBin(): string {
    return nonEmptyEnvironmentFallback("MIRA_DOCKER_BIN", "docker");
}

async function safeGit(repoPath: string, arguments_: string[]) {
    try {
        return {
            isOk: true,
            output: await runCommand("git", ["-C", repoPath, ...arguments_]),
        };
    } catch (error) {
        return { isOk: false, output: errorMessage(error) };
    }
}

function summarizeStatus(lines: string[]) {
    const chars = lines.map((line) => ({
        index: line[0] ?? " ",
        workTree: line[1] ?? " ",
        line,
    }));
    const unmergedStatuses = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
    return {
        staged: chars.filter(
            ({ index, workTree }) =>
                index !== " " &&
                index !== "?" &&
                !unmergedStatuses.has(`${index}${workTree}`)
        ).length,
        modified: chars.filter(({ workTree }) => workTree === "M").length,
        deleted: chars.filter(({ index, workTree }) => index === "D" || workTree === "D")
            .length,
        untracked: chars.filter(({ line }) => line.startsWith("??")).length,
        renamed: chars.filter(({ index, workTree }) => index === "R" || workTree === "R")
            .length,
        conflicted: chars.filter(
            ({ index, workTree }) =>
                unmergedStatuses.has(`${index}${workTree}`) ||
                index === "U" ||
                workTree === "U"
        ).length,
        total: lines.length,
    };
}

function emptyStatusSummary(): ReturnType<typeof summarizeStatus> {
    return summarizeStatus([]);
}

function sanitizeRemoteUrl(value: string | undefined): string | undefined {
    if (!value) {
        return undefined;
    }
    try {
        const url = new URL(value);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.href;
    } catch {
        const withoutQuery = value.replace(/\?.*$/u, "");
        const scpStyleMatch = withoutQuery.match(/^([^@\s]+)@([^:\s]+:.+)$/u);
        if (scpStyleMatch) {
            return scpStyleMatch[2];
        }
        return withoutQuery.replace(/\/\/[^/@\s]+@/u, "//");
    }
}

export async function refreshGitCache() {
    const repos = [];
    for (const repo of gitRepos) {
        const inside = await safeGit(repo.path, ["rev-parse", "--is-inside-work-tree"]);
        if (!inside.isOk) {
            repos.push({
                ...repo,
                exists: false,
                dirty: false,
                error: inside.output,
                statusSummary: emptyStatusSummary(),
            });
            continue;
        }
        if (inside.output.trim() !== "true") {
            repos.push({
                ...repo,
                exists: false,
                dirty: false,
                error: "Not a git repository",
                statusSummary: emptyStatusSummary(),
            });
            continue;
        }
        const [branch, head, remote, statusShort] = await Promise.all([
            safeGit(repo.path, ["branch", "--show-current"]),
            safeGit(repo.path, ["rev-parse", "HEAD"]),
            safeGit(repo.path, ["remote", "-v"]),
            safeGit(repo.path, ["status", "--short"]),
        ]);
        const porcelain = statusShort.isOk
            ? statusShort.output.split("\n").filter(Boolean)
            : [];
        const statusSummary = statusShort.isOk
            ? summarizeStatus(porcelain)
            : emptyStatusSummary();
        const isDirty = statusShort.isOk ? statusSummary.total > 0 : true;
        repos.push({
            ...repo,
            exists: true,
            branch: branch.isOk ? branch.output || undefined : undefined,
            head: head.isOk ? head.output || undefined : undefined,
            remote: remote.isOk
                ? sanitizeRemoteUrl(remote.output.split(/\s+/u, 2)[1] || undefined)
                : undefined,
            dirty: isDirty,
            statusSummary,
            statusShort: porcelain.slice(0, 25),
            statusTruncated: porcelain.length > 25,
            ...(!statusShort.isOk && { statusError: statusShort.output }),
            checkedAt: nowIso(),
        });
    }
    const dirtyRepos = repos.filter((repo) => repo.dirty).map((repo) => repo.key);
    const missingRepos = repos
        .filter((repo) => repo.exists === false)
        .map((repo) => repo.key);
    const payload = {
        repos,
        dirtyRepos,
        dirtyCount: dirtyRepos.length,
        missingRepos,
        checkedAt: nowIso(),
    };
    writeCacheSuccess({
        key: "git.workspace",
        data: payload,
        source: "backend",
        ttl: 24,
        ttlUnit: "hours",
        metadata: {
            workflow: "Cache Foundation - Git Workspace",
            summary: {
                repoCount: repos.length,
                dirtyCount: dirtyRepos.length,
                dirtyRepos,
                missingRepos,
            },
        },
    });
    return { refreshed: ["git.workspace"] };
}

async function refreshSystemCache() {
    const openclawBin = getOpenclawBin();
    const checkedAt = nowIso();
    const [statusResult, updateStatusResult, doctorResult, securityResult, hostResult] =
        await Promise.allSettled([
            runCommand(openclawBin, ["status", "--json"]),
            runCommand(openclawBin, ["update", "status", "--json"]),
            runCommand(openclawBin, ["doctor"]),
            runCommand(openclawBin, ["security", "audit", "--json"]),
            getHostSummary(),
        ]);
    let statusError =
        statusResult.status === "rejected"
            ? errorMessage(statusResult.reason)
            : undefined;
    let statusFailure: unknown =
        statusResult.status === "rejected" ? statusResult.reason : undefined;
    let status: JsonRecord = {};
    if (statusResult.status === "fulfilled") {
        try {
            status = JSON.parse(statusResult.value) as JsonRecord;
        } catch (error) {
            statusError = errorMessage(error);
            statusFailure = error;
            console.warn("[CacheRefresh] Failed to parse OpenClaw status JSON:", error);
        }
    }
    const doctorError =
        doctorResult.status === "rejected"
            ? errorMessage(doctorResult.reason)
            : undefined;
    let securityError =
        securityResult.status === "rejected"
            ? errorMessage(securityResult.reason)
            : undefined;
    let security: JsonRecord | undefined;
    if (securityResult.status === "fulfilled") {
        try {
            security = JSON.parse(securityResult.value) as JsonRecord;
        } catch (error) {
            securityError = errorMessage(error);
            console.warn(
                "[CacheRefresh] Failed to parse OpenClaw security audit JSON:",
                error
            );
        }
    }
    const doctorWarnings =
        doctorResult.status === "fulfilled"
            ? doctorResult.value
                  .split("\n")
                  .map((line) =>
                      line
                          .replaceAll(
                              new RegExp(String.raw`\u001B\[[0-9;?]*[ -/]*[@-~]`, "gu"),
                              ""
                          )
                          .trim()
                  )
                  .filter((line) => line.startsWith("- WARNING:"))
                  .map((line) => line.replace(/^- WARNING:\s*/u, "").trim())
            : [];
    const currentVersion = String(status.runtimeVersion || "unknown");
    const update = asRecord(status.update);
    const registry = asRecord(update.registry);
    let updateStatusError =
        updateStatusResult.status === "rejected"
            ? errorMessage(updateStatusResult.reason)
            : undefined;
    let updateStatus: JsonRecord = {};
    if (updateStatusResult.status === "fulfilled") {
        try {
            updateStatus = JSON.parse(updateStatusResult.value) as JsonRecord;
        } catch (error) {
            updateStatusError = errorMessage(error);
            console.warn(
                "[CacheRefresh] Failed to parse OpenClaw update status JSON:",
                error
            );
        }
    }
    const latestVersion =
        latestOpenClawVersionFromUpdateStatus(updateStatus) ||
        toOptionalString(registry.latestVersion);
    const version = {
        current: currentVersion,
        latest: latestVersion,
        updateAvailable: Boolean(
            currentVersion !== "unknown" &&
            latestVersion &&
            currentVersion !== latestVersion
        ),
        checkedAt: Date.now(),
    };
    const host =
        hostResult.status === "fulfilled"
            ? hostResult.value
            : buildFallbackHostSummary(checkedAt);
    const hostPayload = {
        ...host,
        version: {
            ...version,
            hostError:
                hostResult.status === "rejected"
                    ? errorMessage(hostResult.reason)
                    : undefined,
            openclawError: statusError,
            updateStatusError,
        },
        checkedAt,
    };
    if (statusError) {
        writeCacheFailure({
            key: "system.openclaw",
            source: "backend",
            ttl: 15,
            ttlUnit: "minutes",
            error: statusFailure,
            metadata: {
                workflow: "Cache Foundation - System Checks",
                kind: "openclaw",
            },
        });
    } else {
        const openclawPayload = {
            version,
            updateStatus,
            gateway: status.gateway ?? undefined,
            gatewayService: status.gatewayService ?? undefined,
            nodeService: status.nodeService ?? undefined,
            heartbeat: status.heartbeat ?? undefined,
            tasks: status.tasks ?? undefined,
            taskAudit: status.taskAudit ?? undefined,
            doctorWarnings,
            doctorError,
            doctorWarningCount: doctorWarnings.length,
            security,
            securityError,
            updateStatusError,
            checkedAt,
        };
        writeCacheSuccess({
            key: "system.openclaw",
            data: openclawPayload,
            source: "backend",
            ttl: 24,
            ttlUnit: "hours",
            metadata: {
                workflow: "Cache Foundation - System Checks",
                kind: "openclaw",
                summary: {
                    updateAvailable: version.updateAvailable,
                    doctorWarningCount: doctorWarnings.length,
                },
            },
        });
    }
    writeCacheSuccess({
        key: "system.host",
        data: hostPayload,
        source: "backend",
        ttl: 24,
        ttlUnit: "hours",
        metadata: {
            workflow: "Cache Foundation - System Checks",
            kind: "host",
            summary: {
                diskPercent: host.disk.percent,
                memoryFreeMb: host.memory.freeMb,
                uptimeSeconds: host.uptimeSeconds,
            },
        },
    });
    return { refreshed: ["system.openclaw", "system.host"] };
}

function firstValidTimestamp(value: string | undefined): number {
    if (!value) {
        return 0;
    }
    const parsed = dateGetTime(new Date(value));
    return Number.isFinite(parsed) ? parsed : 0;
}

function firstValidTimestampValue(
    ...values: Array<string | undefined>
): string | undefined {
    return values.find((value) => firstValidTimestamp(value) > 0) ?? undefined;
}

function summarizeKopiaSnapshot(value: unknown) {
    const snapshot = asRecord(value);
    const source = asRecord(snapshot.source);
    const stats = asRecord(snapshot.stats);
    return {
        id: toOptionalString(snapshot.id),
        path: toOptionalString(source.path),
        description: toOptionalString(snapshot.description),
        startTime: toOptionalString(snapshot.startTime),
        endTime: toOptionalString(snapshot.endTime),
        fileCount: toOptionalFiniteNumber(stats.fileCount),
        totalSize: toOptionalFiniteNumber(stats.totalSize),
        errorCount: toOptionalFiniteNumber(stats.errorCount),
        ignoredErrorCount: toOptionalFiniteNumber(stats.ignoredErrorCount),
        retentionReason: Array.isArray(snapshot.retentionReason)
            ? snapshot.retentionReason
            : [],
    };
}

function getSnapshotTime(snapshot: {
    endTime: string | undefined;
    startTime: string | undefined;
}) {
    return firstValidTimestamp(
        firstValidTimestampValue(snapshot.endTime, snapshot.startTime)
    );
}

async function refreshKopiaBackupCache() {
    const output = await runCommand(getDockerBin(), [
        "exec",
        "kopia",
        "kopia",
        "snapshot",
        "list",
        "--all",
        "--json-verbose",
        "--json",
    ]);
    const snapshots = JSON.parse(output || "[]") as unknown[];
    const byPath = new Map<string, ReturnType<typeof summarizeKopiaSnapshot>[]>();
    for (const snapshot of snapshots) {
        const summarized = summarizeKopiaSnapshot(snapshot);
        if (!summarized.path) {
            continue;
        }
        const grouped = byPath.get(summarized.path) ?? [];
        grouped.push(summarized);
        byPath.set(summarized.path, grouped);
    }

    const snapshotsByPath = [...byPath]
        .toSorted(([pathA], [pathB]) => pathA.localeCompare(pathB))
        .map(([pathName, groupedSnapshots]) => {
            const sortedSnapshots = groupedSnapshots.toSorted(
                (snapshotA, snapshotB) =>
                    getSnapshotTime(snapshotB) - getSnapshotTime(snapshotA)
            );
            const latestSnapshot = sortedSnapshots[0];
            return {
                path: pathName,
                latest: latestSnapshot,
                snapshots: sortedSnapshots,
                snapshotCount: sortedSnapshots.length,
            };
        });
    const latest = snapshotsByPath
        .map((group) => group.latest)
        .filter(
            (snapshot): snapshot is ReturnType<typeof summarizeKopiaSnapshot> =>
                snapshot !== undefined
        );
    const staleSnapshots = latest
        .filter((snapshot) => {
            if (!snapshot.endTime) {
                return true;
            }
            const endTimeMs = dateGetTime(new Date(snapshot.endTime));
            if (!Number.isFinite(endTimeMs)) {
                return true;
            }
            const ageHours = (Date.now() - endTimeMs) / 36e5;
            return ageHours > BACKUP_STATUS_STALE_HOURS;
        })
        .map((snapshot) => ({ path: snapshot.path, endTime: snapshot.endTime }));
    const missingSources = KOPIA_EXPECTED_SOURCE_PATHS.filter(
        (pathName) => !byPath.has(pathName)
    )
        .toSorted((pathA, pathB) => pathA.localeCompare(pathB))
        .map((pathName) => ({ path: pathName, endTime: undefined, missing: true }));
    const stale = [...staleSnapshots, ...missingSources];
    const payload = {
        checkedAt: nowIso(),
        tool: "kopia",
        latest,
        snapshotsByPath,
        stale,
        isOk: stale.length === 0 && latest.length >= KOPIA_EXPECTED_SOURCE_PATHS.length,
    };
    writeCacheSuccess({
        key: "backup.kopia.status",
        data: payload,
        source: "backend",
        ttl: payload.isOk
            ? backupStatusTtlHours(payload.latest.map((snapshot) => snapshot.endTime))
            : BACKUP_STATUS_MAX_TTL_HOURS,
        ttlUnit: "hours",
        metadata: {
            workflow: "Cache Foundation - Kopia Backup Status",
            summary: {
                isOk: payload.isOk,
                snapshotCount: payload.latest.length,
                staleCount: payload.stale.length,
                stalePaths: payload.stale.map((item) => item.path),
            },
        },
    });
    return { refreshed: ["backup.kopia.status"] };
}

function summarizeWalgBackup(value: unknown) {
    const backup = asRecord(value);
    const modified = firstValidTimestampValue(
        toOptionalString(backup.finish_time),
        toOptionalString(backup.start_time),
        toOptionalString(backup.time),
        toOptionalString(backup.modified)
    );
    const freshnessTime = firstValidTimestampValue(
        toOptionalString(backup.finish_time),
        toOptionalString(backup.start_time),
        toOptionalString(backup.time)
    );
    return {
        backupName: toOptionalString(backup.backup_name),
        modified,
        time: toOptionalString(backup.time),
        startTime: toOptionalString(backup.start_time),
        finishTime: toOptionalString(backup.finish_time),
        freshnessTime: freshnessTime ?? modified,
        walFileName: toOptionalString(backup.wal_file_name),
        storageName: toOptionalString(backup.storage_name),
    };
}

function getWalgBackupTime(backup: { freshnessTime: string | undefined }) {
    return firstValidTimestamp(backup.freshnessTime);
}

async function refreshWalgBackupCache() {
    const output = await runCommand(getDockerBin(), [
        "exec",
        "walg",
        "wal-g",
        "backup-list",
        "--detail",
        "--json",
    ]);
    const backups = (JSON.parse(output || "[]") as unknown[])
        .map((backup) => summarizeWalgBackup(backup))
        .toSorted(
            (backupA, backupB) => getWalgBackupTime(backupB) - getWalgBackupTime(backupA)
        );

    const latest = backups[0] ?? undefined;
    const latestFreshnessMs = latest?.freshnessTime
        ? dateGetTime(new Date(latest.freshnessTime))
        : NaN;
    const latestAgeHours = Number.isFinite(latestFreshnessMs)
        ? (Date.now() - latestFreshnessMs) / 36e5
        : undefined;
    const isStale =
        !latest ||
        latestAgeHours === undefined ||
        latestAgeHours > BACKUP_STATUS_STALE_HOURS;
    const payload = {
        checkedAt: nowIso(),
        tool: "wal-g",
        latest,
        backups,
        backupCount: backups.length,
        latestAgeHours,
        stale: isStale,
        isOk: !isStale,
    };

    writeCacheSuccess({
        key: "backup.walg.status",
        data: payload,
        source: "backend",
        ttl: payload.isOk
            ? backupStatusTtlHours([payload.latest?.freshnessTime])
            : BACKUP_STATUS_MAX_TTL_HOURS,
        ttlUnit: "hours",
        metadata: {
            workflow: "Cache Foundation - WAL-G Base Backup Status",
            summary: {
                isOk: payload.isOk,
                backupCount: payload.backupCount,
                latestBackupName: payload.latest?.backupName ?? undefined,
                stale: payload.stale,
                latestAgeHours: payload.latestAgeHours,
            },
        },
    });
    return { refreshed: ["backup.walg.status"] };
}

async function checkOpenRouterQuota() {
    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) return { status: "not_configured" };
    const [keyInfo, creditsInfo] = await Promise.all([
        fetchJson("https://openrouter.ai/api/v1/key", {
            Authorization: `Bearer ${apiKey}`,
        }) as Promise<JsonRecord>,
        fetchJson("https://openrouter.ai/api/v1/credits", {
            Authorization: `Bearer ${apiKey}`,
        }) as Promise<JsonRecord>,
    ]);
    const usage = toNumber(asRecord(keyInfo.data).usage);
    const totalCredits = toNumber(asRecord(creditsInfo.data).total_credits);
    return {
        usage,
        totalCredits,
        remaining: Math.max(totalCredits - usage, 0),
        usageMonthly: toNumber(asRecord(keyInfo.data).usage_monthly),
        percentUsed:
            totalCredits > 0 ? Math.round((usage / totalCredits) * 100) : undefined,
    };
}

async function checkElevenLabsQuota() {
    const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
    if (!apiKey) return { status: "not_configured" };
    const data = asRecord(
        await fetchJson("https://api.elevenlabs.io/v1/user", {
            "xi-api-key": apiKey,
        })
    );
    const subscription = asRecord(data.subscription);
    const used = toNumber(subscription.character_count);
    const total = toNumber(subscription.character_limit);
    const resetMsCandidate = toOptionalNumber(
        subscription.next_character_count_reset_unix_ms
    );
    const resetSecCandidate = toOptionalNumber(
        subscription.next_character_count_reset_unix
    );
    return {
        used,
        total,
        remaining: Math.max(total - used, 0),
        tier: subscription.tier || "unknown",
        percentUsed: total > 0 ? Math.round((used / total) * 100) : undefined,
        resetAt:
            resetMsCandidate !== undefined && resetMsCandidate > 0
                ? dateToISOString(new Date(resetMsCandidate))
                : resetSecCandidate !== undefined && resetSecCandidate > 0
                  ? dateToISOString(new Date(resetSecCandidate * 1000))
                  : undefined,
    };
}

async function checkSyntheticQuota() {
    const apiKey = process.env.SYNTHETIC_API_KEY?.trim();
    if (!apiKey) return { status: "not_configured" };
    const data = asRecord(
        await fetchJson("https://api.synthetic.new/v2/quotas", {
            Authorization: `Bearer ${apiKey}`,
        })
    );
    const subscription = asRecord(data.subscription);
    const search = asRecord(data.search);
    const searchHourly = asRecord(search.hourly);
    const weeklyTokenLimit = asRecord(data.weeklyTokenLimit);
    const rollingFiveHourLimit = asRecord(data.rollingFiveHourLimit);
    const subscriptionLimit = toNumber(subscription.limit);
    const subscriptionRequests = toNumber(subscription.requests);
    const searchHourlyLimit = toNumber(searchHourly.limit);
    const searchHourlyRequests = toNumber(searchHourly.requests);
    const rollingFiveHourMax = toNumber(rollingFiveHourLimit.max);
    const rollingFiveHourRemaining = toNumber(rollingFiveHourLimit.remaining);
    const weeklyMaxCredits = toCurrencyNumber(weeklyTokenLimit.maxCredits);
    const weeklyRemainingCredits = toCurrencyNumber(weeklyTokenLimit.remainingCredits);
    const weeklyNextRegenCredits = toCurrencyNumber(weeklyTokenLimit.nextRegenCredits);
    const explicitWeeklyPercentRemaining = toOptionalNumber(
        weeklyTokenLimit.percentRemaining
    );
    const computedWeeklyPercentRemaining =
        weeklyMaxCredits && weeklyRemainingCredits !== undefined
            ? (weeklyRemainingCredits / weeklyMaxCredits) * 100
            : undefined;
    const weeklyPercentRemaining =
        explicitWeeklyPercentRemaining ?? computedWeeklyPercentRemaining;
    if (weeklyPercentRemaining === undefined) {
        return {
            status: "error",
            note: "Synthetic weekly token percentage missing",
        };
    }
    return {
        subscription: {
            limit: subscriptionLimit,
            requests: subscriptionRequests,
            remaining: Math.max(subscriptionLimit - subscriptionRequests, 0),
            renewsAt: subscription.renewsAt || undefined,
            percentUsed:
                subscriptionLimit > 0
                    ? Math.round((subscriptionRequests / subscriptionLimit) * 100)
                    : undefined,
        },
        searchHourly: {
            limit: searchHourlyLimit,
            requests: searchHourlyRequests,
            remaining: Math.max(searchHourlyLimit - searchHourlyRequests, 0),
            renewsAt: searchHourly.renewsAt || undefined,
            percentUsed:
                searchHourlyLimit > 0
                    ? Math.round((searchHourlyRequests / searchHourlyLimit) * 100)
                    : undefined,
        },
        weeklyTokenLimit: {
            percentRemaining: weeklyPercentRemaining,
            nextRegenAt: weeklyTokenLimit.nextRegenAt || undefined,
            maxCredits: weeklyTokenLimit.maxCredits || undefined,
            remainingCredits: weeklyTokenLimit.remainingCredits || undefined,
            nextRegenCredits: weeklyTokenLimit.nextRegenCredits || undefined,
            nextRegenPercent:
                weeklyMaxCredits && weeklyNextRegenCredits !== undefined
                    ? (weeklyNextRegenCredits / weeklyMaxCredits) * 100
                    : undefined,
        },
        rollingFiveHourLimit: {
            remaining: rollingFiveHourRemaining,
            max: rollingFiveHourMax,
            limited: Boolean(rollingFiveHourLimit.limited),
            nextTickAt: rollingFiveHourLimit.nextTickAt || undefined,
            tickPercent: toNumber(rollingFiveHourLimit.tickPercent, 0),
            percentUsed:
                rollingFiveHourMax > 0
                    ? Math.round(
                          ((rollingFiveHourMax - rollingFiveHourRemaining) /
                              rollingFiveHourMax) *
                              100
                      )
                    : undefined,
        },
    };
}

function getQuotaCodexHome() {
    return nonEmptyEnvironmentFallback("QUOTAS_CODEX_HOME", "/home/ubuntu/.codex");
}

function getOpenclawBin() {
    return nonEmptyEnvironmentFallback(
        "OPENCLAW_BIN",
        "/home/ubuntu/.npm-global/bin/openclaw"
    );
}

async function getHostSummary() {
    let disk = {
        totalBytes: 0,
        usedBytes: 0,
        percent: 0,
    };
    try {
        const output = await runCommand("df", ["-B1", "/"]);
        const line = output.trim().split("\n").at(-1)!;
        const parts = line.trim().split(/\s+/u);
        disk = {
            totalBytes: toNumber(parts[1]),
            usedBytes: toNumber(parts[2]),
            percent: toNumber(String(parts[4] ?? "0").replace("%", "")),
        };
    } catch (error) {
        console.warn("[CacheRefresh] Failed to read host disk summary:", error);
    }

    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    return {
        hostname: os.hostname(),
        platform: os.platform(),
        uptimeSeconds: os.uptime(),
        disk,
        memory: {
            totalBytes: totalMemory,
            usedBytes: totalMemory - freeMemory,
            freeBytes: freeMemory,
            freeMb: Math.round(freeMemory / 1024 / 1024),
        },
        checkedAt: nowIso(),
    };
}

function buildFallbackHostSummary(checkedAt: string) {
    return {
        hostname: os.hostname(),
        platform: os.platform(),
        uptimeSeconds: os.uptime(),
        disk: { totalBytes: 0, usedBytes: 0, percent: 0 },
        memory: {
            totalBytes: os.totalmem(),
            usedBytes: os.totalmem() - os.freemem(),
            freeBytes: os.freemem(),
            freeMb: Math.round(os.freemem() / 1024 / 1024),
        },
        checkedAt,
    };
}

function getCodexBin() {
    return nonEmptyEnvironmentFallback("CODEX_BIN", "/home/ubuntu/.npm-global/bin/codex");
}

async function ensureCodexTrustConfig(codexHome: string) {
    const existing = codexTrustConfigLocks.get(codexHome);
    if (existing) {
        await existing;
        return;
    }
    const update = updateCodexTrustConfig(codexHome);
    codexTrustConfigLocks.set(codexHome, update);
    try {
        await update;
    } finally {
        codexTrustConfigLocks.delete(codexHome);
    }
}

async function updateCodexTrustConfig(codexHome: string) {
    const lockPath = `${codexHome}/config.toml.lock`;
    let lockHandle: CodexTrustConfigFileHandle | undefined;
    try {
        await mkdir(codexHome, { recursive: true });
        lockHandle = await acquireCodexTrustConfigLockAsync(lockPath);
        const configPath = `${codexHome}/config.toml`;
        let existing = "";
        try {
            existing = await Bun.file(configPath).text();
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
                throw error;
            }
        }
        let next = existing;
        const additions = CODEX_TRUSTED_DIRS.flatMap((directory) => {
            const header = `[projects.${JSON.stringify(directory)}]`;
            const normalizedConfig = ensureCodexTrustedSection(next, header);
            if (normalizedConfig === undefined) {
                return [`${header}\ntrust_level = "trusted"\n`];
            }
            next = normalizedConfig;
            return [];
        });
        if (additions.length > 0) {
            const prefix = next && !next.endsWith("\n") ? "\n" : "";
            const separator = next ? "\n" : "";
            next += `${prefix}${separator}${additions.join("\n")}`;
        }
        if (next !== existing) {
            const temporaryPath = `${configPath}.${process.pid}.tmp`;
            await writeFile(temporaryPath, next, { mode: 0o600 });
            await rename(temporaryPath, configPath);
        }
    } finally {
        if (lockHandle !== undefined) {
            await lockHandle.close();
            await rm(lockPath, { force: true });
        }
    }
}

function ensureCodexTrustedSection(config: string, header: string) {
    const lines = config.split("\n");
    const headerIndex = lines.findIndex((line) => line.trim() === header);
    if (headerIndex === -1) {
        return;
    }
    const nextHeaderIndex = lines.findIndex(
        (line, index) => index > headerIndex && /^\s*\[.*\]\s*$/u.test(line)
    );
    const sectionEndIndex = nextHeaderIndex === -1 ? lines.length : nextHeaderIndex;
    const trustLevelIndex = lines.findIndex(
        (line, index) =>
            index > headerIndex &&
            index < sectionEndIndex &&
            /^\s*trust_level\s*=/u.test(line)
    );
    if (trustLevelIndex === -1) {
        lines.splice(headerIndex + 1, 0, 'trust_level = "trusted"');
    } else if (lines[trustLevelIndex] !== 'trust_level = "trusted"') {
        lines[trustLevelIndex] = 'trust_level = "trusted"';
    }
    return lines.join("\n");
}

function stripAnsi(value: string) {
    return value
        .replaceAll(new RegExp(String.raw`\u001B\[[0-9;?]*[ -/]*[@-~]`, "gu"), "")
        .replaceAll(new RegExp(String.raw`\u001B[@-_]`, "gu"), "");
}

function cleanPanelText(value: string | undefined) {
    if (!value) return;
    return value.replaceAll(/[│╭╮╰╯]/gu, "").trim() || undefined;
}

function parseOpenAiQuotaOutput(output: string) {
    if (output.includes("__ERR__:tmux_not_found")) {
        return { status: "error", note: "tmux not found" };
    }
    if (output.includes("__ERR__:codex_not_found")) {
        return { status: "not_configured", note: "codex binary not found" };
    }
    function parseLimit(prefix: string) {
        const lines = output
            .split("\n")
            .map((line) => line.replaceAll(/[│╭╮╰╯]/gu, "").trim())
            .filter(Boolean);
        const index = lines.findIndex((line) =>
            line.toLowerCase().includes(prefix.toLowerCase())
        );
        if (index === -1) return;
        const joined = `${lines[index]} ${lines[index + 1] || ""} ${lines[index + 2] || ""}`;
        const leftMatch = joined.match(/(\d+)%\s*left/iu);
        if (!leftMatch) return;
        const resetMatch = joined.match(/\(resets\s*([^)]+)\)/iu);
        return {
            leftPercent: toNumber(leftMatch[1]),
            resetAt: resetMatch?.[1]?.trim() || undefined,
        };
    }
    const fiveHour = parseLimit("5h limit:");
    const weekly = parseLimit("weekly limit:");
    if (!fiveHour || !weekly) {
        return { status: "error", note: "Could not parse Codex /status output" };
    }
    return {
        account: cleanPanelText(output.match(/Account:\s*(.+)/iu)?.[1]),
        model: cleanPanelText(output.match(/Model:\s*(.+?)(?:\s*\(|$)/iu)?.[1]),
        fiveHourLeftPercent: fiveHour.leftPercent,
        weeklyLeftPercent: weekly.leftPercent,
        fiveHourReset: fiveHour.resetAt,
        weeklyReset: weekly.resetAt,
        percentUsed: Math.max(
            100 - Math.min(fiveHour.leftPercent, weekly.leftPercent),
            0
        ),
        resetAt: weekly.resetAt,
    };
}

async function checkOpenAiQuota() {
    try {
        const codexPath = getCodexBin();
        const codexHome = getQuotaCodexHome();
        await ensureCodexTrustConfig(codexHome);
        const command = String.raw`set -e
SESSION="codex_quota_$$_$(date +%s)"
cleanup(){ tmux has-session -t "$SESSION" 2>/dev/null && tmux kill-session -t "$SESSION" >/dev/null 2>&1 || true; }
trap cleanup EXIT
command -v tmux >/dev/null 2>&1 || { echo "__ERR__:tmux_not_found"; exit 0; }
if [[ "$MIRA_QUOTA_CODEX_BIN" == */* ]]; then
  [ -x "$MIRA_QUOTA_CODEX_BIN" ] || { echo "__ERR__:codex_not_found"; exit 0; }
else
  command -v "$MIRA_QUOTA_CODEX_BIN" >/dev/null 2>&1 || {
    echo "__ERR__:codex_not_found"
    exit 0
  }
fi
tmux new-session -d -s "$SESSION" -c /home/ubuntu/.openclaw env CODEX_HOME="$MIRA_QUOTA_CODEX_HOME" CODEX_DISABLE_UPDATE_CHECK=1 NO_UPDATE_NOTIFIER=1 "$MIRA_QUOTA_CODEX_BIN" --cd /home/ubuntu/.openclaw --no-alt-screen
	OUT=""
	has_limits(){ echo "$OUT" | grep -Eiq "5h limit:" && echo "$OUT" | grep -Eiq "Weekly limit:"; }
	for i in $(seq 1 12); do
	  tmux send-keys -t "$SESSION" C-u
	  tmux send-keys -t "$SESSION" "/status" Enter
	  sleep 0.5
	  OUT=$(tmux capture-pane -pt "$SESSION" -S -320 || true)
	  has_limits && break
	done
	for i in $(seq 1 20); do OUT=$(tmux capture-pane -pt "$SESSION" -S -320 || true); has_limits && break; sleep 1; done
	printf "%s\n" "$OUT"
	`;
        const { code, stderr, stdout } = await runProcess("bash", ["-c", command], {
            env: {
                PATH: process.env.PATH,
                NODE_ENV: process.env.NODE_ENV,
                MIRA_QUOTA_CODEX_BIN: codexPath,
                MIRA_QUOTA_CODEX_HOME: codexHome,
            },
            timeoutMs: 120_000,
            maxBuffer: 1024 * 1024,
        });
        if (code !== 0) {
            const output = stripAnsi(`${stderr}\n${stdout}`)
                .replaceAll("\r", "")
                .trim()
                .slice(-1000);
            return {
                status: "error",
                note: `codex quota exited ${code}${output ? `: ${output}` : ""}`,
            };
        }
        const output = stripAnsi(stdout).replaceAll("\r", "");
        return parseOpenAiQuotaOutput(output);
    } catch (error) {
        return { status: "error", note: errorMessage(error) };
    }
}

function buildQuotaMissingProviders(
    openrouter: Record<string, unknown>,
    elevenlabs: Record<string, unknown>,
    synthetic: Record<string, unknown>,
    openai: Record<string, unknown>
) {
    return [
        openrouter.status === "not_configured" ? "openrouter" : undefined,
        elevenlabs.status === "not_configured" ? "elevenlabs" : undefined,
        synthetic.status === "not_configured" ? "synthetic" : undefined,
        openai.status === "not_configured" ? "openai" : undefined,
    ].filter(Boolean);
}

async function checkQuotaWithErrorStatus<T>(
    checkQuota: () => Promise<T>
): Promise<T | { status: "error"; note: string }> {
    try {
        return await checkQuota();
    } catch (error) {
        return {
            status: "error",
            note: errorMessage(error),
        };
    }
}

async function refreshQuotasCache() {
    const checkedAt = Date.now();
    const [openrouter, elevenlabs, synthetic, openai] = await Promise.all([
        checkQuotaWithErrorStatus(checkOpenRouterQuota),
        checkQuotaWithErrorStatus(checkElevenLabsQuota),
        checkQuotaWithErrorStatus(checkSyntheticQuota),
        checkOpenAiQuota(),
    ]);
    const payload = {
        openrouter,
        elevenlabs,
        synthetic,
        openai: redactOpenAiQuotaAccount(openai),
        checkedAt,
        cacheAgeMs: 0,
    };
    writeCacheSuccess({
        key: "quotas.summary",
        data: payload,
        source: "backend",
        ttl: 1,
        ttlUnit: "hours",
        metadata: {
            workflow: "Cache Foundation - Quotas Summary",
            producers: ["openrouter", "elevenlabs", "synthetic", "openai"],
            missing: buildQuotaMissingProviders(
                openrouter,
                elevenlabs,
                synthetic,
                openai
            ),
        },
    });
    return { refreshed: ["quotas.summary"] };
}

async function refreshLogRotationStateCache() {
    const row = database
        .prepare("SELECT data_json FROM cache_entries WHERE key = ? LIMIT 1")
        .get(LOG_ROTATION_STATE_KEY) as undefined | { data_json?: string | undefined };
    let data: unknown = { version: 1, files: {} };
    let isPreserveExistingData = false;
    if (row?.data_json) {
        try {
            data = JSON.parse(row.data_json) as unknown;
            isPreserveExistingData = true;
        } catch {
            data = { version: 1, files: {} };
        }
    } else {
        isPreserveExistingData = true;
    }
    writeCacheSuccess({
        key: LOG_ROTATION_STATE_KEY,
        data,
        source: "backend",
        ttl: 90 * 24,
        ttlUnit: "hours",
        metadata: {
            producer: "refreshCacheProducer",
            workflow: "Log Rotation - Foundation",
        },
        preserveExistingData: isPreserveExistingData,
    });
    return { refreshed: [LOG_ROTATION_STATE_KEY] };
}

function redactOpenAiQuotaAccount(openai: Awaited<ReturnType<typeof checkOpenAiQuota>>) {
    if (!openai || typeof openai !== "object" || !("account" in openai)) {
        return openai;
    }
    const { account, ...redacted } = openai;
    void account;
    return redacted;
}

const inFlightCacheRefreshes = new Map<string, Promise<{ refreshed: string[] }>>();

function cacheRefreshScopeKey(key: string): string {
    if (key === "moltbook") {
        return "moltbook";
    }
    if (key === "system.openclaw") {
        return "system.host";
    }
    return key;
}

function isSupportedCacheProducerKey(key: string): boolean {
    return (
        key === "moltbook" ||
        MOLTBOOK_CACHE_KEYS.has(key) ||
        key === "weather.spydeberg" ||
        key === "git.workspace" ||
        key === "system.openclaw" ||
        key === "system.host" ||
        key === "backup.kopia.status" ||
        key === "backup.walg.status" ||
        key === "quotas.summary" ||
        key === LOG_ROTATION_STATE_KEY
    );
}

async function refreshCacheWithFailureRecord(
    key: string,
    refresh: () => Promise<{ refreshed: string[] }>,
    failureKeys: string[] = [key]
) {
    try {
        return await refresh();
    } catch (error) {
        for (const failureKey of failureKeys) {
            writeCacheFailure({
                key: failureKey,
                source: "backend",
                ttl: 15,
                ttlUnit: "minutes",
                error,
                metadata: {
                    producer: "refreshCacheProducer",
                },
            });
        }
        throw error;
    }
}

async function refreshCacheProducerUnlocked(key: string) {
    if (key === "moltbook") {
        try {
            return await refreshMoltbookCache();
        } catch (error) {
            const failureKeys = getMoltbookFailureKeys(error) ?? [
                ...MOLTBOOK_CACHE_KEY_LIST,
            ];
            for (const failureKey of failureKeys) {
                writeCacheFailure({
                    key: failureKey,
                    source: "backend",
                    ttl: 15,
                    ttlUnit: "minutes",
                    error,
                    metadata: {
                        producer: "refreshCacheProducer",
                    },
                });
            }
            throw error;
        }
    }
    if (MOLTBOOK_CACHE_KEYS.has(key)) {
        return refreshCacheWithFailureRecord(key, () =>
            refreshMoltbookCache(key as MoltbookCacheKey)
        );
    }
    if (key.startsWith("moltbook.")) {
        throw Object.assign(new Error(`Unsupported Moltbook cache key: ${key}`), {
            statusCode: 400,
        });
    }
    if (key === "weather.spydeberg") {
        return refreshCacheWithFailureRecord(key, refreshWeatherCache);
    }
    if (key === "git.workspace") {
        return refreshCacheWithFailureRecord(key, refreshGitCache);
    }
    if (key === "system.host" || key === "system.openclaw") {
        return refreshCacheWithFailureRecord(key, refreshSystemCache, [
            "system.openclaw",
            "system.host",
        ]);
    }
    if (key === "backup.kopia.status") {
        return refreshCacheWithFailureRecord(key, refreshKopiaBackupCache);
    }
    if (key === "backup.walg.status") {
        return refreshCacheWithFailureRecord(key, refreshWalgBackupCache);
    }
    if (key === "quotas.summary") {
        return refreshCacheWithFailureRecord(key, refreshQuotasCache);
    }
    if (key === LOG_ROTATION_STATE_KEY) {
        return refreshCacheWithFailureRecord(key, refreshLogRotationStateCache);
    }
    throw Object.assign(
        new Error(`No backend refresh producer configured for cache key: ${key}`),
        {
            statusCode: 400,
        }
    );
}

function abortError(): Error {
    const error = new Error("Cache refresh aborted");
    Object.defineProperty(error, "name", {
        configurable: true,
        value: "AbortError",
    });
    return error;
}

async function waitForRefreshWithSignal<T>(
    refresh: Promise<T>,
    signal: AbortSignal | undefined
): Promise<T> {
    if (!signal) {
        return await refresh;
    }
    if (signal.aborted) {
        throw abortError();
    }
    return await Promise.race([
        refresh,
        new Promise<never>((_resolve, reject) => {
            const onAbort = () => reject(abortError());
            signal.addEventListener("abort", onAbort, { once: true });
            void (async () => {
                try {
                    await refresh;
                } catch {
                    // The refresh result is observed by the race winner.
                } finally {
                    signal.removeEventListener("abort", onAbort);
                }
            })();
        }),
    ]);
}

async function waitForExistingRefresh(
    requestedKey: string,
    scopeKey: string,
    refresh: Promise<{ refreshed: string[] }>,
    signal: AbortSignal | undefined
): Promise<{ refreshed: string[] }> {
    try {
        return await waitForRefreshWithSignal(refresh, signal);
    } catch (error) {
        const failedKeys = getMoltbookFailureKeys(error);
        if (
            failedKeys &&
            MOLTBOOK_CACHE_KEYS.has(scopeKey) &&
            failedKeys.length > 0 &&
            !failedKeys.includes(scopeKey as MoltbookCacheKey)
        ) {
            return { refreshed: [requestedKey] };
        }
        throw error;
    }
}

export async function refreshCacheProducer(
    key: string,
    signal?: AbortSignal,
    options: { force?: boolean } = {}
) {
    if (signal?.aborted) {
        throw abortError();
    }
    const scopeKey = cacheRefreshScopeKey(key);
    const inFlightEntries = isSupportedCacheProducerKey(key)
        ? [...inFlightCacheRefreshes]
        : [];
    const existing = inFlightEntries
        .filter(
            ([inFlightKey]) =>
                inFlightKey === scopeKey || scopeKey.startsWith(`${inFlightKey}.`)
        )
        .toSorted(([left], [right]) => left.length - right.length)[0]?.[1];
    if (!options.force && existing !== undefined) {
        return await waitForExistingRefresh(key, scopeKey, existing, signal);
    }
    const childRefreshes = inFlightEntries
        .filter(([inFlightKey]) =>
            options.force
                ? inFlightKey === scopeKey ||
                  inFlightKey.startsWith(`${scopeKey}.`) ||
                  scopeKey.startsWith(`${inFlightKey}.`)
                : inFlightKey.startsWith(`${scopeKey}.`)
        )
        .map(([, refresh]) => refresh);
    const refresh =
        childRefreshes.length > 0
            ? refreshAfterChildRefreshes(childRefreshes, key)
            : refreshCacheProducerUnlocked(key);
    inFlightCacheRefreshes.set(scopeKey, refresh);
    void (async () => {
        try {
            await refresh;
        } catch {
            // The caller observes refresh failures.
        } finally {
            if (inFlightCacheRefreshes.get(scopeKey) === refresh) {
                inFlightCacheRefreshes.delete(scopeKey);
            }
        }
    })();
    return await waitForRefreshWithSignal(refresh, signal);
}

async function refreshAfterChildRefreshes(
    childRefreshes: Array<Promise<{ refreshed: string[] }>>,
    key: string
): Promise<{ refreshed: string[] }> {
    await Promise.allSettled(childRefreshes);
    return await refreshCacheProducerUnlocked(key);
}

const cacheRefreshScheduledJobs = [
    {
        id: "cache.weather",
        name: "Weather cache",
        description: "Refresh Spydeberg weather cache.",
        scheduleType: "interval",
        intervalSeconds: 60 * 60,
        actionKey: "cache.refresh",
        actionPayload: { key: "weather.spydeberg" },
    },
    {
        id: "cache.quotas",
        name: "Quota cache",
        description: "Refresh provider quota summaries.",
        scheduleType: "interval",
        intervalSeconds: 30 * 60,
        actionKey: "cache.refresh",
        actionPayload: { key: "quotas.summary" },
    },
    {
        id: "cache.system",
        name: "System cache",
        description: "Refresh host and OpenClaw system checks.",
        scheduleType: "daily",
        intervalSeconds: 24 * 60 * 60,
        timeOfDay: "02:50",
        actionKey: "cache.refresh",
        actionPayload: { key: "system.host" },
    },
    {
        id: "cache.git",
        name: "Git cache",
        description: "Refresh workspace git status cache.",
        scheduleType: "daily",
        intervalSeconds: 24 * 60 * 60,
        timeOfDay: "02:40",
        actionKey: "cache.refresh",
        actionPayload: { key: "git.workspace" },
    },
    {
        id: "cache.moltbook",
        name: "Moltbook cache",
        description: "Refresh Moltbook home, feeds, profile, and own content caches.",
        scheduleType: "interval",
        intervalSeconds: 30 * 60,
        actionKey: "cache.refresh",
        actionPayload: { key: "moltbook" },
    },
    {
        id: "cache.backup.kopia",
        name: "Kopia backup status cache",
        description: "Refresh Kopia backup status cache.",
        scheduleType: "interval",
        intervalSeconds: 60 * 60,
        actionKey: "cache.refresh",
        actionPayload: { key: "backup.kopia.status" },
    },
    {
        id: "cache.backup.walg",
        name: "WAL-G backup status cache",
        description: "Refresh WAL-G backup status cache.",
        scheduleType: "interval",
        intervalSeconds: 60 * 60,
        actionKey: "cache.refresh",
        actionPayload: { key: "backup.walg.status" },
    },
] as const;

function getScheduledCacheKey(job: ScheduledJob): string {
    const key = job.actionPayload.key;
    if (typeof key !== "string" || key.trim() === "") {
        throw Object.assign(
            new Error(`Scheduled cache job ${job.id} is missing actionPayload.key`),
            { statusCode: 400 }
        );
    }
    return key;
}

function isCacheEntryFresh(key: string): boolean {
    const keys =
        key === "moltbook"
            ? MOLTBOOK_CACHE_KEY_LIST
            : key === "system.host" || key === "system.openclaw"
              ? ["system.openclaw", "system.host"]
              : [key];
    const statement = database.prepare(
        "SELECT status, expires_at FROM cache_entries WHERE key = ? LIMIT 1"
    );
    return keys.every((cacheKey) => {
        const row = statement.get(cacheKey) as
            | undefined
            | { status: string; expires_at: string };
        if (!row || row.status !== "fresh") {
            return false;
        }
        const expiresAtMs = row.expires_at === "" ? NaN : Date.parse(row.expires_at);
        return Number.isFinite(expiresAtMs) && expiresAtMs > Date.now();
    });
}

const localCacheSeedPromises = new Map<string, Promise<void>>();

export function waitForLocalCacheSeed(key: string): Promise<void> {
    return localCacheSeedPromises.get(key) ?? Promise.resolve();
}

export function seedMissingLocalCacheEntry(key: string): void {
    if (isCacheEntryFresh(key)) {
        return;
    }
    const seedPromise = (async () => {
        try {
            await refreshCacheProducer(key);
        } catch (error) {
            console.warn(
                `[CacheRefresh] Failed to seed missing cache entry ${key}:`,
                error
            );
            throw error;
        }
    })();
    localCacheSeedPromises.set(key, seedPromise);
    void (async () => {
        try {
            await seedPromise;
        } catch {
            // Cache seeding is best-effort for callers that do not await it.
        } finally {
            if (localCacheSeedPromises.get(key) === seedPromise) {
                localCacheSeedPromises.delete(key);
            }
        }
    })();
}

export function registerCacheRefreshScheduledJobs(): void {
    registerScheduledJobAction("cache.refresh", async (job, signal) => {
        const key = getScheduledCacheKey(job);
        const result = await refreshCacheProducer(key, signal);
        return { key, ...result };
    });
    const seedKeys: string[] = [];
    database.run("BEGIN");
    try {
        removeScheduledJobsNotInAction(
            "cache.refresh",
            cacheRefreshScheduledJobs.map((job) => job.id)
        );

        for (const job of cacheRefreshScheduledJobs) {
            const existing = getScheduledJob(job.id);
            upsertScheduledJob({
                ...job,
                enabled: existing?.enabled ?? true,
                scheduleType: existing?.scheduleType ?? job.scheduleType,
                intervalSeconds: existing?.intervalSeconds ?? job.intervalSeconds,
                timeOfDay: existing
                    ? existing.timeOfDay
                    : "timeOfDay" in job && typeof job.timeOfDay === "string"
                      ? job.timeOfDay
                      : undefined,
                cronExpression:
                    existing?.cronExpression ??
                    ("cronExpression" in job && typeof job.cronExpression === "string"
                        ? job.cronExpression
                        : undefined),
            });
            if (existing?.enabled ?? true) {
                seedKeys.push(job.actionPayload.key);
            }
        }
        database.run("COMMIT");
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch {
            // Preserve the original transaction failure.
        }
        throw error;
    }
    for (const key of seedKeys) {
        seedMissingLocalCacheEntry(key);
    }
}
