import type { Session } from "../../../../contracts/sessions.ts";
import { readSessionsResponseContainer } from "../../../../contracts/socket.ts";
import { boundedTimestamp, stringFallback } from "../../lib/values.ts";

/** Raw session shape accepted from the OpenClaw Gateway. */
interface GatewaySession {
    sessionId?: string;
    key?: string;
    kind?: string;
    model?: string;
    modelProvider?: string;
    totalTokens?: number;
    contextTokens?: number;
    updatedAt?: number;
    displayName?: string;
    label?: string;
    channel?: string;
    status?: string;
    endedAt?: string | number;
    startedAt?: string | number;
    runId?: string;
    activeRunId?: string;
    currentRunId?: string;
    hasActiveRun?: boolean;
    isRunning?: boolean;
    running?: boolean;
    thinkingLevel?: string;
    thinkingLevels?: Array<{ id: string; label: string }>;
    thinkingOptions?: string[];
    thinkingDefault?: string;
    fastMode?: boolean | "auto";
    effectiveFastMode?: boolean | "auto";
    verboseLevel?: string;
    reasoningLevel?: string;
    elevatedLevel?: string;
    totalTokensFresh?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function transformSession(session: GatewaySession): Session {
    let type = "UNKNOWN";
    let agentType = "";
    const key = session.key || "";
    const keyParts = key.split(":");

    if (keyParts.length >= 2) {
        agentType = stringFallback(keyParts[1]);
    }

    let hookName = "";
    if (key.includes(":hook:")) {
        type = "HOOK";
        const hookIndex = keyParts.indexOf("hook");
        const nextHookPart = keyParts.at(hookIndex + 1);
        if (hookIndex !== -1 && nextHookPart) {
            hookName = stringFallback(nextHookPart);
        }
    } else if (key.includes(":cron:")) {
        type = "CRON";
    } else if (key.includes(":subagent:")) {
        type = "SUBAGENT";
    } else if (key.startsWith("agent:main:")) {
        type = "MAIN";
    } else if (key.startsWith("agent:")) {
        type = "SUBAGENT";
    }

    let displayLabel = session.label || "";
    if (!displayLabel && type === "HOOK" && hookName) {
        displayLabel = hookName.charAt(0).toUpperCase() + hookName.slice(1);
    }
    if (!displayLabel && type === "SUBAGENT" && agentType) {
        displayLabel = agentType.charAt(0).toUpperCase() + agentType.slice(1);
    }

    const createdAtDate =
        session.updatedAt == undefined ? undefined : new Date(session.updatedAt);
    const createdAt = createdAtDate ? createdAtDate.toISOString() : undefined;

    return {
        id: session.sessionId || session.key || "unknown",
        ...(session.sessionId && { sessionId: session.sessionId }),
        key: session.key || "",
        type,
        agentType,
        hookName,
        kind: session.kind,
        model: session.model || "Unknown",
        modelProvider: session.modelProvider,
        tokenCount: session.totalTokens || 0,
        maxTokens: session.contextTokens || 0,
        createdAt,
        updatedAt: session.updatedAt,
        displayName: session.displayName || "",
        label: session.label || "",
        displayLabel,
        channel: session.channel || "unknown",
        status: session.status,
        endedAt: session.endedAt,
        startedAt: session.startedAt,
        runId: session.runId,
        activeRunId: session.activeRunId,
        currentRunId: session.currentRunId,
        hasActiveRun: session.hasActiveRun,
        isRunning: session.isRunning,
        running: session.running,
        thinkingLevel: session.thinkingLevel,
        thinkingLevels: session.thinkingLevels,
        thinkingOptions: session.thinkingOptions,
        thinkingDefault: session.thinkingDefault,
        fastMode: session.fastMode,
        effectiveFastMode: session.effectiveFastMode,
        verboseLevel: session.verboseLevel,
        reasoningLevel: session.reasoningLevel,
        elevatedLevel: session.elevatedLevel,
        totalTokensFresh: session.totalTokensFresh,
    };
}

function gatewayString(
    record: Record<string, unknown>,
    key: string
): string | undefined {
    return typeof record[key] === "string" ? record[key] : undefined;
}

function gatewayFiniteNumber(
    record: Record<string, unknown>,
    key: string
): number | undefined {
    const value = record[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function gatewayBoolean(
    record: Record<string, unknown>,
    key: string
): boolean | undefined {
    return typeof record[key] === "boolean" ? record[key] : undefined;
}

function gatewaySessionFromRecord(record: Record<string, unknown>): GatewaySession {
    const thinkingLevels = Array.isArray(record.thinkingLevels)
        ? record.thinkingLevels.slice(0, 100).flatMap((value) => {
              const level = asRecord(value);
              const id = level ? gatewayString(level, "id")?.trim() : undefined;
              const label = level ? gatewayString(level, "label")?.trim() : undefined;
              return id && label ? [{ id, label }] : [];
          })
        : undefined;
    const thinkingOptions = Array.isArray(record.thinkingOptions)
        ? record.thinkingOptions
              .slice(0, 100)
              .filter((value): value is string => typeof value === "string")
              .map((value) => value.trim())
              .filter(Boolean)
        : undefined;
    const fastMode =
        typeof record.fastMode === "boolean" || record.fastMode === "auto"
            ? record.fastMode
            : undefined;
    const effectiveFastMode =
        typeof record.effectiveFastMode === "boolean" ||
        record.effectiveFastMode === "auto"
            ? record.effectiveFastMode
            : undefined;
    const endedAt =
        typeof record.endedAt === "string" ||
        (typeof record.endedAt === "number" && Number.isFinite(record.endedAt))
            ? record.endedAt
            : undefined;
    const startedAt =
        typeof record.startedAt === "string" ||
        (typeof record.startedAt === "number" && Number.isFinite(record.startedAt))
            ? record.startedAt
            : undefined;
    return {
        activeRunId: gatewayString(record, "activeRunId"),
        channel: gatewayString(record, "channel"),
        contextTokens: gatewayFiniteNumber(record, "contextTokens"),
        currentRunId: gatewayString(record, "currentRunId"),
        displayName: gatewayString(record, "displayName"),
        effectiveFastMode,
        elevatedLevel: gatewayString(record, "elevatedLevel"),
        endedAt,
        fastMode,
        hasActiveRun: gatewayBoolean(record, "hasActiveRun"),
        isRunning: gatewayBoolean(record, "isRunning"),
        key: gatewayString(record, "key"),
        kind: gatewayString(record, "kind"),
        label: gatewayString(record, "label"),
        model: gatewayString(record, "model"),
        modelProvider: gatewayString(record, "modelProvider"),
        reasoningLevel: gatewayString(record, "reasoningLevel"),
        runId: gatewayString(record, "runId"),
        running: gatewayBoolean(record, "running"),
        sessionId: gatewayString(record, "sessionId"),
        startedAt,
        status: gatewayString(record, "status"),
        thinkingDefault: gatewayString(record, "thinkingDefault"),
        thinkingLevel: gatewayString(record, "thinkingLevel"),
        thinkingLevels,
        thinkingOptions,
        totalTokens: gatewayFiniteNumber(record, "totalTokens"),
        totalTokensFresh: gatewayBoolean(record, "totalTokensFresh"),
        updatedAt: boundedTimestamp(record.updatedAt),
        verboseLevel: gatewayString(record, "verboseLevel"),
    };
}

/** Normalizes one raw Gateway sessions.list response for Dashboard consumers. */
export function normalizeGatewaySessionList(response: unknown): Session[] {
    const container = readSessionsResponseContainer(response);
    const sessions = container?.sessions ?? [];
    const defaultsRecord = asRecord(container?.defaults);
    const defaults = defaultsRecord
        ? gatewaySessionFromRecord(defaultsRecord)
        : undefined;
    return sessions
        .map((entry) => asRecord(entry))
        .filter(
            (entry): entry is Record<string, unknown> =>
                entry !== undefined &&
                (entry.sessionId === undefined || typeof entry.sessionId === "string") &&
                (entry.key === undefined || typeof entry.key === "string") &&
                (entry.updatedAt === undefined ||
                    boundedTimestamp(entry.updatedAt) !== undefined) &&
                (stringFallback(entry.sessionId).trim() ||
                    stringFallback(entry.key).trim()) !== ""
        )
        .map((entry) => {
            const session = gatewaySessionFromRecord(entry);
            const updatedAt = boundedTimestamp(entry.updatedAt);
            const shouldApplyDefaults =
                (!session.model || session.model === defaults?.model) &&
                (!session.modelProvider ||
                    !defaults?.modelProvider ||
                    session.modelProvider === defaults.modelProvider);
            const matchingDefaults = shouldApplyDefaults ? defaults : undefined;
            const hasSessionThinkingChoices = Boolean(
                session.thinkingLevels?.length || session.thinkingOptions?.length
            );
            let thinkingLevels = hasSessionThinkingChoices
                ? undefined
                : matchingDefaults?.thinkingLevels;
            if (session.thinkingLevels?.length) {
                thinkingLevels = session.thinkingLevels;
            }
            let thinkingOptions = hasSessionThinkingChoices
                ? undefined
                : matchingDefaults?.thinkingOptions;
            if (session.thinkingOptions?.length) {
                thinkingOptions = session.thinkingOptions;
            }
            return transformSession({
                ...matchingDefaults,
                ...session,
                model: session.model?.trim() ? session.model : matchingDefaults?.model,
                modelProvider: session.modelProvider?.trim()
                    ? session.modelProvider
                    : matchingDefaults?.modelProvider,
                contextTokens: session.contextTokens ?? matchingDefaults?.contextTokens,
                thinkingDefault:
                    session.thinkingDefault ?? matchingDefaults?.thinkingDefault,
                thinkingLevels,
                thinkingOptions,
                fastMode: session.fastMode,
                effectiveFastMode:
                    session.effectiveFastMode ??
                    matchingDefaults?.effectiveFastMode ??
                    matchingDefaults?.fastMode,
                activeRunId: entry.activeRunId === null ? undefined : session.activeRunId,
                currentRunId:
                    entry.currentRunId === null ? undefined : session.currentRunId,
                endedAt: entry.endedAt === null ? undefined : session.endedAt,
                runId: entry.runId === null ? undefined : session.runId,
                startedAt: entry.startedAt === null ? undefined : session.startedAt,
                updatedAt:
                    typeof updatedAt === "number" && Number.isFinite(updatedAt)
                        ? updatedAt
                        : undefined,
            });
        });
}
