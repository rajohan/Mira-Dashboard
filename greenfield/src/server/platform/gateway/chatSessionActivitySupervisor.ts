import type { ChatService } from "../../domains/chat/service.ts";
import {
    projectPersistentGatewaySessionAttachments,
    type PersistentGatewayChatMediaReferenceRegistrar,
} from "./persistentGatewayChatProvider.ts";
import type { PersistentGatewayTransport } from "./persistentGatewayTransport.ts";

export interface ChatSessionActivitySupervisor {
    readonly stop: () => Promise<void>;
}

export interface ChatSessionActivitySupervisorOptions {
    readonly chat: Pick<
        ChatService,
        "observeProviderUserMessage" | "reconcileProviderSessionActivity"
    >;
    readonly onFailure?: (error: unknown) => void;
    readonly mediaReferences: PersistentGatewayChatMediaReferenceRegistrar;
    readonly transport: Pick<PersistentGatewayTransport, "subscribe">;
}

const pendingUserMessageMaximum = 256;

/**
 * Reconciles canonical chat history when Gateway accepts or persists chat activity.
 *
 * Raw chat streams remain the low-latency source for partial assistant, thinking,
 * and tool activity. `sessions.changed` signals accepted user input, while the
 * canonical `session.message` event closes persisted message and terminal state.
 * Persisted user text uses an independent bounded lane so slow canonical history
 * cannot delay the optimistic message. Session reconciliation remains serialized.
 * @param options Validated chat service and persistent Gateway transport.
 * @returns A process-owned supervisor with bounded asynchronous disposal.
 */
export function createChatSessionActivitySupervisor(
    options: ChatSessionActivitySupervisorOptions
): ChatSessionActivitySupervisor {
    const pending = new Set<string>();
    const pendingUserMessages = new Map<
        string,
        Parameters<ChatService["observeProviderUserMessage"]>[0]
    >();
    let activeReconciliation: Promise<unknown> = Promise.resolve();
    let activeUserMessages: Promise<unknown> = Promise.resolve();
    let reconciliationDrainScheduled = false;
    let userDrainScheduled = false;
    let stopped = false;

    const report = (error: unknown): void => {
        try {
            options.onFailure?.(error);
        } catch {
            // Reporting cannot replace the canonical reconciliation lane.
        }
    };
    const scheduleReconciliationDrain = (): void => {
        if (stopped || reconciliationDrainScheduled) return;
        reconciliationDrainScheduled = true;
        queueMicrotask(() => {
            reconciliationDrainScheduled = false;
            if (stopped || pending.size === 0) return;
            activeReconciliation = activeReconciliation
                .then(async () => {
                    while (!stopped && pending.size > 0) {
                        const sessionKey = pending.values().next().value;
                        if (sessionKey === undefined) return true;
                        pending.delete(sessionKey);
                        try {
                            await options.chat.reconcileProviderSessionActivity(
                                sessionKey
                            );
                        } catch (error) {
                            report(error);
                        }
                    }
                    return true;
                })
                .catch(report);
        });
    };
    const scheduleUserDrain = (): void => {
        if (stopped || userDrainScheduled) return;
        userDrainScheduled = true;
        queueMicrotask(() => {
            userDrainScheduled = false;
            if (stopped || pendingUserMessages.size === 0) return;
            activeUserMessages = activeUserMessages
                .then(async () => {
                    while (!stopped && pendingUserMessages.size > 0) {
                        const entry = pendingUserMessages.entries().next().value;
                        if (entry === undefined) return true;
                        const [queueKey, message] = entry;
                        pendingUserMessages.delete(queueKey);
                        try {
                            await options.chat.observeProviderUserMessage(message);
                        } catch (error) {
                            report(error);
                        }
                    }
                    return true;
                })
                .catch(report);
        });
    };

    const unsubscribe = options.transport.subscribe({
        onEvent({ frame, receivedAtMs }) {
            if (stopped) return;
            if (frame.event === "session.message") {
                const sessionKey = frame.sessionMessage?.sessionKey;
                if (sessionKey === undefined) return;
                const userMessage = frame.sessionMessage?.userMessage;
                if (
                    userMessage !== undefined &&
                    (pendingUserMessages.has(
                        `${sessionKey}\u0000${userMessage.idempotencyKey}`
                    ) ||
                        pendingUserMessages.size < pendingUserMessageMaximum)
                ) {
                    pendingUserMessages.set(
                        `${sessionKey}\u0000${userMessage.idempotencyKey}`,
                        {
                            attachments: projectPersistentGatewaySessionAttachments(
                                userMessage.attachments,
                                sessionKey,
                                userMessage.messageId,
                                options.mediaReferences
                            ),
                            messageId: userMessage.idempotencyKey,
                            providerRunIds: userMessage.providerRunIds,
                            receivedAtMs,
                            sessionKey,
                            text: userMessage.text,
                        }
                    );
                    scheduleUserDrain();
                }
                pending.add(sessionKey);
                scheduleReconciliationDrain();
                return;
            }
            if (frame.event !== "sessions.changed") return;
            const activity = frame.sessionActivity;
            if (
                activity === undefined ||
                (activity.reason !== undefined &&
                    activity.reason !== "send" &&
                    activity.reason !== "steer")
            ) {
                return;
            }
            pending.add(activity.sessionKey);
            scheduleReconciliationDrain();
        },
        onEventGap() {},
        onState() {},
    });

    return Object.freeze({
        async stop() {
            if (stopped) return;
            stopped = true;
            pending.clear();
            pendingUserMessages.clear();
            unsubscribe();
            await Promise.all([activeUserMessages, activeReconciliation]);
        },
    });
}
