import type {
    ChatExternalRun,
    ChatMessage,
    ChatRuntimeEvent as ContractChatRuntimeEvent,
    ChatRuntimeSnapshot,
} from "../../contracts/chatModel.ts";
import type {
    ChatExternalRunProjection,
    ChatRuntimeEvent,
    ChatRuntimeSnapshotProjection,
} from "./chatRuntimeStore.ts";
import type {
    ChatDisplayMessage,
    ChatMessageAttachment,
    ChatMessagePart,
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
                    parts.push({
                        callId: part.callId,
                        ...(part.input === undefined ? {} : { input: part.input }),
                        ...(part.isError ? { error: part.output ?? "Tool failed" } : {}),
                        kind: "tool",
                        name: part.name,
                        ...(part.output === undefined ? {} : { output: part.output }),
                        status: toolPartStatus(part.phase),
                    });
                    break;
                }
                case "attachment": {
                    attachments.push({
                        downloadUrl: part.url,
                        id: part.id,
                        mediaType: part.mediaType,
                        name: part.fileName,
                        renderPolicy: part.renderPolicy,
                        sizeBytes: part.sizeBytes ?? 0,
                    });
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
                        text: "Runtime projection detail was omitted by the bounded response. Refreshing canonical history…",
                        tone: "warning",
                    },
                ],
                role: "assistant",
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
                parts.push({
                    callId: part.callId,
                    ...(part.input === undefined ? {} : { input: part.input }),
                    ...(part.isError ? { error: part.output ?? "Tool failed" } : {}),
                    kind: "tool",
                    name: part.name,
                    ...(part.output === undefined ? {} : { output: part.output }),
                    status: toolPartStatus(part.phase),
                });
                break;
            }
            case "item": {
                parts.push({
                    kind: "control",
                    text:
                        part.text === undefined
                            ? part.type
                            : `${part.type}: ${part.text}`,
                    tone: "muted",
                });
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
            text: "Provider outcome remains unresolved after the reconciliation deadline. Refresh canonical history before retrying.",
            tone: "warning",
        });
    }
    return {
        lastSequence: snapshot.throughSequence,
        message: {
            attachments: [],
            clientRunId: snapshot.run.id,
            id: `runtime:${snapshot.run.sessionKey}:${snapshot.run.id}`,
            parts,
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
        ...(userParts.length === 0
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
    const parts: ChatMessagePart[] = [];
    if (!run.projectionTruncated && run.text !== "") {
        parts.push({ kind: "text", text: run.text });
    }
    parts.push({
        kind: "control",
        text: "Provider-origin activity is shown without a local Dashboard admission.",
        tone: "muted",
    });
    if (run.projectionTruncated) {
        parts.push({
            kind: "control",
            text: "Provider-origin projection detail was omitted by the bounded response.",
            tone: "warning",
        });
    }
    if (run.continuity === "interrupted") {
        parts.push({
            kind: "control",
            text: "Provider-origin continuity was interrupted; some activity may be missing.",
            tone: "warning",
        });
    }
    if (run.hasUnprojectedActivity) {
        parts.push({
            kind: "control",
            text: "Additional provider-origin activity could not be projected.",
            tone: "warning",
        });
    }
    return {
        continuity: run.continuity,
        hasUnprojectedActivity: run.hasUnprojectedActivity,
        message: {
            attachments: [],
            id: `external:${run.sessionKey}:${run.providerRunId}`,
            parts,
            role: "assistant",
            sequence: Number.MAX_SAFE_INTEGER - 2,
            sessionKey: run.sessionKey,
            timestampMs: run.updatedAtMs,
        },
        ...(!run.projectionTruncated && run.plan !== undefined
            ? {
                  plan: {
                      items: run.plan.steps.map((step, index) => ({
                          id: `provider:${run.providerRunId}:plan:${index}`,
                          label: step.text,
                          status:
                              step.status === "in_progress"
                                  ? ("in-progress" as const)
                                  : step.status,
                      })),
                      runId: `provider:${run.providerRunId}`,
                      title: "Provider-origin plan",
                  },
              }
            : {}),
        projectionTruncated: run.projectionTruncated,
        providerRunId: run.providerRunId,
        source: run.source,
    };
}
