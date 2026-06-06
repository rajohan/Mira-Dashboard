import { execFile } from "node:child_process";
import {
    closeSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { promisify } from "node:util";

import { db } from "../db.js";

const execFileAsync = promisify(execFile);
const codexTrustConfigLocks = new Set<string>();

type CacheTtlUnit = "hours" | "minutes";
type JsonRecord = Record<string, unknown>;

interface CacheWriteOptions {
    key: string;
    data: unknown;
    source: string;
    ttl: number;
    ttlUnit: CacheTtlUnit;
    metadata: Record<string, unknown>;
}

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
];

function nowIso(): string {
    return new Date().toISOString();
}

function ttlDate(ttl: number, unit: CacheTtlUnit): string {
    const multiplier = unit === "hours" ? 60 * 60 * 1000 : 60 * 1000;
    return new Date(Date.now() + ttl * multiplier).toISOString();
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function toNumber(value: unknown, fallback = 0): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function toCurrencyNumber(value: unknown): number | null {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value !== "string") {
        return null;
    }
    const parsed = Number(value.replaceAll(/[^0-9.-]/gu, ""));
    return Number.isFinite(parsed) ? parsed : null;
}

export function writeCacheSuccess(options: CacheWriteOptions): void {
    const timestamp = nowIso();
    db.prepare(
        `INSERT INTO cache_entries (
            key, data_json, source, updated_at, last_attempt_at, expires_at,
            status, error_code, error_message, consecutive_failures, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, 'fresh', NULL, NULL, 0, ?)
         ON CONFLICT(key) DO UPDATE SET
            data_json = excluded.data_json,
            source = excluded.source,
            updated_at = excluded.updated_at,
            last_attempt_at = excluded.last_attempt_at,
            expires_at = excluded.expires_at,
            status = 'fresh',
            error_code = NULL,
            error_message = NULL,
            consecutive_failures = 0,
            metadata_json = excluded.metadata_json`
    ).run(
        options.key,
        JSON.stringify(options.data),
        options.source,
        timestamp,
        timestamp,
        ttlDate(options.ttl, options.ttlUnit),
        JSON.stringify(options.metadata)
    );
}

export function writeCacheFailure(options: CacheFailureOptions): void {
    const timestamp = nowIso();
    const existing = db
        .prepare("SELECT consecutive_failures FROM cache_entries WHERE key = ?")
        .get(options.key) as { consecutive_failures?: number } | undefined;
    db.prepare(
        `INSERT INTO cache_entries (
            key, data_json, source, updated_at, last_attempt_at, expires_at,
            status, error_code, error_message, consecutive_failures, metadata_json
         ) VALUES (?, NULL, ?, NULL, ?, ?, 'error', 'check_failed', ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
            last_attempt_at = excluded.last_attempt_at,
            expires_at = excluded.expires_at,
            status = 'error',
            error_code = excluded.error_code,
            error_message = excluded.error_message,
            consecutive_failures = excluded.consecutive_failures,
            metadata_json = excluded.metadata_json`
    ).run(
        options.key,
        options.source,
        timestamp,
        ttlDate(options.ttl, options.ttlUnit),
        errorMessage(options.error),
        Number(existing?.consecutive_failures || 0) + 1,
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
    const apiKey = process.env.MOLTBOOK_API_KEY;
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

function stringOrNull(value: unknown): string | null {
    return typeof value === "string" && value.trim() !== "" ? value : null;
}

function numberOrNull(value: unknown): number | null {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
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
                      postId: announcement.post_id ?? null,
                      title: announcement.title ?? null,
                      authorName: announcement.author_name ?? null,
                      createdAt: announcement.created_at ?? null,
                      preview: announcement.preview ?? null,
                  }
                : null,
        postsFromAccountsYouFollowCount: Array.isArray(
            data.posts_from_accounts_you_follow
        )
            ? data.posts_from_accounts_you_follow.length
            : null,
        exploreCount: Array.isArray(data.explore) ? data.explore.length : null,
        nextActions: next,
        fetchedAt: nowIso(),
    };
}

function normalizeMoltbookFeed(value: unknown, sort: "hot" | "new") {
    const data = asRecord(value);
    return {
        posts: Array.isArray(data.posts) ? data.posts : [],
        feedType: data.feed_type ?? sort,
        feedFilter: data.feed_filter ?? null,
        hasMore: Boolean(data.has_more),
        tip: data.tip ?? null,
    };
}

export async function refreshMoltbookCache(targetKey?: MoltbookCacheKey) {
    const requestedKeys = targetKey ? [targetKey] : MOLTBOOK_CACHE_KEY_LIST;
    const writes = [];

    if (requestedKeys.includes("moltbook.home")) {
        writes.push({
            key: "moltbook.home",
            data: normalizeMoltbookHome(await fetchMoltbookJson("/home")),
            metadata: { workflow: "Cache Foundation - Moltbook", kind: "home" },
        });
    }

    for (const sort of ["hot", "new"] as const) {
        const key = `moltbook.feed.${sort}` as MoltbookCacheKey;
        if (!requestedKeys.includes(key)) continue;
        writes.push({
            key,
            data: normalizeMoltbookFeed(
                await fetchMoltbookJson(`/feed?sort=${sort}&limit=25`),
                sort
            ),
            metadata: {
                workflow: "Cache Foundation - Moltbook",
                kind: "feed",
                sort,
            },
        });
    }

    if (
        requestedKeys.includes("moltbook.profile") ||
        requestedKeys.includes("moltbook.my-content")
    ) {
        const profile = asRecord(
            await fetchMoltbookJson("/agents/profile?name=mira_2026")
        );
        if (requestedKeys.includes("moltbook.profile")) {
            writes.push({
                key: "moltbook.profile",
                data: { agent: profile?.agent ?? null },
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
    return { refreshed: writes.map((item) => item.key) };
}

function openMeteoCodeToDescription(code: unknown): string {
    if (code === 0) return "Clear";
    if ([1, 2, 3].includes(Number(code))) return "Partly cloudy";
    if ([45, 48].includes(Number(code))) return "Fog";
    if ([51, 53, 55, 56, 57].includes(Number(code))) return "Drizzle";
    if ([61, 63, 65, 66, 67, 80, 81, 82].includes(Number(code))) return "Rain";
    if ([71, 73, 75, 77, 85, 86].includes(Number(code))) return "Snow";
    if ([95, 96, 99].includes(Number(code))) return "Thunderstorm";
    return "Unknown";
}

async function fetchSpydebergWeather() {
    try {
        const data = asRecord(await fetchJson(SPYDEBERG.wttrUrl));
        const current = asRecord(
            Array.isArray(data.current_condition) ? data.current_condition[0] : null
        );
        const today = asRecord(Array.isArray(data.weather) ? data.weather[0] : null);
        return {
            source: "wttr.in",
            data: {
                location: SPYDEBERG.name,
                temperatureC: current.temp_C ? Number(current.temp_C) : null,
                feelsLikeC: current.FeelsLikeC ? Number(current.FeelsLikeC) : null,
                humidityPercent: current.humidity ? Number(current.humidity) : null,
                windKph: current.windspeedKmph ? Number(current.windspeedKmph) : null,
                description:
                    asRecord(
                        Array.isArray(current.weatherDesc) ? current.weatherDesc[0] : null
                    ).value || "Unknown",
                minTempC: today.mintempC ? Number(today.mintempC) : null,
                maxTempC: today.maxtempC ? Number(today.maxtempC) : null,
                forecast: (Array.isArray(data.weather) ? data.weather : [])
                    .slice(0, 3)
                    .map((dayValue) => {
                        const day = asRecord(dayValue);
                        const hourly = asRecord(
                            Array.isArray(day.hourly) ? day.hourly[0] : null
                        );
                        return {
                            date: day.date,
                            minTempC: day.mintempC ? Number(day.mintempC) : null,
                            maxTempC: day.maxtempC ? Number(day.maxtempC) : null,
                            description:
                                asRecord(
                                    Array.isArray(hourly.weatherDesc)
                                        ? hourly.weatherDesc[0]
                                        : null
                                ).value || "Unknown",
                        };
                    }),
                fetchedAt: nowIso(),
            },
            fallbackReason: null,
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
                temperatureC: current.temperature_2m ?? null,
                feelsLikeC: current.apparent_temperature ?? null,
                humidityPercent: current.relative_humidity_2m ?? null,
                windKph: current.wind_speed_10m ?? null,
                description: openMeteoCodeToDescription(current.weather_code),
                minTempC: minTemps[0] ?? null,
                maxTempC: maxTemps[0] ?? null,
                forecast: (Array.isArray(daily.time) ? daily.time : [])
                    .slice(0, 3)
                    .map((date: string, index: number) => ({
                        date,
                        minTempC: minTemps[index] ?? null,
                        maxTempC: maxTemps[index] ?? null,
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

async function runCommand(file: string, args: string[], cwd?: string): Promise<string> {
    const { stdout } = await execFileAsync(file, args, {
        cwd,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: 90_000,
    });
    return stdout.trimEnd();
}

async function safeGit(repoPath: string, args: string[]) {
    try {
        return { ok: true, output: await runCommand("git", ["-C", repoPath, ...args]) };
    } catch (error) {
        return { ok: false, output: errorMessage(error) };
    }
}

function summarizeStatus(lines: string[]) {
    const chars = lines.map((line) => ({
        index: line[0] ?? " ",
        workTree: line[1] ?? " ",
        line,
    }));
    return {
        staged: chars.filter(({ index }) => index !== " " && index !== "?").length,
        modified: chars.filter(({ workTree }) => workTree === "M").length,
        deleted: chars.filter(({ index, workTree }) => index === "D" || workTree === "D")
            .length,
        untracked: chars.filter(({ line }) => line.startsWith("??")).length,
        renamed: chars.filter(({ index, workTree }) => index === "R" || workTree === "R")
            .length,
        conflicted: chars.filter(
            ({ index, workTree }) => index === "U" || workTree === "U"
        ).length,
        total: lines.length,
    };
}

export async function refreshGitCache() {
    const repos = [];
    for (const repo of gitRepos) {
        const inside = await safeGit(repo.path, ["rev-parse", "--is-inside-work-tree"]);
        if (!inside.ok || inside.output.trim() !== "true") {
            repos.push({
                ...repo,
                exists: false,
                dirty: false,
                error: "Not a git repository",
            });
            continue;
        }
        const [branch, head, remote, statusShort] = await Promise.all([
            safeGit(repo.path, ["branch", "--show-current"]),
            safeGit(repo.path, ["rev-parse", "HEAD"]),
            safeGit(repo.path, ["remote", "-v"]),
            safeGit(repo.path, ["status", "--short"]),
        ]);
        const porcelain = statusShort.ok
            ? statusShort.output.split("\n").filter(Boolean)
            : [];
        const statusSummary = summarizeStatus(porcelain);
        repos.push({
            ...repo,
            exists: true,
            branch: branch.ok ? branch.output || null : null,
            head: head.ok ? head.output || null : null,
            remote: remote.ok ? remote.output.split(/\s+/u)[1] || null : null,
            dirty: statusSummary.total > 0,
            statusSummary,
            statusShort: porcelain.slice(0, 25),
            statusTruncated: porcelain.length > 25,
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
    const [statusOutput, doctorOutput, securityOutput] = await Promise.all([
        runCommand(openclawBin, ["status", "--json"]),
        runCommand(openclawBin, ["doctor"]),
        runCommand(openclawBin, ["security", "audit", "--json"]),
    ]);
    const status = JSON.parse(statusOutput) as JsonRecord;
    const security = JSON.parse(securityOutput) as JsonRecord;
    const doctorWarnings = doctorOutput
        .split("\n")
        .map((line) =>
            line
                .replaceAll(new RegExp(String.raw`\u001B\[[0-9;?]*[ -/]*[@-~]`, "gu"), "")
                .trim()
        )
        .filter((line) => line.startsWith("- WARNING:"))
        .map((line) => line.replace(/^- WARNING:\s*/u, "").trim());
    const currentVersion = String(status.runtimeVersion || "unknown");
    const update = asRecord(status.update);
    const registry = asRecord(update.registry);
    const latestVersion = registry.latestVersion ? String(registry.latestVersion) : null;
    const payload = {
        version: {
            current: currentVersion,
            latest: latestVersion,
            updateAvailable: Boolean(
                currentVersion !== "unknown" &&
                latestVersion &&
                currentVersion !== latestVersion
            ),
            checkedAt: Date.now(),
        },
        gateway: status.gateway ?? null,
        gatewayService: status.gatewayService ?? null,
        nodeService: status.nodeService ?? null,
        heartbeat: status.heartbeat ?? null,
        tasks: status.tasks ?? null,
        taskAudit: status.taskAudit ?? null,
        doctorWarnings,
        doctorWarningCount: doctorWarnings.length,
        security,
        checkedAt,
    };
    writeCacheSuccess({
        key: "system.host",
        data: payload,
        source: "backend",
        ttl: 24,
        ttlUnit: "hours",
        metadata: {
            workflow: "Cache Foundation - System Checks",
            summary: {
                updateAvailable: payload.version.updateAvailable,
                doctorWarningCount: doctorWarnings.length,
            },
        },
    });
    return { refreshed: ["system.host"] };
}

function getSnapshotTime(snapshot: { endTime: string | null; startTime: string | null }) {
    return new Date(snapshot.endTime ?? snapshot.startTime ?? 0).getTime();
}

function summarizeKopiaSnapshot(value: unknown) {
    const snapshot = asRecord(value);
    const source = asRecord(snapshot.source);
    const stats = asRecord(snapshot.stats);
    return {
        id: stringOrNull(snapshot.id),
        path: stringOrNull(source.path),
        description: stringOrNull(snapshot.description),
        startTime: stringOrNull(snapshot.startTime),
        endTime: stringOrNull(snapshot.endTime),
        fileCount: numberOrNull(stats.fileCount),
        totalSize: numberOrNull(stats.totalSize),
        errorCount: numberOrNull(stats.errorCount),
        ignoredErrorCount: numberOrNull(stats.ignoredErrorCount),
        retentionReason: Array.isArray(snapshot.retentionReason)
            ? snapshot.retentionReason
            : [],
    };
}

async function refreshKopiaBackupCache() {
    const output = await runCommand(getDockerBin(), [
        "exec",
        "kopia",
        "kopia",
        "snapshot",
        "list",
        "--all",
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

    const snapshotsByPath = [...byPath.entries()]
        .sort(([pathA], [pathB]) => pathA.localeCompare(pathB))
        .map(([pathName, groupedSnapshots]) => {
            const sortedSnapshots = groupedSnapshots.sort(
                (snapshotA, snapshotB) =>
                    getSnapshotTime(snapshotB) - getSnapshotTime(snapshotA)
            );
            return {
                path: pathName,
                latest: sortedSnapshots[0],
                snapshots: sortedSnapshots,
                snapshotCount: sortedSnapshots.length,
            };
        });
    const latest = snapshotsByPath.map((group) => group.latest).filter(Boolean);
    const stale = latest
        .filter((snapshot) => {
            if (!snapshot.endTime) {
                return true;
            }
            const ageHours = (Date.now() - new Date(snapshot.endTime).getTime()) / 36e5;
            return ageHours > 30;
        })
        .map((snapshot) => ({ path: snapshot.path, endTime: snapshot.endTime }));
    const payload = {
        checkedAt: nowIso(),
        tool: "kopia",
        latest,
        snapshotsByPath,
        stale,
        ok: stale.length === 0 && latest.length > 0,
    };
    writeCacheSuccess({
        key: "backup.kopia.status",
        data: payload,
        source: "backend",
        ttl: 1,
        ttlUnit: "hours",
        metadata: {
            workflow: "Cache Foundation - Kopia Backup Status",
            summary: {
                ok: payload.ok,
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
    return {
        backupName: stringOrNull(backup.backup_name),
        modified:
            stringOrNull(backup.modified) ??
            stringOrNull(backup.finish_time) ??
            stringOrNull(backup.time),
        time: stringOrNull(backup.time),
        startTime: stringOrNull(backup.start_time),
        finishTime: stringOrNull(backup.finish_time),
        walFileName: stringOrNull(backup.wal_file_name),
        storageName: stringOrNull(backup.storage_name),
    };
}

function getWalgBackupTime(backup: { modified: string | null }) {
    return new Date(backup.modified ?? 0).getTime();
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
        .map(summarizeWalgBackup)
        .sort(
            (backupA, backupB) => getWalgBackupTime(backupB) - getWalgBackupTime(backupA)
        );

    const latest = backups[0] ?? null;
    const latestAgeHours = latest?.modified
        ? (Date.now() - new Date(latest.modified).getTime()) / 36e5
        : null;
    const stale = !latest || (latestAgeHours !== null && latestAgeHours > 30);
    const payload = {
        checkedAt: nowIso(),
        tool: "wal-g",
        latest,
        backups,
        backupCount: backups.length,
        latestAgeHours,
        stale,
        ok: !stale,
    };

    writeCacheSuccess({
        key: "backup.walg.status",
        data: payload,
        source: "backend",
        ttl: 1,
        ttlUnit: "hours",
        metadata: {
            workflow: "Cache Foundation - WAL-G Base Backup Status",
            summary: {
                ok: payload.ok,
                backupCount: payload.backupCount,
                latestBackupName: payload.latest?.backupName ?? null,
                stale: payload.stale,
                latestAgeHours: payload.latestAgeHours,
            },
        },
    });
    return { refreshed: ["backup.walg.status"] };
}

async function checkOpenRouterQuota() {
    const apiKey = process.env.OPENROUTER_API_KEY;
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
        percentUsed: totalCredits > 0 ? Math.round((usage / totalCredits) * 100) : null,
    };
}

async function checkElevenLabsQuota() {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) return { status: "not_configured" };
    const data = asRecord(
        await fetchJson("https://api.elevenlabs.io/v1/user", {
            "xi-api-key": apiKey,
        })
    );
    const subscription = asRecord(data.subscription);
    const used = toNumber(subscription.character_count);
    const total = toNumber(subscription.character_limit);
    const resetMsCandidate = Number(subscription.next_character_count_reset_unix_ms);
    const resetSecCandidate = Number(subscription.next_character_count_reset_unix);
    return {
        used,
        total,
        remaining: Math.max(total - used, 0),
        tier: subscription.tier || "unknown",
        percentUsed: total > 0 ? Math.round((used / total) * 100) : null,
        resetAt: Number.isFinite(resetMsCandidate)
            ? new Date(resetMsCandidate).toISOString()
            : Number.isFinite(resetSecCandidate)
              ? new Date(resetSecCandidate * 1000).toISOString()
              : null,
    };
}

async function checkSyntheticQuota() {
    const apiKey = process.env.SYNTHETIC_API_KEY;
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
    const weeklyNextRegenCredits = toCurrencyNumber(weeklyTokenLimit.nextRegenCredits);
    return {
        subscription: {
            limit: subscriptionLimit,
            requests: subscriptionRequests,
            remaining: Math.max(subscriptionLimit - subscriptionRequests, 0),
            renewsAt: subscription.renewsAt || null,
            percentUsed:
                subscriptionLimit > 0
                    ? Math.round((subscriptionRequests / subscriptionLimit) * 100)
                    : null,
        },
        searchHourly: {
            limit: searchHourlyLimit,
            requests: searchHourlyRequests,
            remaining: Math.max(searchHourlyLimit - searchHourlyRequests, 0),
            renewsAt: searchHourly.renewsAt || null,
            percentUsed:
                searchHourlyLimit > 0
                    ? Math.round((searchHourlyRequests / searchHourlyLimit) * 100)
                    : null,
        },
        weeklyTokenLimit: {
            percentRemaining: toNumber(weeklyTokenLimit.percentRemaining, 100),
            nextRegenAt: weeklyTokenLimit.nextRegenAt || null,
            maxCredits: weeklyTokenLimit.maxCredits || null,
            remainingCredits: weeklyTokenLimit.remainingCredits || null,
            nextRegenCredits: weeklyTokenLimit.nextRegenCredits || null,
            nextRegenPercent:
                weeklyMaxCredits && weeklyNextRegenCredits !== null
                    ? (weeklyNextRegenCredits / weeklyMaxCredits) * 100
                    : null,
        },
        rollingFiveHourLimit: {
            remaining: rollingFiveHourRemaining,
            max: rollingFiveHourMax,
            limited: Boolean(rollingFiveHourLimit.limited),
            nextTickAt: rollingFiveHourLimit.nextTickAt || null,
            tickPercent: toNumber(rollingFiveHourLimit.tickPercent, 0),
            percentUsed:
                rollingFiveHourMax > 0
                    ? Math.round(
                          ((rollingFiveHourMax - rollingFiveHourRemaining) /
                              rollingFiveHourMax) *
                              100
                      )
                    : null,
        },
    };
}

function getQuotaCodexHome() {
    return process.env.QUOTAS_CODEX_HOME || "/home/ubuntu/.codex";
}

function getOpenclawBin() {
    return process.env.OPENCLAW_BIN || "/home/ubuntu/.npm-global/bin/openclaw";
}

function getDockerBin() {
    return process.env.MIRA_DOCKER_BIN || "docker";
}

function getCodexBin() {
    return process.env.CODEX_BIN || "/home/ubuntu/.npm-global/bin/codex";
}

function ensureCodexTrustConfig(codexHome: string) {
    if (codexTrustConfigLocks.has(codexHome)) {
        return;
    }
    codexTrustConfigLocks.add(codexHome);
    const lockPath = `${codexHome}/config.toml.lock`;
    let lockHandle: number | null = null;
    try {
        mkdirSync(codexHome, { recursive: true });
        lockHandle = openSync(lockPath, "wx", 0o600);
        const configPath = `${codexHome}/config.toml`;
        let existing = "";
        try {
            existing = readFileSync(configPath, "utf8");
        } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
                throw error;
            }
        }
        const additions = CODEX_TRUSTED_DIRS.flatMap((dir) => {
            const header = `[projects.${JSON.stringify(dir)}]`;
            return existing.includes(header)
                ? []
                : [`${header}\ntrust_level = "trusted"\n`];
        });
        if (additions.length > 0) {
            const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
            const separator = existing ? "\n" : "";
            const next = `${existing}${prefix}${separator}${additions.join("\n")}`;
            const tempPath = `${configPath}.${process.pid}.tmp`;
            writeFileSync(tempPath, next, { mode: 0o600 });
            renameSync(tempPath, configPath);
        }
    } finally {
        if (lockHandle !== null) {
            closeSync(lockHandle);
            rmSync(lockPath, { force: true });
        }
        codexTrustConfigLocks.delete(codexHome);
    }
}

function stripAnsi(value: string) {
    return value
        .replaceAll(new RegExp(String.raw`\u001B\[[0-9;?]*[ -/]*[@-~]`, "gu"), "")
        .replaceAll(new RegExp(String.raw`\u001B[@-_]`, "gu"), "");
}

function cleanPanelText(value: string | undefined) {
    if (!value) return null;
    return value.replaceAll(/[│╭╮╰╯]/gu, "").trim() || null;
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
        if (index === -1) return null;
        const joined = `${lines[index]} ${lines[index + 1] || ""} ${lines[index + 2] || ""}`;
        const leftMatch = joined.match(/(\d+)%\s*left/iu);
        if (!leftMatch) return null;
        const resetMatch = joined.match(/\(resets\s*([^)]+)\)/iu);
        return {
            leftPercent: toNumber(leftMatch[1]),
            resetAt: resetMatch?.[1]?.trim() || null,
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
        ensureCodexTrustConfig(codexHome);
        const command = String.raw`set -e
SESSION="codex_quota_$$_$(date +%s)"
cleanup(){ tmux has-session -t "$SESSION" 2>/dev/null && tmux kill-session -t "$SESSION" >/dev/null 2>&1 || true; }
trap cleanup EXIT
command -v tmux >/dev/null 2>&1 || { echo "__ERR__:tmux_not_found"; exit 0; }
[ -x "$MIRA_QUOTA_CODEX_BIN" ] || { echo "__ERR__:codex_not_found"; exit 0; }
tmux new-session -d -s "$SESSION" -c /home/ubuntu/.openclaw env CODEX_HOME="$MIRA_QUOTA_CODEX_HOME" CODEX_DISABLE_UPDATE_CHECK=1 NO_UPDATE_NOTIFIER=1 "$MIRA_QUOTA_CODEX_BIN" --cd /home/ubuntu/.openclaw --no-alt-screen
sleep 1
tmux send-keys -t "$SESSION" C-u
tmux send-keys -t "$SESSION" "/status" Enter
sleep 0.4
tmux send-keys -t "$SESSION" Enter
for i in $(seq 1 20); do OUT=$(tmux capture-pane -pt "$SESSION" -S -320 || true); echo "$OUT" | grep -Eiq "5h limit:|Weekly limit:" && break; sleep 1; done
printf "%s\n" "$OUT"
`;
        const { stdout } = await execFileAsync("bash", ["-lc", command], {
            env: {
                ...process.env,
                MIRA_QUOTA_CODEX_BIN: codexPath,
                MIRA_QUOTA_CODEX_HOME: codexHome,
            },
            encoding: "utf8",
            timeout: 120_000,
            maxBuffer: 1024 * 1024,
        });
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
        openrouter.status === "not_configured" ? "openrouter" : null,
        elevenlabs.status === "not_configured" ? "elevenlabs" : null,
        synthetic.status === "not_configured" ? "synthetic" : null,
        openai.status === "not_configured" ? "openai" : null,
    ].filter(Boolean);
}

async function refreshQuotasCache() {
    const checkedAt = Date.now();
    const [openrouter, elevenlabs, synthetic, openai] = await Promise.all([
        checkOpenRouterQuota().catch((error) => ({
            status: "error",
            note: errorMessage(error),
        })),
        checkElevenLabsQuota().catch((error) => ({
            status: "error",
            note: errorMessage(error),
        })),
        checkSyntheticQuota().catch((error) => ({
            status: "error",
            note: errorMessage(error),
        })),
        checkOpenAiQuota(),
    ]);
    const payload = {
        openrouter,
        elevenlabs,
        synthetic,
        openai,
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

export async function refreshCacheProducer(key: string) {
    const refreshWithFailureRecord = async (
        refresh: () => Promise<{ refreshed: string[] }>,
        failureKeys: string[] = [key]
    ) => {
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
    };

    if (key === "moltbook") {
        return refreshWithFailureRecord(refreshMoltbookCache, [...MOLTBOOK_CACHE_KEYS]);
    }
    if (MOLTBOOK_CACHE_KEYS.has(key)) {
        return refreshWithFailureRecord(() =>
            refreshMoltbookCache(key as MoltbookCacheKey)
        );
    }
    if (key.startsWith("moltbook.")) {
        throw Object.assign(new Error(`Unsupported Moltbook cache key: ${key}`), {
            statusCode: 400,
        });
    }
    if (key === "weather.spydeberg") {
        return refreshWithFailureRecord(refreshWeatherCache);
    }
    if (key === "git.workspace") {
        return refreshWithFailureRecord(refreshGitCache);
    }
    if (key === "system.host") {
        return refreshWithFailureRecord(refreshSystemCache);
    }
    if (key === "backup.kopia.status") {
        return refreshWithFailureRecord(refreshKopiaBackupCache);
    }
    if (key === "backup.walg.status") {
        return refreshWithFailureRecord(refreshWalgBackupCache);
    }
    if (key === "quotas.summary") {
        return refreshWithFailureRecord(refreshQuotasCache);
    }
    throw Object.assign(
        new Error(`No backend refresh producer configured for cache key: ${key}`),
        {
            statusCode: 400,
        }
    );
}

export const __testing = {
    checkElevenLabsQuota,
    checkOpenAiQuota,
    checkOpenRouterQuota,
    checkSyntheticQuota,
    buildQuotaMissingProviders,
    cleanPanelText,
    codexTrustConfigLocks,
    ensureCodexTrustConfig,
    errorMessage,
    fetchSpydebergWeather,
    getSnapshotTime,
    getWalgBackupTime,
    getDockerBin,
    getOpenclawBin,
    getCodexBin,
    getQuotaCodexHome,
    normalizeMoltbookFeed,
    normalizeMoltbookHome,
    openMeteoCodeToDescription,
    parseOpenAiQuotaOutput,
    summarizeKopiaSnapshot,
    summarizeStatus,
    summarizeWalgBackup,
    toCurrencyNumber,
};
