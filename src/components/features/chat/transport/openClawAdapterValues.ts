import { currentIsoString, isoStringFromDate } from "../../../../utils/date";
import { type ChatHistoryMessage, normalizeText } from "../chatTypes";
import { uniqueChatRunIds } from "../domain/chatState";
import {
    normalizeOpenClawHistoryMessage,
    type RawOpenClawHistoryMessage,
} from "./openClawHistoryNormalizer";

const NON_WORK_TOOLS = new Set([
    "message",
    "messages",
    "react",
    "reaction",
    "reply",
    "send",
    "typing",
]);
const MAX_OPENCLAW_SEQUENCE = Math.floor((Number.MAX_SAFE_INTEGER - 15) / 16);

export function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

export function stringValue(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function rawString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function runtimeText(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    if (Array.isArray(value)) {
        const normalized = normalizeText(value);
        if (normalized) {
            return normalized;
        }
    }
    if (value === undefined || value === null) {
        return "";
    }
    try {
        return JSON.stringify(value, undefined, 2);
    } catch {
        return String(value);
    }
}

export function formatToolName(value: string): string {
    const name = value.startsWith("functions.")
        ? value.slice("functions.".length)
        : value;
    const normalized = name.replaceAll(/[_-]/g, " ").replaceAll(/\s+/g, " ").trim();
    return normalized
        ? `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`
        : "Tool";
}

export function isNonWorkTool(name: string): boolean {
    const normalized = name.startsWith("functions.")
        ? name.slice("functions.".length)
        : name;
    return NON_WORK_TOOLS.has(normalized.toLowerCase());
}

export function compactStatus(value: string): string {
    const normalized = value.replaceAll(/\s+/g, " ").trim();
    return normalized.length > 120
        ? `${normalized.slice(0, 119).trimEnd()}…`
        : normalized;
}

export function argumentDetail(value: unknown): string | undefined {
    const record = asRecord(value);
    if (!record) {
        return stringValue(value);
    }
    for (const key of [
        "command",
        "cmd",
        "query",
        "url",
        "path",
        "filePath",
        "message",
        "text",
        "title",
        "name",
    ]) {
        const detail = stringValue(record[key]);
        if (detail) {
            return detail;
        }
    }
    return undefined;
}

export function nestedItem(data: Record<string, unknown>): Record<string, unknown> {
    for (const key of ["item", "payload", "message"]) {
        const nested = asRecord(data[key]);
        if (nested) {
            return nested;
        }
    }
    return data;
}

export function itemStrings(data: Record<string, unknown>, keys: string[]): string[] {
    const item = nestedItem(data);
    const sources = item === data ? [data] : [data, item];
    return uniqueChatRunIds(
        sources.flatMap((source) => keys.map((key) => rawString(source[key])))
    );
}

export function itemTexts(data: Record<string, unknown>, keys: string[]): string[] {
    const item = nestedItem(data);
    const sources = item === data ? [data] : [data, item];
    const values: string[] = [];
    for (const source of sources) {
        for (const key of keys) {
            const raw = source[key];
            const text = rawString(raw) || (Array.isArray(raw) ? normalizeText(raw) : "");
            if (text) {
                values.push(text);
            }
        }
    }
    return uniqueChatRunIds(values);
}

export function itemType(data: Record<string, unknown>): string {
    return stringValue(nestedItem(data).type)?.toLowerCase() || "";
}

export function isToolCallItem(data: Record<string, unknown>): boolean {
    return [
        "custom_tool_call",
        "function_call",
        "tool_call",
        "toolcall",
        "tool_use",
    ].includes(itemType(data));
}

export function isToolResultItem(data: Record<string, unknown>): boolean {
    return [
        "custom_tool_call_output",
        "function_call_output",
        "tool_call_output",
        "tool_result",
        "toolresult",
    ].includes(itemType(data));
}

export function isThinkingItem(data: Record<string, unknown>): boolean {
    const markers = itemStrings(data, [
        "itemId",
        "itemKind",
        "kind",
        "name",
        "role",
        "stream",
        "title",
        "type",
    ])
        .join(" ")
        .toLowerCase();
    return (
        markers.includes("preamble") ||
        /\b(reasoning|reason|thinking|analysis)\b/u.test(markers)
    );
}

export function normalizeAssistant(value: unknown, runId?: string): ChatHistoryMessage {
    const raw =
        value && typeof value === "object" && !Array.isArray(value)
            ? ({
                  ...(value as RawOpenClawHistoryMessage),
                  role: (value as RawOpenClawHistoryMessage).role || "assistant",
              } satisfies RawOpenClawHistoryMessage)
            : ({
                  role: "assistant",
                  content: value,
              } satisfies RawOpenClawHistoryMessage);
    return {
        ...normalizeOpenClawHistoryMessage(raw),
        runId,
    };
}

function timestampFor(
    envelope: Record<string, unknown>,
    payload: Record<string, unknown>
): string {
    for (const timestamp of [payload.ts, payload.timestamp, envelope.runtimeRecordedAt]) {
        const timestampMs =
            typeof timestamp === "number"
                ? timestamp
                : typeof timestamp === "string"
                  ? Date.parse(timestamp)
                  : NaN;
        if (
            Number.isFinite(timestampMs) &&
            !Number.isNaN(new Date(timestampMs).getTime())
        ) {
            return isoStringFromDate(timestampMs);
        }
    }
    return currentIsoString();
}

export interface OpenClawEventContext {
    eventName: string;
    payload: Record<string, unknown>;
    runId?: string;
    sessionKey: string;
    timestamp: string;
}

export function openClawEventContext(raw: unknown): OpenClawEventContext | undefined {
    const envelope = asRecord(raw);
    if (!envelope || envelope.type !== "event") {
        return undefined;
    }
    const eventName = stringValue(envelope.event);
    const payload = asRecord(envelope.payload);
    const sessionKey = stringValue(payload?.sessionKey);
    if (!eventName || !payload || !sessionKey) {
        return undefined;
    }
    const sourceRunId = stringValue(
        eventName === "session.compaction" ? payload.operationId : payload.runId
    );
    const isCompactionEvent =
        eventName === "session.compaction" ||
        stringValue(payload.stream) === "compaction";
    return {
        eventName,
        payload,
        runId: isCompactionEvent
            ? `compaction:${sourceRunId || sessionKey}`
            : sourceRunId,
        sessionKey,
        timestamp: timestampFor(envelope, payload),
    };
}

export function openClawSequence(raw: unknown, fallback: number): number {
    const sequence = asRecord(raw)?.runtimeSequence;
    return typeof sequence === "number" &&
        Number.isSafeInteger(sequence) &&
        sequence >= 0 &&
        sequence <= MAX_OPENCLAW_SEQUENCE
        ? sequence
        : fallback;
}

/** Converts a validated backend sequence into the canonical event cutoff. */
export function openClawThroughSequence(value: unknown): number {
    return typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0 &&
        value <= MAX_OPENCLAW_SEQUENCE
        ? value * 16 + 15
        : 0;
}
