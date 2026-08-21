import { createInsertSchema, createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import { jobResourceKeySchema } from "../../../contracts/jobModel.ts";
import { resourceLeases } from "../schema/resourceLeases.ts";
import { nonnegativeDateSchema, uuidV7TextSchema } from "./scalars.ts";

interface StoredResourceLease {
    readonly acquiredAt: Date;
    readonly expiresAt: Date;
    readonly renewedAt: Date;
}

function resourceLeaseTimesAreConsistent(lease: StoredResourceLease): boolean {
    return (
        lease.renewedAt.getTime() >= lease.acquiredAt.getTime() &&
        lease.expiresAt.getTime() > lease.renewedAt.getTime()
    );
}

const resourceLeaseRefinements = {
    acquiredAt: nonnegativeDateSchema,
    expiresAt: nonnegativeDateSchema,
    jobRunId: uuidV7TextSchema,
    leaseToken: uuidV7TextSchema,
    renewedAt: nonnegativeDateSchema,
    resourceKey: () => jobResourceKeySchema,
    workerInstanceId: uuidV7TextSchema,
};

const generatedResourceLeaseSelectSchema = createSelectSchema(
    resourceLeases,
    resourceLeaseRefinements
);
const resourceLeaseSelectObjectSchema = v.strictObject(
    generatedResourceLeaseSelectSchema.entries
);

/** Validates one fenced resource lease read from SQLite. */
export const resourceLeaseSelectSchema = v.pipe(
    resourceLeaseSelectObjectSchema,
    v.check(
        (lease) => resourceLeaseTimesAreConsistent(lease),
        "Stored resource lease timestamps are inconsistent"
    )
);

const generatedResourceLeaseInsertSchema = createInsertSchema(
    resourceLeases,
    resourceLeaseRefinements
);
const resourceLeaseInsertObjectSchema = v.strictObject(
    generatedResourceLeaseInsertSchema.entries
);

/** Validates one fenced resource lease before atomic acquisition. */
export const resourceLeaseInsertSchema = v.pipe(
    resourceLeaseInsertObjectSchema,
    v.check(
        (lease) => resourceLeaseTimesAreConsistent(lease),
        "Stored resource lease timestamps are inconsistent"
    )
);
