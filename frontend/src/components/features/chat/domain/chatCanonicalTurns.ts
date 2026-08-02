import type {
    CanonicalChatMessage,
    CanonicalChatProviderMetadata,
} from "../../../../../../contracts/chat/canonical";
import {
    canonicalChatContentFingerprint,
    summarizeCanonicalChatValueForFingerprint,
} from "../../../../../../contracts/chat/canonicalContentIdentity";
import {
    CANONICAL_CHAT_TURN_SCHEMA_VERSION,
    parseCanonicalChatTurns,
    type CanonicalChatTurn,
    type CanonicalChatTurnEntry,
} from "../../../../../../contracts/chat/canonicalTurn";
import { stableCanonicalChatStringify } from "../../../../../../contracts/chat/canonicalUtilities";
import type { ChatHistoryMessage } from "../chatTypes";
import { TOOL_ROLE_VARIANTS } from "../chatTypes";
import { hasPrimaryAnswerContent } from "./chatAnswerContent";
import type { StructuredChatProjection } from "./chatProjection";
import type { ChatRunState } from "./chatState";

interface CanonicalTurnDraft {
    entries: CanonicalChatTurnEntry[];
    run?: ChatRunState;
}

function canonicalMessage(message: ChatHistoryMessage): CanonicalChatMessage {
    const { provenance: _provenance, ...canonical } = message;
    return canonical;
}

function canonicalEntryKind(message: ChatHistoryMessage): CanonicalChatTurnEntry["kind"] {
    if (message.intent === "commentary") return "commentary";
    if (message.intent === "control") return "control";
    const role = message.role.toLowerCase();
    if (role === "user") return "user";
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
    if (message.provenance?.source) return message.provenance.source;
    if (message.local === true) return "dashboard-optimistic";
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
    if (draft.run) return draft.run.runId;
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
    if (!draft) return true;
    const currentRunId = draftRunId(draft);
    const incomingRunId = run?.runId ?? entry.message.runId;
    if (currentRunId && incomingRunId && currentRunId !== incomingRunId) return true;
    if (!currentRunId && incomingRunId && draftHasAnswer(draft)) return true;
    if (entry.kind !== "user") return false;
    if (draft.run && run && draft.run.runId === run.runId) return false;
    if (continuesExistingTurn) return false;
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
    return { sequenceEnd: sequences.at(-1), sequenceStart: sequences[0] };
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
    return stableCanonicalChatStringify(
        summarizeCanonicalChatValueForFingerprint(canonicalMessage(message))
    );
}

function assertCanonicalChatTurnInvariants(
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
        if (entry.kind === "user") userOrdinal += 1;
    }
    return drafts;
}

function continuedUserOrdinalsFromDrafts(
    drafts: CanonicalTurnDraft[]
): ReadonlySet<number> {
    const continued = new Set<number>();
    let userOrdinal = 0;
    for (const draft of drafts) {
        let hasPriorUser = false;
        for (const entry of draft.entries) {
            if (entry.kind !== "user") continue;
            if (hasPriorUser) continued.add(userOrdinal);
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

// Assembles structured canonical messages into versioned logical turns.
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
    let messageIndex = 0;
    const messages = turns.flatMap((turn) =>
        turn.entries.map((entry) => {
            const sourceMessage = structure.messages[messageIndex];
            messageIndex += 1;
            return sourceMessage?.provenance
                ? { ...entry.message, provenance: sourceMessage.provenance }
                : entry.message;
        })
    );
    if (messageIndex !== structure.messages.length) {
        throw new Error("Canonical chat projection invariant failed: turn coverage");
    }
    return { ...structure, messages };
}

export function canonicalizeStructuredChatTurns(
    reconciliationMessages: ChatHistoryMessage[],
    structure: StructuredChatProjection,
    runs: ChatRunState[],
    sessionKey: string
): { structure: StructuredChatProjection; turns: CanonicalChatTurn[] } {
    const reconciliationContinuations = continuedUserOrdinalsFromDrafts(
        draftCanonicalChatTurns(reconciliationMessages, runs, new Set<number>())
    );
    const turns = assembleCanonicalChatTurnsWithContinuations(
        structure.messages,
        runs,
        sessionKey,
        reconciliationContinuations
    );
    return { structure: structureFromTurns(structure, turns), turns };
}
