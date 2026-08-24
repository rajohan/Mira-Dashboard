import type {
    OpenClawTaskCancelInput,
    OpenClawTaskCancelOutput,
    OpenClawTaskGetInput,
    OpenClawTaskGetOutput,
    OpenClawTaskListInput,
    OpenClawTaskListOutput,
    OpenClawTaskSummary,
} from "../../../contracts/openClawTasks.ts";

export type OpenClawTaskProviderEvent =
    | Readonly<{ kind: "upserted"; task: OpenClawTaskSummary }>
    | Readonly<{ kind: "deleted"; taskId: string }>
    | Readonly<{ kind: "restored" }>;

export interface OpenClawTaskProviderSubscription {
    readonly close: () => Promise<void>;
    /** Resolves after an explicit close and rejects on terminal listener/bridge failure. */
    readonly done: Promise<void>;
}

/** Narrow validated authority over the audited tasks.list/get/cancel surface. */
export interface OpenClawTaskProvider {
    readonly cancel: (
        input: OpenClawTaskCancelInput,
        signal?: AbortSignal
    ) => Promise<OpenClawTaskCancelOutput>;
    readonly get: (
        input: OpenClawTaskGetInput,
        signal?: AbortSignal
    ) => Promise<OpenClawTaskGetOutput>;
    readonly list: (
        input: OpenClawTaskListInput,
        signal?: AbortSignal
    ) => Promise<OpenClawTaskListOutput>;
    readonly subscribeTasks: (
        listener: (event: OpenClawTaskProviderEvent) => void | Promise<void>,
        signal?: AbortSignal
    ) => Promise<OpenClawTaskProviderSubscription>;
}

export class OpenClawTaskProviderUnavailableError extends Error {
    public constructor() {
        super("OpenClaw task provider is unavailable");
        this.name = "OpenClawTaskProviderUnavailableError";
    }
}

export class OpenClawTaskProviderNotFoundError extends Error {
    public constructor() {
        super("OpenClaw task was not found");
        this.name = "OpenClawTaskProviderNotFoundError";
    }
}

export class OpenClawTaskProviderUnknownOutcomeError extends Error {
    public constructor() {
        super("OpenClaw task cancellation outcome is unknown");
        this.name = "OpenClawTaskProviderUnknownOutcomeError";
    }
}
