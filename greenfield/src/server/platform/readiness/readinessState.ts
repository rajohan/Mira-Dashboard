/** Read-only readiness state consumed by HTTP protocol handlers. */
export interface ReadinessState {
    isReady(): boolean;
}

/** Readiness lifecycle owned by the application composition root. */
export interface ReadinessController extends ReadinessState {
    markReady(): void;
    markUnavailable(): void;
}

/**
 * Creates an initially unavailable readiness controller.
 * @returns A private readiness lifecycle that must be explicitly promoted.
 */
export function createReadinessController(): ReadinessController {
    let ready = false;

    return {
        isReady: () => ready,
        markReady() {
            ready = true;
        },
        markUnavailable() {
            ready = false;
        },
    };
}
