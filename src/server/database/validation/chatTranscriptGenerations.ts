import { createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import {
    gatewaySessionIdSchema,
    gatewaySessionKeySchema,
} from "../../../contracts/gatewaySessions.ts";
import {
    boundedControlSafeTextSchema,
    positiveSafeIntegerSchema,
} from "../../../shared/validation.ts";
import { chatTranscriptGenerations } from "../schema/chatTranscriptGenerations.ts";
import { nonnegativeDateSchema } from "./scalars.ts";

const refinements = {
    currentGeneration: () =>
        positiveSafeIntegerSchema("Stored chat transcript generation is invalid"),
    gatewayScope: () =>
        boundedControlSafeTextSchema(
            64,
            "Stored chat transcript Gateway scope is invalid"
        ),
    lastBoundaryAction: () =>
        v.picklist(["compact", "delete", "new", "reset", "transport"]),
    lastBoundaryProviderUpdatedAt: nonnegativeDateSchema,
    observedAt: nonnegativeDateSchema,
    pendingAction: () => v.picklist(["compact", "delete", "reset"]),
    pendingControlId: () =>
        boundedControlSafeTextSchema(128, "Stored chat control id is invalid"),
    pendingPreviousStatus: () => v.picklist(["absent", "ready"]),
    providerSessionId: () => gatewaySessionIdSchema,
    providerUpdatedAt: nonnegativeDateSchema,
    sessionKey: () => gatewaySessionKeySchema,
    status: () => v.picklist(["absent", "control-pending", "ready", "reconciling"]),
    updatedAt: nonnegativeDateSchema,
    version: () => positiveSafeIntegerSchema("Stored chat transcript version is invalid"),
};

const generated = createSelectSchema(chatTranscriptGenerations, refinements);
type ChatTranscriptGenerationRowLike = v.InferOutput<typeof generated>;

export function chatTranscriptGenerationRowIsConsistent(
    row: ChatTranscriptGenerationRowLike
): boolean {
    const pending = row.status === "control-pending";
    return (
        pending ===
            (row.pendingAction != null &&
                row.pendingControlId != null &&
                row.pendingPreviousStatus != null) &&
        (row.status !== "absent" || row.providerSessionId == null) &&
        (row.observedAt == null || row.observedAt.getTime() <= row.updatedAt.getTime())
    );
}

export const chatTranscriptGenerationSelectSchema = v.pipe(
    v.strictObject(generated.entries),
    v.check(
        (row) => chatTranscriptGenerationRowIsConsistent(row),
        "Stored chat transcript generation is inconsistent"
    )
);

/** Inserts and updates always materialize the complete current-pointer row. */
export const chatTranscriptGenerationInsertSchema = chatTranscriptGenerationSelectSchema;

export type ChatTranscriptGenerationRow = v.InferOutput<
    typeof chatTranscriptGenerationSelectSchema
>;
