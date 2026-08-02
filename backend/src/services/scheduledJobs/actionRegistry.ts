import type { ScheduledJob } from "../../../../contracts/jobs.ts";
import { ScheduledJobValidationError } from "./errors.ts";

export interface ScheduledJobActionContext {
    executionId: string;
    pauseWorkerClaims: () => () => void;
    protectFromCancellation: () => void;
    updateOutput: (output: Record<string, unknown>) => void;
}

export type ScheduledJobActionHandler = (
    job: ScheduledJob,
    signal: AbortSignal | undefined,
    context: ScheduledJobActionContext
) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;

export interface ScheduledJobActionOptions {
    timeoutMs?: number;
}

export interface ScheduledJobActionRegistration {
    handler: ScheduledJobActionHandler;
    timeoutMs?: number;
}

/** Allows an action failure to persist structured output with the failed run. */
export class ScheduledJobActionError extends Error {
    readonly output: Record<string, unknown>;

    constructor(message: string, output: Record<string, unknown>) {
        super(message);
        this.name = "ScheduledJobActionError";
        this.output = output;
    }
}

const interruptedHandlerSettled = new WeakMap<
    ScheduledJobInterruptionError,
    Promise<unknown>
>();

export class ScheduledJobInterruptionError extends Error {
    constructor(message: string, handlerSettled: Promise<unknown>) {
        super(message);
        interruptedHandlerSettled.set(this, handlerSettled);
    }

    getHandlerSettled(): Promise<unknown> {
        return interruptedHandlerSettled.get(this)!;
    }
}

const actionHandlers = new Map<string, ScheduledJobActionRegistration>();

function assertValidActionKey(actionKey: string): void {
    if (!/^[a-z][a-z0-9.-]{1,79}$/u.test(actionKey)) {
        throw new ScheduledJobValidationError("Job action key is invalid");
    }
}

export function assertValidActionTimeoutMs(timeoutMs: number | undefined): void {
    if (timeoutMs === undefined) {
        return;
    }
    if (
        !Number.isFinite(timeoutMs) ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 2_147_483_647
    ) {
        throw new ScheduledJobValidationError(
            "Scheduled job action timeout must be an integer between 1 and 2147483647"
        );
    }
}

/**
 * Registers one in-process scheduled action handler.
 * @param actionKey Stable scheduled action key.
 * @param handler Action handler to register.
 * @param options Resource and timeout options.
 */
export function registerScheduledJobAction(
    actionKey: string,
    handler: ScheduledJobActionHandler,
    options: ScheduledJobActionOptions = {}
): void {
    assertValidActionKey(actionKey);
    assertValidActionTimeoutMs(options.timeoutMs);
    actionHandlers.set(actionKey, {
        handler,
        timeoutMs: options.timeoutMs,
    });
}

export function assertValidScheduledJobActionKey(actionKey: string): void {
    assertValidActionKey(actionKey);
}

export function registeredScheduledJobAction(
    actionKey: string
): ScheduledJobActionRegistration | undefined {
    return actionHandlers.get(actionKey);
}
