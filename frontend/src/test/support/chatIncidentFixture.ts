import * as v from "valibot";

import { openClawRuntimeSnapshotSchema } from "../../../../contracts/chat";
import { nonNegativeIntegerSchema, parseContract } from "../../../../contracts/runtime";
import type {
    ChatHistoryMessage,
    ChatRow,
} from "../../components/features/chat/chatTypes";
import {
    createChatVisibility,
    hasPrimaryAnswerContent,
} from "../../components/features/chat/domain/chatPresentation";
import { projectChat } from "../../components/features/chat/domain/chatProjection";
import {
    createChatRuntimeState,
    findChatSessionRuntimeState,
    reduceChatRuntime,
} from "../../components/features/chat/domain/chatState";
import { OpenClawChatAdapter } from "../../components/features/chat/transport/openClawChatAdapter";

export const CHAT_INCIDENT_FIXTURE_SCHEMA_VERSION = 1;

const nonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());
const canonicalRowSchema = v.strictObject({
    role: nonEmptyStringSchema,
    text: v.string(),
    thinkingText: v.string(),
    toolNames: v.array(nonEmptyStringSchema),
    toolResults: v.array(v.string()),
    type: v.picklist(["assistant", "thinking", "tool", "user"]),
});
const chatIncidentFixtureSchema = v.strictObject({
    deliveryFormat: v.picklist([
        "codex-separated-runtime-events",
        "synthetic-mixed-session-message",
    ]),
    expected: v.strictObject({
        activeRunCount: nonNegativeIntegerSchema,
        rows: v.array(canonicalRowSchema),
        runCount: nonNegativeIntegerSchema,
    }),
    history: v.array(v.unknown()),
    id: nonEmptyStringSchema,
    providerFormat: v.picklist(["codex-gpt", "synthetic-model"]),
    redaction: v.literal("synthetic"),
    runtimeSnapshot: openClawRuntimeSnapshotSchema,
    schemaVersion: v.literal(CHAT_INCIDENT_FIXTURE_SCHEMA_VERSION),
    sessionKey: nonEmptyStringSchema,
});

export type ChatIncidentFixture = v.InferOutput<typeof chatIncidentFixtureSchema>;
export type CanonicalChatIncidentRow = v.InferOutput<typeof canonicalRowSchema>;

export interface ChatIncidentFixtureResult {
    activeRunCount: number;
    normalizedEventKinds: string[];
    rowKeys: string[];
    rows: CanonicalChatIncidentRow[];
    runCount: number;
}

function toolResults(message: ChatHistoryMessage): string[] {
    const results = [
        message.toolResult?.content,
        ...(message.toolCalls || []).map((toolCall) => toolCall.toolResult?.content),
    ].filter((content): content is string => content !== undefined);
    return [...new Set(results)];
}

function canonicalRowType(row: ChatRow): CanonicalChatIncidentRow["type"] | undefined {
    if (row.message.role.toLowerCase() === "user") {
        return "user";
    }
    if (row.message.toolCalls?.length || row.message.toolResult) {
        return "tool";
    }
    if (row.message.thinking?.length && !hasPrimaryAnswerContent(row.message)) {
        return "thinking";
    }
    return hasPrimaryAnswerContent(row.message) ? "assistant" : undefined;
}

function canonicalRows(rows: ChatRow[]): CanonicalChatIncidentRow[] {
    return rows.flatMap((row) => {
        const type = canonicalRowType(row);
        if (!type) {
            return [];
        }
        return [
            {
                role: row.message.role,
                text: row.message.text,
                thinkingText: (row.message.thinking || [])
                    .map((block) => block.text)
                    .join(""),
                toolNames: (row.message.toolCalls || []).map((toolCall) => toolCall.name),
                toolResults: toolResults(row.message),
                type,
            },
        ];
    });
}

/**
 * Loads and validates a synthetic, versioned chat incident fixture.
 * @returns Validated fixture data.
 */
export async function loadChatIncidentFixture(file: URL): Promise<ChatIncidentFixture> {
    const raw: unknown = await Bun.file(file).json();
    return parseContract(chatIncidentFixtureSchema, raw, "chatIncidentFixture");
}

/**
 * Replays raw provider data through the production adapter, reducer and projection.
 * @returns Canonical replay result.
 */
export function replayChatIncidentFixture(
    fixture: ChatIncidentFixture
): ChatIncidentFixtureResult {
    const adapter = new OpenClawChatAdapter();
    const history = adapter.history(fixture.history);
    const events = adapter.snapshot(fixture.runtimeSnapshot);
    const runtime = reduceChatRuntime(createChatRuntimeState(), events);
    const projection = projectChat(
        history,
        runtime,
        fixture.sessionKey,
        createChatVisibility(true, true),
        true,
        new Set()
    );
    const session = findChatSessionRuntimeState(runtime, fixture.sessionKey);
    return {
        activeRunCount: projection.activeRuns.length,
        normalizedEventKinds: events.map((event) => event.kind),
        rowKeys: projection.rows.map((row) => row.key),
        rows: canonicalRows(projection.rows),
        runCount: Object.keys(session?.runs || {}).length,
    };
}
