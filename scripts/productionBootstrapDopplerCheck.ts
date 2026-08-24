import { applicationConfigurationRegistry } from "../src/shared/configuration/applicationConfigurationRegistry.ts";

/** Validates presence without exposing any production credential value. */
export function assertProductionBootstrapDopplerEnvironment(
    environment: Readonly<Record<string, string | undefined>>
): void {
    for (const entry of applicationConfigurationRegistry) {
        const requiredForBootstrap =
            entry.required ||
            entry.environmentName === "MIRA_DASHBOARD_DATABASE_OBSERVABILITY_PASSWORD";
        if (
            requiredForBootstrap &&
            (environment[entry.environmentName]?.trim() ?? "") === ""
        ) {
            throw new Error("Production Doppler configuration is incomplete");
        }
    }
}

if (import.meta.main) assertProductionBootstrapDopplerEnvironment(process.env);
