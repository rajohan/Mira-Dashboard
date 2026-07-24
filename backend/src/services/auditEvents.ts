import { database, sqlNullable } from "../database.ts";

export type AuditActorType = "anonymous" | "automation" | "loopback" | "system" | "user";
export type AuditOutcome =
    "attempted" | "accepted" | "succeeded" | "failed" | "denied" | "cancelled";

export interface AuditActor {
    id: string;
    type: AuditActorType;
}

export interface AuditEvent {
    id: string;
    actor: AuditActor;
    action: string;
    target: {
        id: string;
        type: string;
    };
    outcome: AuditOutcome;
    requestId: string | undefined;
    metadata: Record<string, unknown>;
    occurredAt: string;
}

export interface WriteAuditEventInput {
    actor: AuditActor;
    action: string;
    metadata?: Record<string, unknown>;
    occurredAt?: string;
    outcome: AuditOutcome;
    requestId?: string;
    targetId: string;
    targetType: string;
}

export interface AuditEventPage {
    events: AuditEvent[];
    nextCursor: string | undefined;
}

interface AuditEventRow {
    id: string;
    actor_type: AuditActorType;
    actor_id: string;
    action: string;
    target_type: string;
    target_id: string;
    outcome: AuditOutcome;
    request_id: string | null | undefined;
    metadata_json: string;
    occurred_at: string;
}

interface AuditEventCursor {
    id: string;
    occurredAt: string;
}

export const MAX_AUDIT_PAGE_SIZE = 200;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_METADATA_BYTES = 4096;
const MAX_METADATA_DEPTH = 3;
const MAX_METADATA_ITEMS = 32;
const MAX_METADATA_STRING_LENGTH = 512;
const CURSOR_RE = /^[\w-]{1,512}$/u;
const REQUEST_ID_RE = /^[\w.:-]{1,128}$/u;
const FORBIDDEN_METADATA_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SENSITIVE_METADATA_KEY_RE =
    /argument|auth|body|command|content|cookie|credential|output|pass(?:word)?|payload|secret|stderr|stdout|token/iu;
const SENSITIVE_ARGUMENT_KEY_RE = /^(?:arg|args)$/iu;

function hasControlCharacter(value: string): boolean {
    for (const character of value) {
        const codePoint = character.codePointAt(0)!;
        if (codePoint === 127 || codePoint <= 31) {
            return true;
        }
    }
    return false;
}

function parseMetadata(value: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(value) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

function mapAuditEvent(row: AuditEventRow): AuditEvent {
    return {
        id: row.id,
        actor: { id: row.actor_id, type: row.actor_type },
        action: row.action,
        target: { id: row.target_id, type: row.target_type },
        outcome: row.outcome,
        requestId: row.request_id ?? undefined,
        metadata: parseMetadata(row.metadata_json),
        occurredAt: row.occurred_at,
    };
}

function identifier(value: string, label: string): string {
    const normalized = value.trim();
    if (
        !normalized ||
        normalized.length > MAX_IDENTIFIER_LENGTH ||
        hasControlCharacter(normalized)
    ) {
        throw new TypeError(`Invalid audit ${label}`);
    }
    return normalized;
}

function occurredAtIso(value = new Date().toISOString()): string {
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
        throw new TypeError("Invalid audit timestamp");
    }
    return value;
}

function sanitizedMetadataValue(
    value: unknown,
    depth: number
): boolean | number | string | null | unknown[] | Record<string, unknown> | undefined {
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
    if (typeof value === "string") {
        return value.slice(0, MAX_METADATA_STRING_LENGTH);
    }
    if (depth >= MAX_METADATA_DEPTH) return "[truncated]";
    if (Array.isArray(value)) {
        const wasTruncated = value.length > MAX_METADATA_ITEMS;
        const sanitized = value
            .slice(0, wasTruncated ? MAX_METADATA_ITEMS - 1 : MAX_METADATA_ITEMS)
            .map((item) => sanitizedMetadataValue(item, depth + 1))
            .filter((item) => item !== undefined);
        if (wasTruncated) sanitized.push("[truncated]");
        return sanitized;
    }
    if (typeof value !== "object") return undefined;

    const entries = Object.entries(value);
    const wasTruncated = entries.length > MAX_METADATA_ITEMS;
    const limitedEntries = entries.slice(
        0,
        wasTruncated ? MAX_METADATA_ITEMS - 1 : MAX_METADATA_ITEMS
    );
    const sanitized: Record<string, unknown> = {};
    for (const [key, nestedValue] of limitedEntries) {
        if (
            !key ||
            key.length > 128 ||
            hasControlCharacter(key) ||
            FORBIDDEN_METADATA_KEYS.has(key)
        ) {
            continue;
        }
        if (SENSITIVE_METADATA_KEY_RE.test(key) || SENSITIVE_ARGUMENT_KEY_RE.test(key)) {
            sanitized[key] = "[redacted]";
            continue;
        }
        const nested = sanitizedMetadataValue(nestedValue, depth + 1);
        if (nested !== undefined) sanitized[key] = nested;
    }
    if (wasTruncated) sanitized.truncated = "[truncated]";
    return sanitized;
}

function metadataJson(metadata: Record<string, unknown> | undefined): string {
    const sanitized = sanitizedMetadataValue(metadata ?? {}, 0);
    const serialized = JSON.stringify(sanitized ?? {});
    return new TextEncoder().encode(serialized).byteLength <= MAX_METADATA_BYTES
        ? serialized
        : JSON.stringify({ truncated: true });
}

function requestId(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (!REQUEST_ID_RE.test(value)) {
        throw new TypeError("Invalid audit request ID");
    }
    return value;
}

/** Writes one immutable, explicitly redacted audit event. */
export function writeAuditEvent(input: WriteAuditEventInput): AuditEvent {
    const id = Bun.randomUUIDv7();
    const actorType = input.actor.type;
    const actorId = identifier(input.actor.id, "actor");
    const action = identifier(input.action, "action");
    const targetType = identifier(input.targetType, "target type");
    const targetId = identifier(input.targetId, "target ID");
    const normalizedRequestId = requestId(input.requestId);
    const timestamp = occurredAtIso(input.occurredAt);
    const serializedMetadata = metadataJson(input.metadata);
    database
        .prepare(
            `INSERT INTO audit_events (
                id, actor_type, actor_id, action, target_type, target_id,
                outcome, request_id, metadata_json, occurred_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
            id,
            actorType,
            actorId,
            action,
            targetType,
            targetId,
            input.outcome,
            sqlNullable(normalizedRequestId),
            serializedMetadata,
            timestamp
        );
    return {
        id,
        actor: { id: actorId, type: actorType },
        action,
        target: { id: targetId, type: targetType },
        outcome: input.outcome,
        requestId: normalizedRequestId,
        metadata: parseMetadata(serializedMetadata),
        occurredAt: timestamp,
    };
}

export function getAuditEvent(id: string): AuditEvent | undefined {
    const row = database.prepare("SELECT * FROM audit_events WHERE id = ?").get(id) as
        AuditEventRow | undefined;
    return row ? mapAuditEvent(row) : undefined;
}

function encodeCursor(cursor: AuditEventCursor): string {
    return btoa(`${cursor.occurredAt}\0${cursor.id}`)
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/u, "");
}

function decodeCursor(value: string): AuditEventCursor {
    if (!CURSOR_RE.test(value)) {
        throw new TypeError("Invalid audit cursor");
    }
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    let decoded: string;
    try {
        decoded = atob(padded);
    } catch {
        throw new TypeError("Invalid audit cursor");
    }
    const parts = decoded.split("\0");
    if (parts.length !== 2) {
        throw new TypeError("Invalid audit cursor");
    }
    const [occurredAt, id] = parts;
    if (!occurredAt || !id) {
        throw new TypeError("Invalid audit cursor");
    }
    return {
        id: identifier(id, "cursor ID"),
        occurredAt: occurredAtIso(occurredAt),
    };
}

export function listAuditEvents(limit = 50, beforeCursor?: string): AuditEventPage {
    const normalizedLimit =
        Number.isSafeInteger(limit) && limit > 0
            ? Math.min(limit, MAX_AUDIT_PAGE_SIZE)
            : 50;
    const cursor = beforeCursor ? decodeCursor(beforeCursor) : undefined;
    const rows = (cursor
        ? database
              .prepare(
                  `SELECT *
                       FROM audit_events
                       WHERE occurred_at < ?
                          OR (occurred_at = ? AND id < ?)
                       ORDER BY occurred_at DESC, id DESC
                       LIMIT ?`
              )
              .all(cursor.occurredAt, cursor.occurredAt, cursor.id, normalizedLimit + 1)
        : database
              .prepare(
                  `SELECT *
                       FROM audit_events
                       ORDER BY occurred_at DESC, id DESC
                       LIMIT ?`
              )
              .all(normalizedLimit + 1)) as unknown as AuditEventRow[];
    const hasMore = rows.length > normalizedLimit;
    const pageRows = rows.slice(0, normalizedLimit);
    const lastRow = pageRows.at(-1);
    return {
        events: pageRows.map((row) => mapAuditEvent(row)),
        nextCursor:
            hasMore && lastRow
                ? encodeCursor({ id: lastRow.id, occurredAt: lastRow.occurred_at })
                : undefined,
    };
}

/** Returns original request provenance for later asynchronous lifecycle events. */
export function auditProvenanceForTarget(
    action: string,
    targetType: string,
    targetId: string
): { actor: AuditActor; requestId: string | undefined } | undefined {
    const row = database
        .prepare(
            `SELECT actor_type, actor_id, request_id
             FROM audit_events
             WHERE action = ? AND target_type = ? AND target_id = ?
             ORDER BY occurred_at, id
             LIMIT 1`
        )
        .get(action, targetType, targetId) as
        | {
              actor_id: string;
              actor_type: AuditActorType;
              request_id: string | null | undefined;
          }
        | undefined;
    return row
        ? {
              actor: { id: row.actor_id, type: row.actor_type },
              requestId: row.request_id ?? undefined,
          }
        : undefined;
}
