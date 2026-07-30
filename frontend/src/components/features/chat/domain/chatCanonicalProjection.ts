import type {
    CanonicalChatMessage,
    CanonicalChatProviderMetadata,
} from "../../../../../../contracts/chatCanonical";
import {
    canonicalChatContentFingerprint,
    summarizeCanonicalChatValueForFingerprint,
} from "../../../../../../contracts/chatCanonicalMessage";
import {
    CANONICAL_CHAT_TURN_SCHEMA_VERSION,
    parseCanonicalChatTurns,
    type CanonicalChatTurn,
    type CanonicalChatTurnEntry,
} from "../../../../../../contracts/chatCanonicalTurn";
import { stableCanonicalChatStringify } from "../../../../../../contracts/chatCanonicalUtilities";
import {
    CHAT_PROJECTION_SHADOW_SCHEMA_VERSION,
    type ChatProjectionCompactionPhase,
    type ChatProjectionShadowDifference,
} from "../../../../../../contracts/chatProjectionTelemetry";
import {
    type ChatHistoryMessage,
    type ChatVisibilitySettings,
    isRenderableChatHistoryMessage,
    TOOL_ROLE_VARIANTS,
} from "../chatTypes";
import { hasPrimaryAnswerContent } from "./chatPresentation";
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
import { isSameChatSession, type ChatRunState, type ChatRuntimeState } from "./chatState";

export { CHAT_PROJECTION_SHADOW_SCHEMA_VERSION } from "../../../../../../contracts/chatProjectionTelemetry";
export type { ChatProjectionShadowDifference } from "../../../../../../contracts/chatProjectionTelemetry";

export interface ChatProjectionShadowComparison {
    canonicalError?: {
        message: string;
        name: string;
    };
    canonicalActiveRunCount?: number;
    canonicalCompactionPhase?: ChatProjectionCompactionPhase;
    canonicalFingerprint?: string;
    canonicalRowCount?: number;
    differenceKinds: ChatProjectionShadowDifference[];
    legacyActiveRunCount: number;
    legacyCompactionPhase: ChatProjectionCompactionPhase;
    legacyFingerprint: string;
    legacyRowCount: number;
    matches: boolean;
    schemaVersion: typeof CHAT_PROJECTION_SHADOW_SCHEMA_VERSION;
    turnCount?: number;
}

export interface CanonicalChatProjection {
    projection: ChatProjection;
    turns: CanonicalChatTurn[];
}

export interface ChatProjectionShadowResult {
    canonical?: CanonicalChatProjection;
    comparison: ChatProjectionShadowComparison;
    legacy: ChatProjection;
}

interface CanonicalTurnDraft {
    entries: CanonicalChatTurnEntry[];
    run?: ChatRunState;
}

function canonicalProjectionErrorMetadata(error: unknown): {
    message: string;
    name: string;
} {
    const name =
        error instanceof Error && /^[A-Za-z][A-Za-z0-9._ -]{0,79}$/.test(error.name)
            ? error.name
            : "UnknownError";
    const message =
        error instanceof Error &&
        (error.message.startsWith("Canonical chat projection invariant failed:") ||
            error.message.startsWith("Canonical chat turn invariant failed:"))
            ? error.message
            : "Unexpected canonical projection failure";
    return { message, name };
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

function canonicalMessage(message: ChatHistoryMessage): CanonicalChatMessage {
    const { provenance: _provenance, ...canonical } = message;
    return canonical;
}

function fingerprintMessage(message: ChatHistoryMessage): unknown {
    return summarizeCanonicalChatValueForFingerprint(canonicalMessage(message));
}

function canonicalEntryKind(message: ChatHistoryMessage): CanonicalChatTurnEntry["kind"] {
    const role = message.role.toLowerCase();
    if (role === "user") {
        return "user";
    }
    if ((role === "assistant" || role === "system") && hasPrimaryAnswerContent(message)) {
        return "assistant";
    }
    if (
        TOOL_ROLE_VARIANTS.includes(role) ||
        message.isToolUse ||
        message.toolCalls?.length ||
        message.toolResult
    ) {
        return "tool";
    }
    return message.thinking?.length && !hasPrimaryAnswerContent(message)
        ? "thinking"
        : "assistant";
}

function canonicalEntrySource(
    message: ChatHistoryMessage
): CanonicalChatTurnEntry["source"] {
    if (message.provenance?.source) {
        return message.provenance.source;
    }
    if (message.local === true) {
        return "dashboard-optimistic";
    }
    return message.runtimeSequence === undefined ? "openclaw-history" : "reconciled";
}

function matchingRun(
    message: ChatHistoryMessage,
    runs: ChatRunState[]
): ChatRunState | undefined {
    return message.runId
        ? runs.find(
              (run) => run.runId === message.runId || run.aliases.includes(message.runId!)
          )
        : undefined;
}

function uniqueEntryId(
    message: ChatHistoryMessage,
    kind: CanonicalChatTurnEntry["kind"],
    source: CanonicalChatTurnEntry["source"],
    occurrences: Map<string, number>
): string {
    const messageValue = canonicalMessage(message);
    const sourceIdentity =
        message.provenance?.id ||
        message.runtimeKey ||
        `fingerprint:${canonicalChatContentFingerprint(
            stableCanonicalChatStringify(
                summarizeCanonicalChatValueForFingerprint(messageValue)
            )
        )}`;
    const base = `entry:${source}:${sourceIdentity}:${kind}`;
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return occurrence === 0 ? base : `${base}:occurrence:${occurrence}`;
}

function canonicalEntry(
    message: ChatHistoryMessage,
    occurrences: Map<string, number>
): CanonicalChatTurnEntry {
    const kind = canonicalEntryKind(message);
    const source = canonicalEntrySource(message);
    return {
        id: uniqueEntryId(message, kind, source, occurrences),
        kind,
        message: canonicalMessage(message),
        origin: message.provenance?.origin,
        provider: message.provenance?.provider,
        relatedSources: message.provenance?.relatedSources,
        sequence:
            source === "openclaw-history"
                ? message.provenance?.sequence
                : (message.runtimeSequence ?? message.provenance?.sequence),
        source,
    };
}

function draftHasAnswer(draft: CanonicalTurnDraft): boolean {
    return draft.entries.some(
        (entry) => entry.kind === "assistant" && hasPrimaryAnswerContent(entry.message)
    );
}

function draftHasResponseContinuation(draft: CanonicalTurnDraft): boolean {
    return draft.entries.some(
        (entry) =>
            entry.kind === "thinking" ||
            entry.kind === "tool" ||
            Boolean(entry.message.toolCalls?.length || entry.message.toolResult)
    );
}

function draftRunId(draft: CanonicalTurnDraft): string | undefined {
    if (draft.run) {
        return draft.run.runId;
    }
    const runIds = new Set(
        draft.entries.flatMap((entry) =>
            entry.message.runId ? [entry.message.runId] : []
        )
    );
    return runIds.size === 1 ? runIds.values().next().value : undefined;
}

function shouldStartTurn(
    draft: CanonicalTurnDraft | undefined,
    entry: CanonicalChatTurnEntry,
    run: ChatRunState | undefined,
    continuesExistingTurn: boolean
): boolean {
    if (!draft) {
        return true;
    }
    const currentRunId = draftRunId(draft);
    const incomingRunId = run?.runId ?? entry.message.runId;
    if (currentRunId && incomingRunId && currentRunId !== incomingRunId) {
        return true;
    }
    if (!currentRunId && incomingRunId && draftHasAnswer(draft)) {
        return true;
    }
    if (entry.kind !== "user") {
        return false;
    }
    if (draft.run && run && draft.run.runId === run.runId) {
        return false;
    }
    if (continuesExistingTurn) {
        return false;
    }
    return draftHasAnswer(draft) || !draftHasResponseContinuation(draft);
}

function uniqueProviders(
    entries: CanonicalChatTurnEntry[]
): CanonicalChatProviderMetadata[] | undefined {
    const providers = new Map<string, CanonicalChatProviderMetadata>();
    for (const provider of entries.flatMap((entry) => [
        ...(entry.provider ? [entry.provider] : []),
        ...(entry.relatedSources || []).flatMap((source) =>
            source.provider ? [source.provider] : []
        ),
    ])) {
        providers.set(stableCanonicalChatStringify(provider), provider);
    }
    const values = providers.values().toArray();
    return values.length > 0 ? values : undefined;
}

function turnSequenceRange(entries: CanonicalChatTurnEntry[]): {
    sequenceEnd?: number;
    sequenceStart?: number;
} {
    const sequences = entries
        .flatMap((entry) => [
            ...(entry.sequence === undefined ? [] : [entry.sequence]),
            ...(entry.relatedSources || []).flatMap((source) =>
                source.sequence === undefined ? [] : [source.sequence]
            ),
        ])
        .toSorted((left, right) => left - right);
    return {
        sequenceEnd: sequences.at(-1),
        sequenceStart: sequences[0],
    };
}

function uniqueTurnId(
    sessionKey: string,
    draft: CanonicalTurnDraft,
    occurrences: Map<string, number>
): string {
    const runId = draftRunId(draft);
    const sourceIdentity = runId ? `run:${runId}` : `entry:${draft.entries[0]!.id}`;
    const base = `turn:${encodeURIComponent(sessionKey)}:${sourceIdentity}`;
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return occurrence === 0 ? base : `${base}:fragment:${occurrence}`;
}

function canonicalTurn(
    sessionKey: string,
    draft: CanonicalTurnDraft,
    occurrences: Map<string, number>
): CanonicalChatTurn {
    const runId = draftRunId(draft);
    return {
        entries: draft.entries,
        id: uniqueTurnId(sessionKey, draft, occurrences),
        lifecycle: draft.run?.phase ?? "unknown",
        providers: uniqueProviders(draft.entries),
        runAliases: draft.run?.aliases,
        runId,
        schemaVersion: CANONICAL_CHAT_TURN_SCHEMA_VERSION,
        ...turnSequenceRange(draft.entries),
        sessionKey,
        startedAt: draft.run?.startedAt,
        terminalAt: draft.run?.terminalAt,
    };
}

function semanticMessage(message: ChatHistoryMessage): string {
    return stableCanonicalChatStringify(fingerprintMessage(message));
}

/**
 * Enforces invariants required before canonical turns can participate in shadow mode.
 * @param turns Canonical turns to validate.
 * @param sessionKey Selected session identity.
 * @param expectedMessages Structured messages represented by the turns.
 */
export function assertCanonicalChatTurnInvariants(
    turns: CanonicalChatTurn[],
    sessionKey: string,
    expectedMessages: ChatHistoryMessage[]
): void {
    const turnIds = new Set<string>();
    const entryIds = new Set<string>();
    for (const turn of turns) {
        if (turn.sessionKey !== sessionKey) {
            throw new Error("Canonical chat turn invariant failed: session");
        }
        if (turnIds.has(turn.id)) {
            throw new Error("Canonical chat turn invariant failed: duplicate turn");
        }
        turnIds.add(turn.id);
        for (const entry of turn.entries) {
            if (entryIds.has(entry.id)) {
                throw new Error("Canonical chat turn invariant failed: duplicate entry");
            }
            entryIds.add(entry.id);
        }
        const range = turnSequenceRange(turn.entries);
        if (
            range.sequenceStart !== turn.sequenceStart ||
            range.sequenceEnd !== turn.sequenceEnd
        ) {
            throw new Error("Canonical chat turn invariant failed: sequence range");
        }
        if (turn.lifecycle === "active" && turn.terminalAt) {
            throw new Error("Canonical chat turn invariant failed: active terminal");
        }
        if (turn.runAliases && new Set(turn.runAliases).size !== turn.runAliases.length) {
            throw new Error("Canonical chat turn invariant failed: duplicate alias");
        }
        const validRunIds = new Set([turn.runId, ...(turn.runAliases || [])]);
        if (
            turn.runId &&
            turn.entries.some(
                (entry) => entry.message.runId && !validRunIds.has(entry.message.runId)
            )
        ) {
            throw new Error("Canonical chat turn invariant failed: entry run");
        }
    }
    const expected = expectedMessages.map((message) => semanticMessage(message));
    const actual = turns.flatMap((turn) =>
        turn.entries.map((entry) =>
            stableCanonicalChatStringify(
                summarizeCanonicalChatValueForFingerprint(entry.message)
            )
        )
    );
    if (stableCanonicalChatStringify(actual) !== stableCanonicalChatStringify(expected)) {
        throw new Error("Canonical chat turn invariant failed: message order");
    }
}

function draftCanonicalChatTurns(
    messages: ChatHistoryMessage[],
    runs: ChatRunState[],
    continuedUserOrdinals: ReadonlySet<number>
): CanonicalTurnDraft[] {
    const entryOccurrences = new Map<string, number>();
    const drafts: CanonicalTurnDraft[] = [];
    let draft: CanonicalTurnDraft | undefined;
    let userOrdinal = 0;
    for (const message of messages) {
        const run = matchingRun(message, runs);
        const entry = canonicalEntry(message, entryOccurrences);
        const continuesExistingTurn =
            entry.kind === "user" && continuedUserOrdinals.has(userOrdinal);
        if (!draft || shouldStartTurn(draft, entry, run, continuesExistingTurn)) {
            draft = { entries: [], run };
            drafts.push(draft);
        } else if (!draft.run && run) {
            draft.run = run;
        }
        draft.entries.push(entry);
        if (entry.kind === "user") {
            userOrdinal += 1;
        }
    }
    return drafts;
}

/**
 * Carries raw response-continuation evidence through thinking reordering.
 * Structuring can move diagnostics, but it preserves user-message order.
 * @param drafts Reconciliation-ordered canonical turn drafts.
 * @returns User ordinals that must remain in the preceding logical turn.
 */
function continuedUserOrdinalsFromDrafts(
    drafts: CanonicalTurnDraft[]
): ReadonlySet<number> {
    const continued = new Set<number>();
    let userOrdinal = 0;
    for (const draft of drafts) {
        let hasPriorUser = false;
        for (const entry of draft.entries) {
            if (entry.kind !== "user") {
                continue;
            }
            if (hasPriorUser) {
                continued.add(userOrdinal);
            }
            hasPriorUser = true;
            userOrdinal += 1;
        }
    }
    return continued;
}

function assembleCanonicalChatTurnsWithContinuations(
    messages: ChatHistoryMessage[],
    runs: ChatRunState[],
    sessionKey: string,
    continuedUsers: ReadonlySet<number>
): CanonicalChatTurn[] {
    const drafts = draftCanonicalChatTurns(messages, runs, continuedUsers);
    const turnOccurrences = new Map<string, number>();
    const turns = parseCanonicalChatTurns(
        drafts.map((candidate) => canonicalTurn(sessionKey, candidate, turnOccurrences)),
        "chatProjection.turns"
    );
    assertCanonicalChatTurnInvariants(turns, sessionKey, messages);
    return turns;
}

/**
 * Assembles structured canonical messages into versioned logical turns.
 * @param messages Structured canonical messages.
 * @param runs Ordered runtime runs.
 * @param sessionKey Selected session identity.
 * @returns Validated canonical turns.
 */
export function assembleCanonicalChatTurns(
    messages: ChatHistoryMessage[],
    runs: ChatRunState[],
    sessionKey: string
): CanonicalChatTurn[] {
    return assembleCanonicalChatTurnsWithContinuations(
        messages,
        runs,
        sessionKey,
        new Set<number>()
    );
}

function structureFromTurns(
    structure: StructuredChatProjection,
    turns: CanonicalChatTurn[]
): StructuredChatProjection {
    return {
        ...structure,
        messages: turns.flatMap((turn) => turn.entries.map((entry) => entry.message)),
    };
}

function semanticRun(run: ChatRunState): unknown {
    return {
        ...run,
        assistant: run.assistant ? fingerprintMessage(run.assistant) : undefined,
        diagnostics: run.diagnostics.map((entry) => ({
            ...entry,
            message: fingerprintMessage(entry.message),
        })),
        userMessages: run.userMessages.map((entry) => ({
            ...entry,
            message: fingerprintMessage(entry.message),
        })),
    };
}

function projectionSections(projection: ChatProjection): Record<string, unknown> {
    return {
        "active-runs": projection.activeRuns.map(semanticRun),
        "compaction-status": projection.compactionStatus,
        rows: projection.rows.map((row) => ({
            ...row,
            message: fingerprintMessage(row.message),
        })),
    };
}

function projectionFingerprint(sections: Record<string, unknown>): string {
    return canonicalChatContentFingerprint(stableCanonicalChatStringify(sections));
}

function projectionCompactionPhase(
    projection: ChatProjection
): ChatProjectionCompactionPhase {
    return projection.compactionStatus?.phase ?? "none";
}

/**
 * Compares legacy and canonical-turn projection without exposing transcript content.
 * @param legacy Existing projection.
 * @param canonical Canonical-turn projection.
 * @param turnCount Number of canonical turns.
 * @returns Versioned parity summary.
 */
export function compareChatProjectionShadow(
    legacy: ChatProjection,
    canonical: ChatProjection,
    turnCount: number
): ChatProjectionShadowComparison {
    const legacySections = projectionSections(legacy);
    const canonicalSections = projectionSections(canonical);
    const differenceKinds = (
        ["active-runs", "compaction-status", "rows"] as const
    ).filter(
        (section) =>
            stableCanonicalChatStringify(legacySections[section]) !==
            stableCanonicalChatStringify(canonicalSections[section])
    );
    return {
        canonicalActiveRunCount: canonical.activeRuns.length,
        canonicalCompactionPhase: projectionCompactionPhase(canonical),
        canonicalFingerprint: projectionFingerprint(canonicalSections),
        canonicalRowCount: canonical.rows.length,
        differenceKinds,
        legacyActiveRunCount: legacy.activeRuns.length,
        legacyCompactionPhase: projectionCompactionPhase(legacy),
        legacyFingerprint: projectionFingerprint(legacySections),
        legacyRowCount: legacy.rows.length,
        matches: differenceKinds.length === 0,
        schemaVersion: CHAT_PROJECTION_SHADOW_SCHEMA_VERSION,
        turnCount,
    };
}

/**
 * Runs canonical turns beside the existing projection and returns legacy output.
 * Canonical failures fail open so shadow mode cannot break the current chat UI.
 * @param history Canonical history messages.
 * @param runtime Canonical runtime state.
 * @param sessionKey Selected session identity.
 * @param visibility Visibility policy.
 * @param shouldKeepThinkingAfterFinal Whether settled thinking remains visible.
 * @param deletedMessageKeys Persisted message deletion identities.
 * @returns Legacy projection plus bounded, content-free shadow parity metadata.
 */
export function projectChatWithCanonicalShadow(
    history: ChatHistoryMessage[],
    runtime: ChatRuntimeState,
    sessionKey: string,
    visibility: ChatVisibilitySettings,
    shouldKeepThinkingAfterFinal: boolean,
    deletedMessageKeys: ReadonlySet<string>
): ChatProjectionShadowResult {
    const context = selectChatProjectionContext(history, runtime, sessionKey);
    const reconciliation = reconcileChatProjectionContext(context);
    const structure = structureChatProjectionContext(reconciliation);
    const presentation = presentChatProjectionContext(
        structure,
        visibility,
        shouldKeepThinkingAfterFinal
    );
    const legacy = finalizeChatProjection(presentation, deletedMessageKeys);
    try {
        assertCanonicalProjectionContext(context);
        assertCanonicalReconciliation(reconciliation, context);
        assertCanonicalStructure(structure, reconciliation);
        const reconciliationContinuations = continuedUserOrdinalsFromDrafts(
            draftCanonicalChatTurns(
                reconciliation.messages,
                context.runs,
                new Set<number>()
            )
        );
        const turns = assembleCanonicalChatTurnsWithContinuations(
            structure.messages,
            context.runs,
            sessionKey,
            reconciliationContinuations
        );
        const canonicalStructure = structureFromTurns(structure, turns);
        const canonicalPresentation = presentChatProjectionContext(
            canonicalStructure,
            visibility,
            shouldKeepThinkingAfterFinal
        );
        assertCanonicalPresentation(
            canonicalPresentation,
            canonicalStructure,
            visibility
        );
        const projection = finalizeChatProjection(
            canonicalPresentation,
            deletedMessageKeys
        );
        assertCanonicalFinalProjection(projection);
        return {
            canonical: { projection, turns },
            comparison: compareChatProjectionShadow(legacy, projection, turns.length),
            legacy,
        };
    } catch (error) {
        return {
            comparison: {
                canonicalError: canonicalProjectionErrorMetadata(error),
                differenceKinds: ["canonical-error"],
                legacyActiveRunCount: legacy.activeRuns.length,
                legacyCompactionPhase: projectionCompactionPhase(legacy),
                legacyFingerprint: projectionFingerprint(projectionSections(legacy)),
                legacyRowCount: legacy.rows.length,
                matches: false,
                schemaVersion: CHAT_PROJECTION_SHADOW_SCHEMA_VERSION,
            },
            legacy,
        };
    }
}
