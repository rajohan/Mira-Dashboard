import { createInsertSchema, createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import { linuxBootIdentitySchema } from "../../../shared/linuxBootIdentity.ts";
import { hostRestartClaimFence } from "../schema/hostRestartClaimFence.ts";
import { nonnegativeDateSchema, uuidV7TextSchema } from "./scalars.ts";

const refinements = {
    armedAt: nonnegativeDateSchema,
    bootIdentity: () => linuxBootIdentitySchema,
    expiresAt: nonnegativeDateSchema,
    jobRunId: uuidV7TextSchema,
    leaseToken: uuidV7TextSchema,
    workerInstanceId: uuidV7TextSchema,
};

const generatedSelectSchema = createSelectSchema(hostRestartClaimFence, refinements);
const selectObjectSchema = v.strictObject(generatedSelectSchema.entries);
type HostRestartClaimFenceSelect = v.InferOutput<typeof selectObjectSchema>;

function selectedFenceIsConsistent(fence: HostRestartClaimFenceSelect): boolean {
    return fence.id === 1 && fence.expiresAt.getTime() > fence.armedAt.getTime();
}

/** Validates one durable singleton restart fence read from SQLite. */
export const hostRestartClaimFenceSelectSchema = v.pipe(
    selectObjectSchema,
    v.check(selectedFenceIsConsistent, "Stored host restart claim fence is inconsistent")
);

const generatedInsertSchema = createInsertSchema(hostRestartClaimFence, refinements);
const insertObjectSchema = v.strictObject({
    ...generatedInsertSchema.entries,
    id: v.literal(1),
});
type HostRestartClaimFenceInsert = v.InferOutput<typeof insertObjectSchema>;

function insertedFenceIsConsistent(fence: HostRestartClaimFenceInsert): boolean {
    return fence.id === 1 && fence.expiresAt.getTime() > fence.armedAt.getTime();
}

/** Validates one exact restart fence before atomic insertion. */
export const hostRestartClaimFenceInsertSchema = v.pipe(
    insertObjectSchema,
    v.check(insertedFenceIsConsistent, "Stored host restart claim fence is inconsistent")
);
