export type DashboardTerminationSignal = "SIGINT" | "SIGTERM";

/** Signal listener registration boundary injected by deterministic tests. */
export type ListenForTerminationSignal = (
    signal: DashboardTerminationSignal,
    listener: () => void
) => () => void;

/** One process-owned termination milestone plus repeated-signal escalation. */
export interface ProcessTerminationController {
    readonly forceSignal: AbortSignal;
    readonly termination: Promise<DashboardTerminationSignal>;
    dispose(): void;
}

function listenForProcessSignal(
    signal: DashboardTerminationSignal,
    listener: () => void
): () => void {
    process.on(signal, listener);
    return () => process.off(signal, listener);
}

/**
 * Installs bounded SIGINT/SIGTERM handlers without terminating the process directly.
 * The first signal starts graceful shutdown; a later signal requests force escalation.
 * @param listen Signal registration boundary.
 * @returns Termination milestone, force signal, and idempotent cleanup.
 */
export function createProcessTerminationController(
    listen: ListenForTerminationSignal = listenForProcessSignal
): ProcessTerminationController {
    const forceController = new AbortController();
    let firstSignal: DashboardTerminationSignal | undefined;
    let resolveTermination: ((signal: DashboardTerminationSignal) => void) | undefined;
    const termination = new Promise<DashboardTerminationSignal>((resolve) => {
        resolveTermination = resolve;
    });
    let disposed = false;
    const receive = (signal: DashboardTerminationSignal): void => {
        if (disposed) return;
        if (firstSignal === undefined) {
            firstSignal = signal;
            resolveTermination?.(signal);
            resolveTermination = undefined;
            return;
        }
        forceController.abort(
            new DOMException("Forced process shutdown requested", "AbortError")
        );
    };
    const removeListeners = [
        listen("SIGINT", () => receive("SIGINT")),
        listen("SIGTERM", () => receive("SIGTERM")),
    ];

    return Object.freeze({
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const remove of removeListeners) remove();
        },
        forceSignal: forceController.signal,
        termination,
    });
}
