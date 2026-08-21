import { TRPCError } from "@trpc/server";
import { Effect } from "effect";

import {
    MonitoringCatalogConflictError,
    MonitoringCatalogNotFoundError,
    MonitoringCatalogPreconditionError,
    MonitoringCatalogValidationError,
} from "./catalogErrors.ts";
import {
    MonitoringRunConflictError,
    MonitoringSnapshotValidationError,
} from "./service.ts";

/**
 * Runs one monitoring Effect while translating reviewed domain failures to stable tRPC codes.
 * Infrastructure admission failures remain typed for the shared expected-error boundary.
 * @param effect Monitoring operation to execute at the tRPC boundary.
 * @returns The successful monitoring operation result.
 */
export async function runMonitoringEffect<T, E>(effect: Effect.Effect<T, E>): Promise<T> {
    try {
        return await Effect.runPromise(effect);
    } catch (error) {
        if (
            error instanceof MonitoringSnapshotValidationError ||
            error instanceof MonitoringCatalogValidationError
        ) {
            throw new TRPCError({
                cause: error,
                code: "BAD_REQUEST",
                message:
                    error instanceof MonitoringSnapshotValidationError
                        ? "Monitoring snapshot is invalid"
                        : "Monitoring catalog input is invalid",
            });
        }
        if (
            error instanceof MonitoringRunConflictError ||
            error instanceof MonitoringCatalogConflictError
        ) {
            throw new TRPCError({
                cause: error,
                code: "CONFLICT",
                message: "Monitoring resource conflicts with existing state",
            });
        }
        if (error instanceof MonitoringCatalogNotFoundError) {
            throw new TRPCError({
                cause: error,
                code: "NOT_FOUND",
                message: "Monitoring resource was not found",
            });
        }
        if (error instanceof MonitoringCatalogPreconditionError) {
            throw new TRPCError({
                cause: error,
                code: "PRECONDITION_FAILED",
                message: "Monitoring operation precondition failed",
            });
        }
        throw error;
    }
}
