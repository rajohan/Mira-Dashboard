import type { LogLine } from "../../contracts/logs.ts";

export const filterableLogLevels = [
    "trace",
    "debug",
    "info",
    "warn",
    "error",
    "fatal",
] as const satisfies readonly LogLine["severity"][];

export type FilterableLogLevel = (typeof filterableLogLevels)[number];

export function allLogLevels(): ReadonlySet<FilterableLogLevel> {
    return new Set(filterableLogLevels);
}

export function logLevelIsVisible(
    level: LogLine["severity"],
    activeLevels: ReadonlySet<FilterableLogLevel>
): boolean {
    if (level === "unknown") return activeLevels.size === filterableLogLevels.length;
    return activeLevels.has(level);
}
