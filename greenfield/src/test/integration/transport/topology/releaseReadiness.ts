/** Public readiness state for one integration release. */
export interface IntegrationReadinessSnapshot {
    releaseId: string;
    status: "not-ready" | "ready";
}

/** Explicit readiness lifecycle used by rolling-release integration servers. */
export class IntegrationReleaseReadiness {
    readonly #releaseId: string;
    #phase: "ready" | "starting" | "stopping" = "starting";

    constructor(releaseId: string) {
        if (releaseId.length === 0) {
            throw new Error("Integration release ID must not be empty");
        }
        this.#releaseId = releaseId;
    }

    /**
     * Promotes only the expected release to ready.
     * @param expectedReleaseId Release identity selected by the activation flow.
     */
    markReady(expectedReleaseId: string): void {
        if (expectedReleaseId !== this.#releaseId) {
            throw new Error("Cannot mark an unexpected integration release ready");
        }
        if (this.#phase === "stopping") {
            throw new Error("Cannot mark a stopping integration release ready");
        }
        this.#phase = "ready";
    }

    /** Removes the release from readiness before its listener is stopped. */
    markStopping(): void {
        this.#phase = "stopping";
    }

    /**
     * Returns the public readiness projection for this release.
     * @returns Current public readiness state and release identity.
     */
    snapshot(): IntegrationReadinessSnapshot {
        return {
            releaseId: this.#releaseId,
            status: this.#phase === "ready" ? "ready" : "not-ready",
        };
    }
}
