import {
    completeMonitoringSnapshotInputSchema,
    monitoringSubmissionResultSchema,
} from "./monitoring.ts";
import type { ProcedureContract } from "./registry.ts";

const monitoringProducerAccess = {
    capabilities: ["monitoring:write"],
    capabilityPolicy: "all",
    kind: "authenticated",
    principalKinds: ["automation"],
} as const;

/** Complete-snapshot monitor ingestion contract. */
export const monitoringProcedureContracts = [
    {
        access: monitoringProducerAccess,
        domain: "monitoring",
        errors: [
            "BAD_REQUEST",
            "CONFLICT",
            "FORBIDDEN",
            "SERVICE_UNAVAILABLE",
            "UNAUTHORIZED",
        ],
        input: completeMonitoringSnapshotInputSchema,
        inputSchemaId: "monitoring.submitCompleteSnapshot.input",
        kind: "mutation",
        name: "monitoring.submitCompleteSnapshot",
        output: monitoringSubmissionResultSchema,
        outputSchemaId: "monitoring.submitCompleteSnapshot.output",
        summary: "Atomically ingests one complete monitor snapshot.",
        transport: {
            batching: "forbidden",
            handler: "default",
            requestBody: "monitoring",
        },
    },
] as const satisfies readonly ProcedureContract[];
