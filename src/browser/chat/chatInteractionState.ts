import type { OpenClawTaskSummary } from "../../contracts/openClawTasks.ts";
import type { ChatRuntimeRun } from "./chatRuntimeStore.ts";
import type { ChatDraftAttachment, ChatWorkspaceView } from "./chatTypes.ts";

export interface ChatAbortGate {
    readonly reconciliation: ChatRuntimeRun["reconciliation"];
    readonly runLastSequence: number;
    readonly sessionKey: string;
}

export interface ChatTaskCancelGate {
    readonly phase: "pending" | "reconciling";
    readonly sessionKey: string;
    readonly taskUpdatedAtMs?: number;
}

const terminalTaskStatuses = new Set<OpenClawTaskSummary["status"]>([
    "cancelled",
    "completed",
    "failed",
    "timed_out",
]);

/**
 * Resolves whether the selected composer may dispatch a new send.
 * @param input Current fresh/runtime/action and draft state.
 * @returns Whether the send button and desktop Enter may dispatch.
 */
export function chatSendIsEnabled(
    input: Readonly<{
        actionBusy: boolean;
        attachments: readonly ChatDraftAttachment[];
        connection: ChatWorkspaceView["connection"];
        sessionKey: string;
        sourceFresh: boolean;
        text: string;
    }>
): boolean {
    return (
        input.sessionKey !== "" &&
        input.sourceFresh &&
        input.connection === "connected" &&
        !input.actionBusy &&
        (input.text.trim() !== "" || input.attachments.length > 0) &&
        input.attachments.every(({ status }) => status === "ready")
    );
}

/**
 * Keeps an abort single-dispatch gate until an action-owned reconciliation removes it.
 * @param gate Captured pre-abort target-run watermark and session identity.
 * @param sessionKey Currently selected session.
 * @param run Latest reduced state for the exact target run.
 * @returns Whether Stop must remain hidden for this run.
 */
export function chatAbortIsGated(
    gate: ChatAbortGate | undefined,
    sessionKey: string,
    run:
        | Readonly<Pick<ChatRuntimeRun, "lastSequence" | "phase" | "reconciliation">>
        | undefined
): boolean {
    return (
        run?.phase === "active" && gate !== undefined && gate.sessionKey === sessionKey
    );
}

/**
 * Gates provider Stop controls while shared transport prerequisites are unavailable.
 * Exact local and provider-run reconciliation gates are applied separately.
 * @param input Current connection, inventory, and action state.
 * @returns Whether active-run Stop controls may dispatch.
 */
export function chatAbortControlsAreEnabled(
    input: Readonly<{
        actionBusy: boolean;
        connection: ChatWorkspaceView["connection"];
        sourceFresh: boolean;
    }>
): boolean {
    return input.connection === "connected" && input.sourceFresh && !input.actionBusy;
}

/**
 * Keeps duplicate cancellation blocked until an action-owned reconciliation removes it.
 * @param gate Current exact-task mutation gate.
 * @returns Whether duplicate task cancellation must remain blocked.
 */
export function chatTaskCancelIsGated(gate: ChatTaskCancelGate | undefined): boolean {
    return gate !== undefined;
}

/**
 * Lets a newer or terminal authoritative task retire an optimistic cancel readback.
 * @param authoritative Latest task returned by list/detail queries.
 * @param override Immediate mutation readback, when present.
 * @returns The task version safe to render.
 */
export function reconcileChatTaskSummary(
    authoritative: OpenClawTaskSummary,
    override: OpenClawTaskSummary | undefined
): OpenClawTaskSummary {
    if (override === undefined) return authoritative;
    if (terminalTaskStatuses.has(authoritative.status)) return authoritative;
    if (
        authoritative.updatedAtMs !== undefined &&
        (override.updatedAtMs === undefined ||
            authoritative.updatedAtMs > override.updatedAtMs)
    ) {
        return authoritative;
    }
    return override;
}
