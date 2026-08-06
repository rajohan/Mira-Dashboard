import * as v from "valibot";

import { positiveSafeIntegerSchema } from "../../../shared/validation.ts";

const systemdLauncherDeadlineSchema = positiveSafeIntegerSchema();

/** Reason a signal-terminated launcher stopped. */
export type SystemdLauncherTermination = Readonly<{
    kind: "deadline" | "signal";
    signalCode: NodeJS.Signals;
}>;

/** Injectable timer boundary for deterministic deadline-controller tests. */
export interface SystemdLauncherDeadlineScheduler {
    cancel(handle: unknown): void;
    schedule(callback: () => void, delayMs: number): unknown;
}

/** Owned deadline state that can distinguish its abort from other subprocess signals. */
export interface SystemdLauncherDeadline {
    readonly signal: AbortSignal;
    cancel(): void;
    didFire(): boolean;
}

const nativeDeadlineScheduler: SystemdLauncherDeadlineScheduler = Object.freeze({
    cancel(handle: unknown) {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
    schedule(callback: () => void, delayMs: number) {
        return setTimeout(callback, delayMs);
    },
});

/**
 * Arms one explicitly owned subprocess deadline.
 * @param delayMs Positive deadline in milliseconds.
 * @param scheduler Injectable timer boundary used by deterministic tests.
 * @returns Abort signal, fired state, and idempotent cancellation.
 */
export function createSystemdLauncherDeadline(
    delayMs: number,
    scheduler: SystemdLauncherDeadlineScheduler = nativeDeadlineScheduler
): SystemdLauncherDeadline {
    if (!v.safeParse(systemdLauncherDeadlineSchema, delayMs).success) {
        throw new TypeError("Systemd launcher deadline must be a positive integer");
    }

    const controller = new AbortController();
    let cancelled = false;
    let fired = false;
    const handle = scheduler.schedule(() => {
        if (cancelled) return;
        fired = true;
        controller.abort();
    }, delayMs);

    return Object.freeze({
        cancel() {
            if (cancelled) return;
            cancelled = true;
            scheduler.cancel(handle);
        },
        didFire() {
            return fired;
        },
        signal: controller.signal,
    });
}

/**
 * Classifies a signal-terminated launcher without conflating every `SIGKILL` with timeout.
 * @param signalCode Signal observed after the launcher exits.
 * @param deadlineFired Whether the launcher-owned deadline enforcement fired.
 * @param deadlineSignal Signal sent by the launcher-owned deadline enforcement.
 * @returns The signal termination reason, or `undefined` for a normal exit.
 */
export function classifySystemdLauncherTermination(
    signalCode: NodeJS.Signals | null,
    deadlineFired: boolean,
    deadlineSignal: NodeJS.Signals
): SystemdLauncherTermination | undefined {
    if (signalCode === null) return undefined;
    return Object.freeze({
        kind: deadlineFired && signalCode === deadlineSignal ? "deadline" : "signal",
        signalCode,
    });
}
