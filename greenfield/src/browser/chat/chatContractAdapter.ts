import type {
    ChatExternalRun,
    ChatMessage,
    ChatMessagePart as ContractChatMessagePart,
    ChatRuntimeEvent as ContractChatRuntimeEvent,
    ChatRuntimeSnapshot,
} from "../../contracts/chatModel.ts";
import type {
    ChatExternalRunProjection,
    ChatExternalRunSegmentProjection,
    ChatRuntimeEvent,
    ChatRuntimeSnapshotProjection,
} from "./chatRuntimeStore.ts";
import type {
    ChatDisplayMessage,
    ChatMessageAttachment,
    ChatMessagePart,
    ChatToolPart,
} from "./chatTypes.ts";

function contractLocalRunId(message: ChatMessage): string | undefined {
    return message.localRunId;
}

function toolPartStatus(
    phase: "failed" | "running" | "started" | "succeeded"
): "completed" | "failed" | "running" {
    if (phase === "failed") return "failed";
    if (phase === "succeeded") return "completed";
    return "running";
}

function messageRole(role: ChatMessage["role"]): ChatDisplayMessage["role"] {
    if (role === "user") return "user";
    if (role === "assistant") return "assistant";
    return "control";
}

/**
 * Converges split provider tool lifecycle rows without losing the original input.
 * Terminal observations are never downgraded by a later replayed running marker.
 * @param previous Existing call projection.
 * @param current Newer call or result projection for the same exact call id.
 * @returns One complete tool part suitable for a single disclosure bubble.
 */
export function mergeChatToolPart(
    previous: ChatToolPart,
    current: ChatToolPart
): ChatToolPart {
    const previousIsTerminal = previous.status !== "running";
    const currentIsTerminal = current.status !== "running";
    const terminal = previousIsTerminal && !currentIsTerminal ? previous : current;
    const named = previous.nameSource === "synthetic" ? current : previous;
    return {
        callId: previous.callId,
        ...((previous.callIdSource ?? current.callIdSource) === undefined
            ? {}
            : { callIdSource: "synthetic" as const }),
        ...((current.error ?? previous.error) === undefined
            ? {}
            : { error: current.error ?? previous.error }),
        ...((previous.input ?? current.input) === undefined
            ? {}
            : { input: previous.input ?? current.input }),
        kind: "tool",
        name: named.name,
        ...(named.nameSource === undefined ? {} : { nameSource: named.nameSource }),
        ...((current.output ?? previous.output) === undefined
            ? {}
            : { output: current.output ?? previous.output }),
        status: terminal.status,
    };
}

/**
 * Matches exact provider IDs, or the latest still-running same-name fallback call.
 * @param call Previously rendered tool call.
 * @param result Terminal tool result being reconciled.
 * @returns Whether the result can safely complete this call.
 */
export function chatToolResultMatchesCall(
    call: ChatToolPart,
    result: ChatToolPart
): boolean {
    if (call.status !== "running" || result.status === "running") return false;
    const usesSyntheticIdentity =
        call.callIdSource === "synthetic" || result.callIdSource === "synthetic";
    if (usesSyntheticIdentity) {
        return (
            call.callIdSource === "synthetic" &&
            result.callIdSource === "synthetic" &&
            call.nameSource !== "synthetic" &&
            result.nameSource !== "synthetic" &&
            call.name === result.name
        );
    }
    return call.callId === result.callId;
}

function appendChatMessagePart(parts: ChatMessagePart[], part: ChatMessagePart): void {
    if (part.kind !== "tool") {
        parts.push(part);
        return;
    }
    const index = parts.findIndex(
        (candidate) =>
            candidate.kind === "tool" && chatToolResultMatchesCall(candidate, part)
    );
    if (index === -1) {
        parts.push(part);
        return;
    }
    const previous = parts[index];
    if (previous?.kind === "tool") parts[index] = mergeChatToolPart(previous, part);
}

function projectContractAttachment(
    part: Extract<ContractChatMessagePart, { kind: "attachment" }>
): ChatMessageAttachment {
    return {
        downloadUrl: part.downloadUrl ?? part.url,
        id: part.id,
        mediaType: part.mediaType,
        name: part.fileName,
        ...(part.renderPolicy === "download-only" ? {} : { previewUrl: part.url }),
        renderPolicy: part.renderPolicy,
        sizeBytes: part.sizeBytes ?? 0,
    };
}

/**
 * Projects one canonical contract message into the pure browser view model.
 * @param message Validated provider history row.
 * @param sessionKey Exact selected provider session.
 * @param fallbackSequence Stable page-order fallback.
 * @returns Safe browser display message.
 */
export function projectChatContractMessage(
    message: ChatMessage,
    sessionKey: string,
    fallbackSequence: number
): ChatDisplayMessage {
    const parts: ChatMessagePart[] = [];
    const attachments: ChatMessageAttachment[] = [];
    if (message.content.kind === "hydration-required") {
        parts.push({
            kind: "control",
            text: message.content.preview ?? "Message content requires hydration.",
            tone: "warning",
        });
        for (const part of message.content.attachments ?? []) {
            if (part.kind === "attachment") {
                attachments.push(projectContractAttachment(part));
            }
        }
    } else {
        for (const part of message.content.parts) {
            switch (part.kind) {
                case "text": {
                    parts.push({ kind: "text", text: part.text });
                    break;
                }
                case "thinking": {
                    parts.push({ kind: "thinking", status: "complete", text: part.text });
                    break;
                }
                case "tool": {
                    appendChatMessagePart(parts, {
                        callId: part.callId,
                        ...(part.callIdSource === undefined
                            ? {}
                            : { callIdSource: part.callIdSource }),
                        ...(part.input === undefined ? {} : { input: part.input }),
                        ...(part.isError ? { error: part.output ?? "Tool failed" } : {}),
                        kind: "tool",
                        name: part.name,
                        ...(part.nameSource === undefined
                            ? {}
                            : { nameSource: part.nameSource }),
                        ...(part.output === undefined ? {} : { output: part.output }),
                        status: toolPartStatus(part.phase),
                    });
                    break;
                }
                case "attachment": {
                    attachments.push(projectContractAttachment(part));
                    break;
                }
                case "control": {
                    parts.push({ kind: "control", text: part.text, tone: "muted" });
                    break;
                }
            }
        }
    }
    const localRunId = contractLocalRunId(message);
    return {
        attachments,
        ...(localRunId === undefined ? {} : { clientRunId: localRunId }),
        delivery: "sent",
        id: message.id,
        ...(message.content.kind === "hydration-required"
            ? { hydration: "required" as const }
            : {}),
        ...(message.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: message.idempotencyKey }),
        parts,
        ...(message.runId === undefined ? {} : { providerRunId: message.runId }),
        role: messageRole(message.role),
        ...(localRunId === undefined ? {} : { runId: localRunId }),
        sequence: message.sequence ?? fallbackSequence,
        sessionKey,
        ...(message.createdAtMs === undefined
            ? {}
            : { timestampMs: message.createdAtMs }),
    };
}

function statusLabel(
    phase:
        | "preparing-context"
        | "preparing-workspace"
        | "provisioning-environment"
        | "starting-model"
): string {
    switch (phase) {
        case "preparing-context": {
            return "Preparing context…";
        }
        case "preparing-workspace": {
            return "Preparing workspace…";
        }
        case "provisioning-environment": {
            return "Provisioning environment…";
        }
        case "starting-model": {
            return "Starting model…";
        }
    }
}

/**
 * Adapts the strict contract event vocabulary without casting it into reducer events.
 * @param sessionKey Session scope carried by the runtime query envelope.
 * @param cursor Durable process-global delivery cursor used for monotonic dedupe.
 * @param event Validated contract event.
 * @returns One explicit browser reducer event.
 */
export function adaptChatRuntimeEvent(
    sessionKey: string,
    cursor: string,
    event: ContractChatRuntimeEvent
): ChatRuntimeEvent {
    const base = {
        cursor: Number(cursor),
        eventId: `chat-runtime:${cursor}`,
        occurredAtMs: event.occurredAtMs,
        runId: event.runId,
        sequence: event.sequence,
        sessionKey,
    } as const;
    switch (event.kind) {
        case "user": {
            return {
                ...base,
                ...(event.attachmentTicketId === undefined
                    ? {}
                    : { attachmentTicketId: event.attachmentTicketId }),
                kind: "user",
                idempotencyKey: event.idempotencyKey,
                text: event.text,
            };
        }
        case "assistant":
        case "thinking": {
            return {
                ...base,
                kind: event.kind,
                mode: event.mode,
                text: event.text,
            };
        }
        case "tool": {
            if (event.phase === "failed") {
                return {
                    ...base,
                    callId: event.callId,
                    ...(event.output === undefined ? {} : { error: event.output }),
                    kind: "tool-failed",
                    ...(event.output === undefined ? {} : { output: event.output }),
                };
            }
            if (event.phase === "succeeded") {
                return {
                    ...base,
                    callId: event.callId,
                    kind: "tool-completed",
                    ...(event.output === undefined ? {} : { output: event.output }),
                };
            }
            return {
                ...base,
                callId: event.callId,
                ...(event.input === undefined ? {} : { input: event.input }),
                kind: "tool-started",
                name: event.name,
            };
        }
        case "item": {
            return {
                ...base,
                kind: "control",
                text:
                    event.text === undefined
                        ? event.itemType
                        : `${event.itemType}: ${event.text}`,
                tone: "muted",
            };
        }
        case "status": {
            return {
                ...base,
                kind: "control",
                text: statusLabel(event.phase),
                tone: "muted",
            };
        }
        case "plan": {
            return {
                ...base,
                ...(event.explanation === undefined
                    ? {}
                    : { explanation: event.explanation }),
                kind: "plan",
                steps: event.steps,
            };
        }
        case "provider-noop": {
            return { ...base, kind: "noop" };
        }
        case "cancel": {
            return {
                ...base,
                kind: "control",
                text:
                    event.source === "operator"
                        ? "Cancellation requested."
                        : "The provider requested cancellation.",
                tone: "warning",
            };
        }
        case "terminal": {
            if (event.outcome === "completed") return { ...base, kind: "final" };
            if (event.outcome === "aborted") {
                return {
                    ...base,
                    kind: "aborted",
                    text: event.errorMessage ?? "Response stopped.",
                };
            }
            return {
                ...base,
                kind: "failed",
                text: event.errorMessage ?? "Response failed.",
            };
        }
        case "interrupted": {
            return { ...base, kind: "interrupted" };
        }
        case "reconciled": {
            return { ...base, kind: "reconciled" };
        }
    }
}

function snapshotPhase(
    snapshot: ChatRuntimeSnapshot
): ChatRuntimeSnapshotProjection["phase"] {
    switch (snapshot.run.state) {
        case "cancelled": {
            return "aborted";
        }
        case "completed": {
            return "completed";
        }
        case "failed": {
            return "failed";
        }
        case "unresolved": {
            return "unresolved";
        }
        case "interrupted": {
            return "unresolved";
        }
        default: {
            return "active";
        }
    }
}

/**
 * Projects one restart snapshot without pretending its grouped fields are deltas.
 * @param snapshot Authoritative durable run snapshot.
 * @returns Browser reducer restart projection.
 */
export function projectChatRuntimeSnapshot(
    snapshot: ChatRuntimeSnapshot
): ChatRuntimeSnapshotProjection {
    if (snapshot.projectionTruncated) {
        return {
            lastSequence: snapshot.throughSequence,
            message: {
                attachments: [],
                clientRunId: snapshot.run.id,
                id: `runtime:${snapshot.run.sessionKey}:${snapshot.run.id}`,
                parts: [
                    {
                        kind: "control",
                        text: "Some live response details were not returned. Refreshing chat history…",
                        tone: "warning",
                    },
                ],
                role: "assistant",
                ...(snapshot.run.providerRunId === undefined
                    ? {}
                    : { providerRunId: snapshot.run.providerRunId }),
                runId: snapshot.run.id,
                sequence: snapshot.firstSequence,
                sessionKey: snapshot.run.sessionKey,
                timestampMs: snapshot.run.admittedAtMs,
            },
            phase: snapshotPhase(snapshot),
            projectionTruncated: true,
            reconciliation: snapshot.run.reconciliation,
            runId: snapshot.run.id,
            updatedAtMs: snapshot.run.updatedAtMs,
        };
    }
    const parts: ChatMessagePart[] = [];
    const userParts: ChatMessagePart[] = [];
    for (const part of snapshot.parts) {
        switch (part.kind) {
            case "assistant": {
                parts.push({ kind: "text", text: part.text });
                break;
            }
            case "thinking": {
                parts.push({
                    kind: "thinking",
                    status: snapshot.run.state === "completed" ? "complete" : "running",
                    text: part.text,
                });
                break;
            }
            case "tool": {
                appendChatMessagePart(parts, {
                    callId: part.callId,
                    ...(part.callIdSource === undefined
                        ? {}
                        : { callIdSource: part.callIdSource }),
                    ...(part.input === undefined ? {} : { input: part.input }),
                    ...(part.isError ? { error: part.output ?? "Tool failed" } : {}),
                    kind: "tool",
                    name: part.name,
                    ...(part.nameSource === undefined
                        ? {}
                        : { nameSource: part.nameSource }),
                    ...(part.output === undefined ? {} : { output: part.output }),
                    status: toolPartStatus(part.phase),
                });
                break;
            }
            case "item": {
                break;
            }
            case "user": {
                userParts.push({ kind: "text", text: part.text });
                break;
            }
        }
    }
    if (snapshot.run.state === "unresolved") {
        parts.push({
            kind: "control",
            text: "OpenClaw still has not confirmed the result. Refresh chat history before trying again.",
            tone: "warning",
        });
    }
    // Definitive pre-ack failures remain durable audit rows, but never became
    // provider transcript messages and must not reappear as sent after refresh.
    const userMessageWasAccepted = !(
        snapshot.run.state === "failed" && snapshot.run.providerRunId === undefined
    );
    return {
        lastSequence: snapshot.throughSequence,
        message: {
            attachments: [],
            clientRunId: snapshot.run.id,
            id: `runtime:${snapshot.run.sessionKey}:${snapshot.run.id}`,
            parts,
            ...(snapshot.run.providerRunId === undefined
                ? {}
                : { providerRunId: snapshot.run.providerRunId }),
            role: "assistant",
            runId: snapshot.run.id,
            sequence: snapshot.firstSequence,
            sessionKey: snapshot.run.sessionKey,
            timestampMs: snapshot.run.admittedAtMs,
        },
        phase: snapshotPhase(snapshot),
        projectionTruncated: false,
        reconciliation: snapshot.run.reconciliation,
        ...(snapshot.plan === undefined
            ? {}
            : {
                  plan: {
                      ...(snapshot.plan.explanation === undefined
                          ? {}
                          : { description: snapshot.plan.explanation }),
                      items: snapshot.plan.steps.map((step, index) => ({
                          id: `${snapshot.run.id}:plan:${index}`,
                          label: step.text,
                          status:
                              step.status === "in_progress"
                                  ? ("in-progress" as const)
                                  : step.status,
                      })),
                      runId: snapshot.run.id,
                      title: "Active plan",
                  },
              }),
        runId: snapshot.run.id,
        updatedAtMs: snapshot.run.updatedAtMs,
        ...(!userMessageWasAccepted || userParts.length === 0
            ? {}
            : {
                  userMessage: {
                      attachments: [],
                      clientRunId: snapshot.run.id,
                      delivery: "sent" as const,
                      id: `runtime-user:${snapshot.run.sessionKey}:${snapshot.run.id}`,
                      parts: userParts,
                      role: "user" as const,
                      runId: snapshot.run.id,
                      sequence: snapshot.firstSequence,
                      sessionKey: snapshot.run.sessionKey,
                      timestampMs: snapshot.run.admittedAtMs,
                  },
              }),
    };
}

/**
 * Projects provider-origin activity without claiming a local admission or user actor.
 * @param run Bounded provider projection returned by the runtime procedure.
 * @returns Honest read-only assistant projection with explicit continuity markers.
 */
export function projectChatExternalRun(run: ChatExternalRun): ChatExternalRunProjection {
    const segments: ChatExternalRunSegmentProjection[] = [];
    const createSegment = (
        segmentId: string,
        providerSequence: number,
        parts: readonly ChatMessagePart[],
        precedingUserText?: string,
        role: ChatDisplayMessage["role"] = "assistant",
        timestampMs = run.updatedAtMs,
        precedingUserMessageId?: string,
        attachments: readonly ChatMessageAttachment[] = []
    ): ChatExternalRunSegmentProjection => ({
        message: {
            attachments,
            id: `external:${run.sessionKey}:${run.providerRunId}:segment:${segmentId}`,
            parts,
            providerRunId: run.providerRunId,
            role,
            sequence: providerSequence,
            sessionKey: run.sessionKey,
            timestampMs,
        },
        ...(precedingUserMessageId === undefined ? {} : { precedingUserMessageId }),
        ...(precedingUserText === undefined ? {} : { precedingUserText }),
        providerSequence,
        segmentId,
    });
    const replaceSegmentParts = (
        index: number,
        parts: readonly ChatMessagePart[]
    ): void => {
        const previous = segments[index];
        if (previous === undefined) return;
        segments[index] = {
            ...previous,
            message: { ...previous.message, parts },
        };
    };
    const upsertSinglePart = (
        segmentId: string,
        providerSequence: number,
        part: ChatMessagePart,
        timestampMs?: number
    ): void => {
        const existingIndex = segments.findIndex(
            (segment) => segment.segmentId === segmentId
        );
        if (existingIndex === -1) {
            segments.push(
                createSegment(
                    segmentId,
                    providerSequence,
                    [part],
                    undefined,
                    "assistant",
                    timestampMs
                )
            );
            return;
        }
        replaceSegmentParts(existingIndex, [part]);
    };
    if (run.parts !== undefined && run.parts.length > 0) {
        for (const part of run.parts) {
            switch (part.kind) {
                case "assistant": {
                    upsertSinglePart(
                        `assistant:${part.segmentId ?? part.sequence}`,
                        part.sequence,
                        {
                            kind: "text",
                            ...(part.segmentId === undefined
                                ? {}
                                : {
                                      sourceKey: `${run.providerRunId}:${part.segmentId}`,
                                  }),
                            ...(part.streamId === undefined
                                ? {}
                                : {
                                      sourceStreamKey: `${run.providerRunId}:${part.streamId}`,
                                  }),
                            text: part.text,
                        },
                        part.occurredAtMs
                    );
                    break;
                }
                case "thinking": {
                    upsertSinglePart(
                        `thinking:${part.segmentId ?? part.sequence}`,
                        part.sequence,
                        {
                            kind: "thinking",
                            ...(part.segmentId === undefined
                                ? {}
                                : {
                                      sourceKey: `${run.providerRunId}:${part.segmentId}`,
                                  }),
                            ...(part.streamId === undefined
                                ? {}
                                : {
                                      sourceStreamKey: `${run.providerRunId}:${part.streamId}`,
                                  }),
                            status:
                                run.lifecycle === "terminal-pending-history"
                                    ? "complete"
                                    : "running",
                            text: part.text,
                        },
                        part.occurredAtMs
                    );
                    break;
                }
                case "tool": {
                    const projectedTool: ChatToolPart = {
                        callId: part.callId,
                        ...(part.callIdSource === undefined
                            ? {}
                            : { callIdSource: part.callIdSource }),
                        ...(part.input === undefined ? {} : { input: part.input }),
                        ...(part.isError ? { error: part.output ?? "Tool failed" } : {}),
                        kind: "tool",
                        name: part.name,
                        ...(part.nameSource === undefined
                            ? {}
                            : { nameSource: part.nameSource }),
                        ...(part.output === undefined ? {} : { output: part.output }),
                        status:
                            run.lifecycle === "terminal-pending-history" &&
                            toolPartStatus(part.phase) === "running"
                                ? "completed"
                                : toolPartStatus(part.phase),
                    };
                    const matchingSyntheticIndex = segments.findIndex((segment) =>
                        segment.message.parts.some(
                            (candidate) =>
                                candidate.kind === "tool" &&
                                chatToolResultMatchesCall(candidate, projectedTool)
                        )
                    );
                    const directSegmentId = `tool:${part.callId}`;
                    const directIndex = segments.findIndex(
                        (segment) => segment.segmentId === directSegmentId
                    );
                    const existingIndex =
                        directIndex === -1 ? matchingSyntheticIndex : directIndex;
                    const segmentId =
                        existingIndex === -1
                            ? directSegmentId
                            : (segments[existingIndex]?.segmentId ?? directSegmentId);
                    const toolParts =
                        existingIndex === -1
                            ? []
                            : [...(segments[existingIndex]?.message.parts ?? [])];
                    appendChatMessagePart(toolParts, projectedTool);
                    if (existingIndex === -1) {
                        segments.push(
                            createSegment(
                                segmentId,
                                part.sequence,
                                toolParts,
                                undefined,
                                "assistant",
                                part.occurredAtMs
                            )
                        );
                    } else {
                        replaceSegmentParts(existingIndex, toolParts);
                    }
                    break;
                }
                case "item": {
                    if (
                        part.type === "compaction" &&
                        (part.text === "Compacting context" ||
                            part.text === "Context compacted")
                    ) {
                        const activity =
                            run.lifecycle === "active" &&
                            part.text === "Compacting context"
                                ? "running"
                                : "complete";
                        upsertSinglePart(`compaction:${part.id}`, part.sequence, {
                            activity,
                            kind: "control",
                            text: part.text,
                            tone: "muted",
                        });
                        const compactionIndex = segments.findIndex(
                            (segment) => segment.segmentId === `compaction:${part.id}`
                        );
                        const compaction = segments[compactionIndex];
                        if (compaction !== undefined && part.occurredAtMs !== undefined) {
                            segments[compactionIndex] = {
                                ...compaction,
                                message: {
                                    ...compaction.message,
                                    timestampMs: part.occurredAtMs,
                                },
                            };
                        }
                    }
                    break;
                }
                case "user": {
                    const segmentId =
                        part.messageId === undefined
                            ? `user:${part.sequence}`
                            : `user:${part.messageId}`;
                    segments.push(
                        createSegment(
                            segmentId,
                            part.sequence,
                            [],
                            part.text,
                            "assistant",
                            part.occurredAtMs,
                            part.messageId,
                            part.attachments
                                ?.filter((attachment) => attachment.kind === "attachment")
                                .map((attachment) =>
                                    projectContractAttachment(attachment)
                                ) ?? []
                        )
                    );
                    break;
                }
            }
        }
    }
    const assistantSegmentIndexes = segments.flatMap((segment, index) =>
        segment.message.parts.some((part) => part.kind === "text") ? [index] : []
    );
    const renderedAssistantText = assistantSegmentIndexes
        .map((index) => {
            const segment = segments[index];
            return segment?.message.parts
                .filter((part) => part.kind === "text")
                .map((part) => (part.kind === "text" ? part.text : ""))
                .join("");
        })
        .join("");
    if (run.text !== "" && renderedAssistantText !== run.text) {
        const lastAssistantIndex = assistantSegmentIndexes.at(-1);
        if (
            lastAssistantIndex !== undefined &&
            run.text.startsWith(renderedAssistantText)
        ) {
            const previous = segments[lastAssistantIndex];
            if (previous !== undefined) {
                const previousPartIndex = previous.message.parts.findLastIndex(
                    (part) => part.kind === "text"
                );
                const previousPart = previous.message.parts[previousPartIndex];
                if (previousPart?.kind === "text") {
                    replaceSegmentParts(
                        lastAssistantIndex,
                        previous.message.parts.map((part, index) =>
                            index === previousPartIndex
                                ? {
                                      ...previousPart,
                                      text:
                                          previousPart.text +
                                          run.text.slice(renderedAssistantText.length),
                                  }
                                : part
                        )
                    );
                }
            }
        } else if (lastAssistantIndex === undefined) {
            segments.push(
                createSegment("aggregate:assistant", Number.MAX_SAFE_INTEGER - 4, [
                    {
                        kind: "text",
                        sourceKey: `${run.providerRunId}:aggregate:assistant`,
                        sourceStreamKey: `${run.providerRunId}:assistant`,
                        text: run.text,
                    },
                ])
            );
        } else {
            const insertionIndex = assistantSegmentIndexes[0] ?? segments.length;
            const aggregateProviderSequence =
                segments[insertionIndex]?.providerSequence ?? Number.MAX_SAFE_INTEGER - 4;
            const retained = segments.filter(
                (segment) => !segment.message.parts.some((part) => part.kind === "text")
            );
            retained.splice(
                Math.min(insertionIndex, retained.length),
                0,
                createSegment("aggregate:assistant", aggregateProviderSequence, [
                    {
                        kind: "text",
                        sourceKey: `${run.providerRunId}:aggregate:assistant`,
                        sourceStreamKey: `${run.providerRunId}:assistant`,
                        text: run.text,
                    },
                ])
            );
            segments.splice(0, segments.length, ...retained);
        }
    }
    if (
        run.lifecycle === "active" &&
        run.continuity === "interrupted" &&
        run.text.trim() === ""
    ) {
        const gapPart: ChatMessagePart = {
            kind: "control",
            text: "Some OpenClaw activity may be missing because updates were interrupted.",
            tone: "warning",
        };
        const lastContentIndex = segments.findLastIndex(
            (segment) => segment.message.parts.length > 0
        );
        if (lastContentIndex === -1) {
            segments.push(
                createSegment(
                    "notice:activity-gap",
                    Number.MAX_SAFE_INTEGER - 1,
                    [gapPart],
                    undefined,
                    "control"
                )
            );
        } else {
            const previous = segments[lastContentIndex];
            if (previous !== undefined) {
                segments[lastContentIndex] = {
                    ...previous,
                    message: {
                        ...previous.message,
                        parts: [...previous.message.parts, gapPart],
                    },
                };
            }
        }
    }
    let followingOutput = false;
    for (let index = segments.length - 1; index >= 0; index -= 1) {
        const segment = segments[index];
        if (segment === undefined) continue;
        const nextParts = [...segment.message.parts];
        for (let partIndex = nextParts.length - 1; partIndex >= 0; partIndex -= 1) {
            const part = nextParts[partIndex];
            if (part?.kind === "thinking" && followingOutput) {
                nextParts[partIndex] = { ...part, status: "complete" };
            } else if (part?.kind === "text" || part?.kind === "tool") {
                followingOutput = true;
            }
        }
        segments[index] = {
            ...segment,
            message: { ...segment.message, parts: nextParts },
        };
    }
    const parts = segments.flatMap((segment) => segment.message.parts);
    return {
        ...(run.abortBoundary === undefined ? {} : { abortBoundary: run.abortBoundary }),
        continuity: run.continuity,
        hasUnprojectedActivity: run.hasUnprojectedActivity,
        lifecycle: run.lifecycle,
        message: {
            attachments: [],
            id: `external:${run.sessionKey}:${run.providerRunId}`,
            parts,
            providerRunId: run.providerRunId,
            role: "assistant",
            sequence: Number.MAX_SAFE_INTEGER - 2,
            sessionKey: run.sessionKey,
            timestampMs: run.updatedAtMs,
        },
        observationEpoch: run.observationEpoch,
        observedAtMs: run.observedAtMs,
        ...(run.plan === undefined
            ? {}
            : {
                  plan: {
                      ...(run.plan.explanation === undefined
                          ? {}
                          : { description: run.plan.explanation }),
                      items: run.plan.steps.map((step, index) => ({
                          id: `provider:${run.providerRunId}:plan:${index}`,
                          label: step.text,
                          status:
                              step.status === "in_progress"
                                  ? ("in-progress" as const)
                                  : step.status,
                      })),
                      runId: `provider:${run.providerRunId}`,
                      title: "OpenClaw plan",
                  },
              }),
        projectionTruncated: run.projectionTruncated,
        providerRunId: run.providerRunId,
        segments,
        source: run.source,
        ...(run.streamResets === undefined
            ? {}
            : {
                  streamResets: run.streamResets.map(({ resetId, streamId }) => ({
                      resetKey: `${run.providerRunId}:${resetId}`,
                      sourceStreamKey: `${run.providerRunId}:${streamId}`,
                  })),
              }),
        updatedAtMs: run.updatedAtMs,
    };
}
