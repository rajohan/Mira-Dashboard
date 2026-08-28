import type { IncidentSummary } from "../../contracts/monitoring.ts";

/**
 * @param severity Contract-owned incident severity.
 * @returns Shared semantic severity style for incident tables and detail panels.
 */
export function incidentSeverityVariant(severity: IncidentSummary["severity"]) {
    if (severity === "critical" || severity === "error") return "danger" as const;
    if (severity === "warning") return "warning" as const;
    return "info" as const;
}

/**
 * @param state - Incident lifecycle state.
 * @returns Shared semantic lifecycle style for incident lists and details.
 */
export function incidentStateVariant(state: IncidentSummary["state"]) {
    return state === "active" ? ("warning" as const) : ("success" as const);
}
