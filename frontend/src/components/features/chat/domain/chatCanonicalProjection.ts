import type { CanonicalChatTurn } from "../../../../../../contracts/chat/canonicalTurn";
import {
    type ChatHistoryMessage,
    type ChatVisibilitySettings,
    isRenderableChatHistoryMessage,
} from "../chatTypes";
import { canonicalizeStructuredChatTurns } from "./chatCanonicalTurns";
import {
    type ChatProjection,
    type ChatProjectionContext,
    finalizeChatProjection,
    presentChatProjectionContext,
    type PresentedChatProjection,
    type ReconciledChatProjection,
    reconcileChatProjectionContext,
    selectChatProjectionContext,
    structureChatProjectionContext,
    type StructuredChatProjection,
} from "./chatProjection";
import { isSameChatSession, type ChatRuntimeState } from "./chatState";

export interface CanonicalChatProjection {
    projection: ChatProjection;
    turns: CanonicalChatTurn[];
}

function assertCanonicalProjectionContext(context: ChatProjectionContext): void {
    if (
        !context.sessionKey.trim() &&
        (context.history.length > 0 ||
            context.runs.length > 0 ||
            context.boundaryMessages.length > 0)
    ) {
        throw new Error("Canonical chat projection invariant failed: session");
    }
    if (
        context.session &&
        !isSameChatSession(context.session.sessionKey, context.sessionKey)
    ) {
        throw new Error("Canonical chat projection invariant failed: selected session");
    }
    const runIds = new Set<string>();
    for (const run of context.runs) {
        if (
            !isSameChatSession(run.sessionKey, context.sessionKey) ||
            runIds.has(run.runId)
        ) {
            throw new Error("Canonical chat projection invariant failed: run identity");
        }
        runIds.add(run.runId);
    }
}

function assertCanonicalReconciliation(
    reconciliation: ReconciledChatProjection,
    context: ChatProjectionContext
): void {
    if (reconciliation.context !== context) {
        throw new Error("Canonical chat projection invariant failed: reconciliation");
    }
    if (reconciliation.messages.some((message) => !message.role.trim())) {
        throw new Error("Canonical chat projection invariant failed: message role");
    }
}

function assertCanonicalStructure(
    structure: StructuredChatProjection,
    reconciliation: ReconciledChatProjection
): void {
    if (structure.reconciliation !== reconciliation) {
        throw new Error("Canonical chat projection invariant failed: structure");
    }
    if (
        structure.messages.some(
            (message) =>
                message.thinking?.length &&
                Boolean(
                    message.text.trim() || message.toolCalls?.length || message.toolResult
                )
        )
    ) {
        throw new Error("Canonical chat projection invariant failed: mixed thinking");
    }
}

function assertCanonicalPresentation(
    presentation: PresentedChatProjection,
    structure: StructuredChatProjection,
    visibility: ChatVisibilitySettings
): void {
    if (
        presentation.structure !== structure ||
        presentation.messages.some(
            (message) =>
                !isRenderableChatHistoryMessage(message, visibility) ||
                (!visibility.shouldShowThinking && Boolean(message.thinking?.length))
        )
    ) {
        throw new Error("Canonical chat projection invariant failed: presentation");
    }
}

function assertCanonicalFinalProjection(projection: ChatProjection): void {
    const rowKeys = projection.rows.map((row) => row.key);
    if (new Set(rowKeys).size !== rowKeys.length) {
        throw new Error("Canonical chat projection invariant failed: row identity");
    }
    if (
        projection.activeRuns.some(
            (run) => run.phase !== "active" || run.operation === "compact"
        )
    ) {
        throw new Error("Canonical chat projection invariant failed: active run");
    }
}

// Projects canonical turns into the stable row contract consumed by the chat UI.
export function projectCanonicalChat(
    history: ChatHistoryMessage[],
    runtime: ChatRuntimeState,
    sessionKey: string,
    visibility: ChatVisibilitySettings,
    shouldKeepThinkingAfterFinal: boolean,
    deletedMessageKeys: ReadonlySet<string>
): CanonicalChatProjection {
    const context = selectChatProjectionContext(history, runtime, sessionKey);
    assertCanonicalProjectionContext(context);
    const reconciliation = reconcileChatProjectionContext(context);
    assertCanonicalReconciliation(reconciliation, context);
    const structure = structureChatProjectionContext(reconciliation);
    assertCanonicalStructure(structure, reconciliation);
    const canonical = canonicalizeStructuredChatTurns(
        reconciliation.messages,
        structure,
        context.runs,
        sessionKey
    );
    const presentation = presentChatProjectionContext(
        canonical.structure,
        visibility,
        shouldKeepThinkingAfterFinal
    );
    assertCanonicalPresentation(presentation, canonical.structure, visibility);
    const projection = finalizeChatProjection(presentation, deletedMessageKeys);
    assertCanonicalFinalProjection(projection);
    return { projection, turns: canonical.turns };
}
