import type { ReportSummary } from "../../contracts/monitoring.ts";

/**
 * @param status Canonical report status.
 * @returns Shared semantic badge tone for the status.
 */
export function reportStatusVariant(
    status: ReportSummary["status"]
): "danger" | "success" | "warning" {
    if (status === "error") return "danger";
    if (status === "warning") return "warning";
    return "success";
}

/**
 * @param kind Canonical report kind.
 * @returns Human-readable label without changing the kind identity.
 */
export function reportKindLabel(kind: string): string {
    return kind.replaceAll(/[-_]+/gu, " ");
}
