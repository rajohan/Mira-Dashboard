import type { OpenClawRuntimeEnvelope } from "../../../../contracts/chat.ts";

const COMPACT_PROVIDER_METADATA_KEYS = [
    "aborted",
    "callId",
    "completed",
    "error",
    "errorMessage",
    "id",
    "idempotencyKey",
    "itemId",
    "itemKind",
    "kind",
    "model",
    "name",
    "operation",
    "operationId",
    "phase",
    "promptError",
    "provider",
    "role",
    "runId",
    "sessionId",
    "sessionKey",
    "state",
    "status",
    "stopReason",
    "stream",
    "timestamp",
    "toolCallId",
    "toolName",
    "tool_call_id",
    "tool_name",
    "ts",
    "type",
    "willRetry",
] as const;

export function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

export function stringField(
    record: Record<string, unknown> | undefined,
    key: string
): string | undefined {
    const value = record?.[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function safeNumberField(
    record: Record<string, unknown> | undefined,
    key: string
): number | undefined {
    const value = record?.[key];
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value
        : undefined;
}

/**
 * Uses the nested provider data object as the canonical field-precedence view.
 * @param payload Raw provider payload.
 * @returns Flattened provider payload view.
 */
export function runtimePayloadView(
    payload: unknown
): Record<string, unknown> | undefined {
    const record = asRecord(payload);
    if (!record) {
        return undefined;
    }
    const data = asRecord(record.data);
    return data ? { ...record, ...data } : record;
}

export function runtimeSessionId(payload: unknown): string | undefined {
    const record = asRecord(payload);
    const payloadView = runtimePayloadView(payload);
    return (
        stringField(payloadView, "sessionId") ||
        stringField(asRecord(payloadView?.session), "sessionId") ||
        stringField(asRecord(record?.session), "sessionId")
    );
}

/**
 * Copies nested runtime identities to the envelope boundary while preserving the
 * provider payload shape used by both Codex and Synthetic runtimes.
 * @param payload Raw provider payload.
 * @param identity Canonical identity fields to apply.
 * @returns Payload with canonical identity at each existing provider boundary.
 */
export function withRuntimeIdentity(
    payload: Record<string, unknown>,
    identity: {
        runId?: string;
        sessionKey?: string;
        shouldRemoveSessionKey?: boolean;
    }
): Record<string, unknown> {
    const { runId, sessionKey, shouldRemoveSessionKey = false } = identity;
    const normalized = { ...payload };
    if (runId) {
        normalized.runId = runId;
    }
    if (shouldRemoveSessionKey) {
        delete normalized.sessionKey;
    } else if (sessionKey) {
        normalized.sessionKey = sessionKey;
    }

    const data = asRecord(payload.data);
    if (!data) {
        return normalized;
    }
    const normalizedData = { ...data };
    if (runId && Object.hasOwn(data, "runId")) {
        normalizedData.runId = runId;
    }
    if (shouldRemoveSessionKey) {
        delete normalizedData.sessionKey;
    } else if (sessionKey && Object.hasOwn(data, "sessionKey")) {
        normalizedData.sessionKey = sessionKey;
    }
    normalized.data = normalizedData;
    return normalized;
}

export function nestedRuntimeItem(
    data: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
    return asRecord(data?.item) || asRecord(data?.payload) || data;
}

export function sessionMessageRole(payload: unknown): string | undefined {
    const record = runtimePayloadView(payload);
    return (
        stringField(record, "role") || stringField(asRecord(record?.message), "role")
    )?.toLowerCase();
}

export function sessionMessageStopReason(payload: unknown): string | undefined {
    const record = runtimePayloadView(payload);
    const message = asRecord(record?.message);
    return (
        stringField(message, "stopReason") || stringField(record, "stopReason")
    )?.toLowerCase();
}

export function sessionMessageActiveRunIds(payload: unknown): string[] {
    const activeRunIds = runtimePayloadView(payload)?.activeRunIds;
    return Array.isArray(activeRunIds)
        ? [
              ...new Set(
                  activeRunIds.filter(
                      (runId): runId is string =>
                          typeof runId === "string" && runId.trim().length > 0
                  )
              ),
          ]
        : [];
}

function compactProviderMetadata(
    record: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
    if (!record) {
        return undefined;
    }
    const compact: Record<string, unknown> = {};
    for (const key of COMPACT_PROVIDER_METADATA_KEYS) {
        const value = record[key];
        if (
            typeof value === "boolean" ||
            typeof value === "number" ||
            (typeof value === "string" && value.length <= 4096)
        ) {
            compact[key] = value;
        }
    }
    for (const key of ["item", "message", "payload"] as const) {
        const nested = compactProviderMetadata(asRecord(record[key]));
        if (nested && Object.keys(nested).length > 0) {
            compact[key] = nested;
        }
    }
    return compact;
}

/**
 * Removes content-bearing provider fields while preserving bounded lifecycle and
 * identity metadata needed to replay terminal events.
 * @param payload Raw provider payload.
 * @returns Bounded provider metadata.
 */
export function compactCanonicalProviderPayload(
    payload: unknown
): Record<string, unknown> {
    const rawPayload = asRecord(payload);
    const payloadView = runtimePayloadView(payload);
    const compact = compactProviderMetadata(payloadView) || {};
    const data = compactProviderMetadata(asRecord(rawPayload?.data));
    return data && Object.keys(data).length > 0 ? { ...compact, data } : compact;
}

/**
 * Creates the compact terminal payload persisted when a provider event is too
 * large to retain in full.
 * @param payload Raw terminal payload.
 * @param runId Canonical run identifier.
 * @param sessionKey Canonical session key.
 * @returns Compact terminal replay payload.
 */
export function compactTerminalPayload(
    payload: Record<string, unknown> | undefined,
    runId: string | undefined,
    sessionKey: string
): Record<string, unknown> {
    const data = asRecord(payload?.data);
    const payloadView = runtimePayloadView(payload);
    const compactData = {
        aborted: data?.aborted === true ? true : undefined,
        completed: data?.completed === true ? true : undefined,
        error: stringField(data, "error"),
        errorMessage: stringField(data, "errorMessage"),
        operation: stringField(data, "operation"),
        operationId: stringField(data, "operationId"),
        phase: stringField(data, "phase"),
        promptError: stringField(data, "promptError"),
        state: stringField(data, "state"),
        status: stringField(data, "status"),
        stream: stringField(data, "stream"),
    };
    const hasCompactData = Object.values(compactData).some(
        (value) => value !== undefined
    );
    return {
        aborted: payloadView?.aborted === true ? true : undefined,
        completed: payloadView?.completed === true ? true : undefined,
        data: hasCompactData ? compactData : undefined,
        error: stringField(payloadView, "error"),
        errorMessage: stringField(payloadView, "errorMessage"),
        operation: stringField(payloadView, "operation"),
        operationId: stringField(payloadView, "operationId"),
        phase: stringField(payloadView, "phase"),
        promptError: stringField(payloadView, "promptError"),
        role: sessionMessageRole(payload),
        runId,
        sessionKey,
        state: stringField(payloadView, "state"),
        status: stringField(payloadView, "status"),
        stopReason: sessionMessageStopReason(payload),
        stream: stringField(payloadView, "stream"),
    };
}

export function envelopeBytes(envelope: OpenClawRuntimeEnvelope): number {
    return Buffer.byteLength(JSON.stringify(envelope));
}
