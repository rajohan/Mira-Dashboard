import { parseWebConfiguration } from "./webConfiguration.ts";
import { parseWorkerConfiguration } from "./workerConfiguration.ts";

/** Applies the authoritative production parsers without logging projected values. */
export function assertProductionBootstrapConfiguration(
    environment: Readonly<Record<string, unknown>>
): void {
    const web = parseWebConfiguration(environment);
    const worker = parseWorkerConfiguration(environment);
    if (
        web.nodeEnvironment !== "production" ||
        worker.nodeEnvironment !== "production" ||
        web.port !== 3100 ||
        worker.port !== 3100 ||
        worker.databaseObservabilityPassword === undefined
    ) {
        throw new Error("Production Doppler configuration is incomplete");
    }
}
