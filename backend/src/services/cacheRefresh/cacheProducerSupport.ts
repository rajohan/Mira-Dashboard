import { errorMessage as caughtErrorMessage } from "../../lib/errors.ts";
import { runProcess } from "../../lib/processes.ts";

export type JsonRecord = Record<string, unknown>;

export function dateToISOString(date: Date): string {
    return date.toISOString();
}

export function nowIso(): string {
    return dateToISOString(new Date());
}

export function errorMessage(error: unknown): string {
    return caughtErrorMessage(error, "Cache refresh failed");
}

export function toNumber(value: unknown, fallback = 0): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

export function toOptionalNumber(value: unknown): number | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value === "string" && value.trim() === "") {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

export function toOptionalString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function toOptionalFiniteNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function toCurrencyNumber(value: unknown): number | undefined {
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

export async function fetchJson(
    url: string,
    headers: Record<string, string> = {}
): Promise<unknown> {
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
        return await response.json();
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
            throw new Error(`Request timeout for ${url}`, { cause: error });
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

export function asRecord(value: unknown): JsonRecord {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as JsonRecord)
        : {};
}

export async function runCacheCommand(
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
