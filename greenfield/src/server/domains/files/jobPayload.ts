import * as v from "valibot";

import {
    workspaceFileLimits,
    workspaceFileMimeTypeSchema,
    workspaceFileNameSchema,
    workspaceFileRevisionSchema,
    workspaceFileRootIdSchema,
    workspaceFileTicketIdSchema,
} from "../../../contracts/files.ts";
import { nonnegativeSafeIntegerSchema } from "../../../shared/validation.ts";

const sha256Schema = v.pipe(
    v.string("Workspace file write digest is invalid"),
    v.regex(/^[0-9a-f]{64}$/u, "Workspace file write digest is invalid")
);
const locatorSegmentSchema = workspaceFileNameSchema;
const workspaceFileWriteCommandSchema = v.strictObject({
    expectedRevision: v.optional(workspaceFileRevisionSchema),
    fileName: workspaceFileNameSchema,
    locator: v.strictObject({
        rootId: workspaceFileRootIdSchema,
        segments: v.pipe(
            v.array(locatorSegmentSchema, "Workspace file locator is invalid"),
            v.maxLength(256, "Workspace file locator is invalid")
        ),
    }),
    mimeType: workspaceFileMimeTypeSchema,
    operation: v.picklist(["create", "replace"]),
    sha256: sha256Schema,
    sizeBytes: v.pipe(
        nonnegativeSafeIntegerSchema("Workspace file upload size is invalid"),
        v.maxValue(
            workspaceFileLimits.maximumUploadBytes,
            "Workspace file upload size is invalid"
        )
    ),
    spoolId: workspaceFileTicketIdSchema,
    ticketId: workspaceFileTicketIdSchema,
});

export const workspaceFileJobPayloadSchema = v.strictObject({
    actorBindingSha256: sha256Schema,
    command: workspaceFileWriteCommandSchema,
});

export type WorkspaceFileJobPayload = v.InferOutput<typeof workspaceFileJobPayloadSchema>;

/**
 * Parses the dynamic path-free payload shared by web enqueue and worker execution.
 * @param value Candidate durable JSON payload.
 * @returns Canonical validated Files action payload.
 */
export function parseWorkspaceFileJobPayload(value: unknown): WorkspaceFileJobPayload {
    const payload = v.parse(workspaceFileJobPayloadSchema, value);
    const { command } = payload;
    if (
        (command.operation === "create" && command.expectedRevision !== undefined) ||
        (command.operation === "replace" &&
            (command.expectedRevision === undefined ||
                command.locator.segments.length === 0 ||
                command.locator.segments.at(-1) !== command.fileName))
    ) {
        throw new TypeError("Workspace file job payload is inconsistent");
    }
    return payload;
}
