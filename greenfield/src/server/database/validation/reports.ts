import { createInsertSchema, createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import {
    monitoringKindSchema,
    monitoringReportBodyMarkdownSchema,
    monitoringReportSourceJobIdSchema,
    monitoringReportSourceSchema,
    monitoringReportTitleSchema,
} from "../../../contracts/monitoring.ts";
import { reports } from "../schema/reports.ts";
import {
    jsonObjectTextSchema,
    nonnegativeDateSchema,
    uuidV7TextSchema,
} from "./scalars.ts";

const reportRefinements = {
    bodyMarkdown: () => monitoringReportBodyMarkdownSchema,
    id: uuidV7TextSchema,
    kind: () => monitoringKindSchema,
    metadataJson: jsonObjectTextSchema,
    occurredAt: nonnegativeDateSchema,
    source: () => monitoringReportSourceSchema,
    sourceJobId: () => monitoringReportSourceJobIdSchema,
    title: () => monitoringReportTitleSchema,
};

const generatedReportSelectSchema = createSelectSchema(reports, reportRefinements);

/** Validates immutable report rows read from SQLite. */
export const reportSelectSchema = v.strictObject(generatedReportSelectSchema.entries);

const generatedReportInsertSchema = createInsertSchema(reports, reportRefinements);

/** Validates values before an immutable report insert. */
export const reportInsertSchema = v.strictObject(generatedReportInsertSchema.entries);
