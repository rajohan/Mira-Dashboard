import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import {
    boundedControlSafeTextSchema,
    hasNoUnicodeControlOrFormat,
    nonnegativeSafeIntegerSchema,
    positiveSafeIntegerSchema,
} from "../shared/validation.ts";
import type { ProcedureContract, RawHttpContract } from "./registry.ts";

/** Browser and adapter budgets for one workspace-files request. */
export const workspaceFileLimits = Object.freeze({
    contentTicketTtlMs: 2 * 60 * 1000,
    listPageDefault: 100,
    listPageMaximum: 200,
    maximumConfiguredRoots: 16,
    maximumDirectoryEntries: 4096,
    maximumDownloadBytes: 32 * 1024 * 1024,
    maximumFileNameBytes: 255,
    maximumManifestFileBytes: 2 * 1024 * 1024,
    maximumReferenceCount: 8192,
    maximumTextPreviewBytes: 1024 * 1024,
    maximumUploadBytes: 16 * 1024 * 1024,
    referenceTtlMs: 30 * 60 * 1000,
    uploadTicketTtlMs: 5 * 60 * 1000,
});

const uuidV4Pattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const lowercaseHexSha256Pattern = /^[0-9a-f]{64}$/u;
const rootIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const mimeTypePattern =
    /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/u;

/** Named server-reviewed root identity; it is never a filesystem path. */
export const workspaceFileRootIdSchema = v.pipe(
    v.string("Workspace file root id is invalid"),
    v.regex(rootIdPattern, "Workspace file root id is invalid")
);

/** Process-issued, actor-bound file or directory reference. */
export const workspaceFileResourceIdSchema = v.pipe(
    v.string("Workspace file resource id is invalid"),
    v.length(36, "Workspace file resource id is invalid"),
    v.uuid("Workspace file resource id is invalid"),
    v.regex(uuidV4Pattern, "Workspace file resource id is invalid")
);

/** Process-issued, actor-bound continuation cursor. */
export const workspaceFileCursorSchema = v.pipe(
    v.string("Workspace file cursor is invalid"),
    v.length(36, "Workspace file cursor is invalid"),
    v.uuid("Workspace file cursor is invalid"),
    v.regex(uuidV4Pattern, "Workspace file cursor is invalid")
);

/** Short-lived raw-content or upload ticket identity. */
export const workspaceFileTicketIdSchema = v.pipe(
    v.string("Workspace file ticket id is invalid"),
    v.length(36, "Workspace file ticket id is invalid"),
    v.uuid("Workspace file ticket id is invalid"),
    v.regex(uuidV4Pattern, "Workspace file ticket id is invalid")
);

/** Opaque strong metadata revision used for compare-and-swap writes. */
export const workspaceFileRevisionSchema = v.pipe(
    v.string("Workspace file revision is invalid"),
    v.regex(lowercaseHexSha256Pattern, "Workspace file revision is invalid")
);

/**
 * Runtime-only literal-child and UTF-8 byte-budget validation.
 * @param name Candidate literal child name.
 * @returns Whether the name is path-free and within its byte budget.
 */
export function workspaceFileNameIsSafe(name: string): boolean {
    return (
        name !== "." &&
        name !== ".." &&
        !name.includes("/") &&
        !name.includes("\\") &&
        new TextEncoder().encode(name).byteLength <=
            workspaceFileLimits.maximumFileNameBytes
    );
}

/** One literal child name. Slashes, traversal names, and controls are rejected. */
export const workspaceFileNameSchema = v.pipe(
    boundedControlSafeTextSchema(
        workspaceFileLimits.maximumFileNameBytes,
        "Workspace file name is invalid"
    ),
    v.check(workspaceFileNameIsSafe, "Workspace file name is invalid")
);

export const workspaceFileMimeTypeSchema = v.pipe(
    v.string("Workspace file MIME type is invalid"),
    v.maxLength(129, "Workspace file MIME type is invalid"),
    v.check(hasNoUnicodeControlOrFormat, "Workspace file MIME type is invalid"),
    v.regex(mimeTypePattern, "Workspace file MIME type is invalid")
);

const workspaceFileMetadataSizeSchema = nonnegativeSafeIntegerSchema(
    "Workspace file size is invalid"
);
const workspaceFileDownloadSizeSchema = v.pipe(
    nonnegativeSafeIntegerSchema("Workspace file size is invalid"),
    v.maxValue(
        workspaceFileLimits.maximumDownloadBytes,
        "Workspace file size is outside its download budget"
    )
);
const workspaceFileUploadSizeSchema = v.pipe(
    nonnegativeSafeIntegerSchema("Workspace file upload size is invalid"),
    v.maxValue(
        workspaceFileLimits.maximumUploadBytes,
        "Workspace file upload is outside its byte budget"
    )
);
const workspaceFilePageLimitSchema = v.pipe(
    positiveSafeIntegerSchema("Workspace file page limit is invalid"),
    v.maxValue(
        workspaceFileLimits.listPageMaximum,
        "Workspace file page limit is outside its budget"
    )
);
const workspaceFileDisplayPathSchema = boundedControlSafeTextSchema(
    4096,
    "Workspace file display path is invalid"
);
const workspaceFileRootLabelSchema = boundedControlSafeTextSchema(
    80,
    "Workspace file root label is invalid"
);

export const workspaceFileKindSchema = v.picklist(
    ["directory", "file"],
    "Workspace file kind is invalid"
);
export const workspaceFilePreviewKindSchema = v.picklist(
    ["audio", "download-only", "image", "pdf", "text"],
    "Workspace file preview kind is invalid"
);
export const workspaceFileDispositionSchema = v.picklist(
    ["download", "preview"],
    "Workspace file disposition is invalid"
);

/** Empty request used by the configured-root inventory. */
export const listWorkspaceFileRootsInputSchema = v.strictObject({});

export const workspaceFileRootSchema = v.strictObject({
    id: workspaceFileRootIdSchema,
    label: workspaceFileRootLabelSchema,
    resourceId: workspaceFileResourceIdSchema,
    writable: v.boolean("Workspace file root write policy is invalid"),
});

/** Server-reviewed named roots; no absolute host path is published. */
export const listWorkspaceFileRootsOutputSchema = v.strictObject({
    roots: v.pipe(
        v.array(workspaceFileRootSchema, "Workspace file roots are invalid"),
        v.minLength(1, "Workspace file roots cannot be empty"),
        v.maxLength(
            workspaceFileLimits.maximumConfiguredRoots,
            "Workspace file root count is outside its budget"
        )
    ),
});

/** One stable bounded directory page. */
export const listWorkspaceFilesInputSchema = v.strictObject({
    cursor: v.optional(workspaceFileCursorSchema),
    directoryId: workspaceFileResourceIdSchema,
    limit: v.optional(workspaceFilePageLimitSchema, workspaceFileLimits.listPageDefault),
});

export const workspaceFileDirectorySchema = v.strictObject({
    displayPath: workspaceFileDisplayPathSchema,
    name: workspaceFileNameSchema,
    resourceId: workspaceFileResourceIdSchema,
    revision: workspaceFileRevisionSchema,
    rootId: workspaceFileRootIdSchema,
    writable: v.boolean("Workspace directory write policy is invalid"),
});

export const workspaceFileEntrySchema = v.strictObject({
    kind: workspaceFileKindSchema,
    mimeType: v.optional(workspaceFileMimeTypeSchema),
    modifiedAtMs: v.optional(
        timestampMillisecondsSchema("Workspace file modification time is invalid")
    ),
    name: workspaceFileNameSchema,
    previewKind: v.optional(workspaceFilePreviewKindSchema),
    requiresSecretReveal: v.optional(
        v.boolean("Workspace file secret policy is invalid")
    ),
    resourceId: workspaceFileResourceIdSchema,
    revision: workspaceFileRevisionSchema,
    sizeBytes: v.optional(workspaceFileMetadataSizeSchema),
    truncated: v.optional(v.literal(true, "Workspace file truncation state is invalid")),
    writable: v.boolean("Workspace file write policy is invalid"),
});

export const listWorkspaceFilesOutputSchema = v.strictObject({
    directory: workspaceFileDirectorySchema,
    entries: v.pipe(
        v.array(workspaceFileEntrySchema, "Workspace file entries are invalid"),
        v.maxLength(
            workspaceFileLimits.listPageMaximum,
            "Workspace file page is outside its row budget"
        )
    ),
    nextCursor: v.optional(workspaceFileCursorSchema),
});

/** Requests one short-lived actor-bound raw read URL. */
export const prepareWorkspaceFileContentInputSchema = v.strictObject({
    disposition: workspaceFileDispositionSchema,
    resourceId: workspaceFileResourceIdSchema,
});

/** Explicit recent-auth request for an uncached raw view of one masked config. */
export const prepareWorkspaceFileRevealInputSchema = v.strictObject({
    resourceId: workspaceFileResourceIdSchema,
});

export const workspaceFileContentTicketSchema = v.pipe(
    v.strictObject({
        disposition: workspaceFileDispositionSchema,
        expiresAtMs: timestampMillisecondsSchema(
            "Workspace file content ticket expiry is invalid"
        ),
        fileName: workspaceFileNameSchema,
        mimeType: workspaceFileMimeTypeSchema,
        previewKind: workspaceFilePreviewKindSchema,
        revision: workspaceFileRevisionSchema,
        sizeBytes: workspaceFileDownloadSizeSchema,
        sourceSizeBytes: v.optional(workspaceFileMetadataSizeSchema),
        ticketId: workspaceFileTicketIdSchema,
        truncated: v.optional(
            v.literal(true, "Workspace file truncation state is invalid")
        ),
        url: v.pipe(
            v.string("Workspace file content URL is invalid"),
            v.maxLength(96, "Workspace file content URL is invalid"),
            v.regex(
                /^\/api\/files\/content\/[0-9a-f-]{36}$/u,
                "Workspace file content URL is invalid"
            )
        ),
    }),
    v.check(
        (ticket) =>
            ticket.truncated === true
                ? ticket.sourceSizeBytes !== undefined &&
                  ticket.sourceSizeBytes > ticket.sizeBytes &&
                  ticket.sizeBytes <= workspaceFileLimits.maximumTextPreviewBytes
                : ticket.sourceSizeBytes === undefined,
        "Workspace file content truncation metadata is invalid"
    )
);

/** Existing-file replacement reservation with mandatory compare-and-swap revision. */
export const prepareWorkspaceFileWriteInputSchema = v.strictObject({
    expectedRevision: workspaceFileRevisionSchema,
    mimeType: workspaceFileMimeTypeSchema,
    revealTicketId: v.optional(workspaceFileTicketIdSchema),
    resourceId: workspaceFileResourceIdSchema,
    sizeBytes: workspaceFileUploadSizeSchema,
});

/** New child upload reservation. Existing names fail at worker execution. */
export const prepareWorkspaceFileUploadInputSchema = v.strictObject({
    directoryId: workspaceFileResourceIdSchema,
    fileName: workspaceFileNameSchema,
    mimeType: workspaceFileMimeTypeSchema,
    sizeBytes: workspaceFileUploadSizeSchema,
});

export const workspaceFileUploadTicketSchema = v.strictObject({
    expiresAtMs: timestampMillisecondsSchema(
        "Workspace file upload ticket expiry is invalid"
    ),
    ticketId: workspaceFileTicketIdSchema,
    uploadUrl: v.pipe(
        v.string("Workspace file upload URL is invalid"),
        v.maxLength(96, "Workspace file upload URL is invalid"),
        v.regex(
            /^\/api\/files\/uploads\/[0-9a-f-]{36}$/u,
            "Workspace file upload URL is invalid"
        )
    ),
});

/** Raw upload acceptance; the worker remains authoritative for terminal outcome. */
export const workspaceFileUploadAcceptedSchema = v.strictObject({
    acceptedAtMs: timestampMillisecondsSchema(
        "Workspace file upload acceptance time is invalid"
    ),
    jobRunId: boundedControlSafeTextSchema(128, "Workspace file write job id is invalid"),
    ticketId: workspaceFileTicketIdSchema,
});

export const getWorkspaceFileWriteStatusInputSchema = v.strictObject({
    ticketId: workspaceFileTicketIdSchema,
});

export const workspaceFileWriteStatusSchema = v.variant("status", [
    v.strictObject({
        status: v.literal("pending"),
        ticketId: workspaceFileTicketIdSchema,
    }),
    v.strictObject({
        jobRunId: boundedControlSafeTextSchema(
            128,
            "Workspace file write job id is invalid"
        ),
        status: v.literal("accepted"),
        ticketId: workspaceFileTicketIdSchema,
    }),
    v.strictObject({
        status: v.literal("reconciliation-required"),
        ticketId: workspaceFileTicketIdSchema,
    }),
]);

export type WorkspaceFileRoot = v.InferOutput<typeof workspaceFileRootSchema>;
export type WorkspaceFilePreviewKind = v.InferOutput<
    typeof workspaceFilePreviewKindSchema
>;
export type WorkspaceFileDirectory = v.InferOutput<typeof workspaceFileDirectorySchema>;
export type WorkspaceFileEntry = v.InferOutput<typeof workspaceFileEntrySchema>;
export type ListWorkspaceFilesInput = v.InferOutput<typeof listWorkspaceFilesInputSchema>;
export type ListWorkspaceFilesOutput = v.InferOutput<
    typeof listWorkspaceFilesOutputSchema
>;
export type PrepareWorkspaceFileContentInput = v.InferOutput<
    typeof prepareWorkspaceFileContentInputSchema
>;
export type PrepareWorkspaceFileRevealInput = v.InferOutput<
    typeof prepareWorkspaceFileRevealInputSchema
>;
export type WorkspaceFileContentTicket = v.InferOutput<
    typeof workspaceFileContentTicketSchema
>;
export type PrepareWorkspaceFileWriteInput = v.InferOutput<
    typeof prepareWorkspaceFileWriteInputSchema
>;
export type PrepareWorkspaceFileUploadInput = v.InferOutput<
    typeof prepareWorkspaceFileUploadInputSchema
>;
export type WorkspaceFileUploadTicket = v.InferOutput<
    typeof workspaceFileUploadTicketSchema
>;
export type WorkspaceFileUploadAccepted = v.InferOutput<
    typeof workspaceFileUploadAcceptedSchema
>;
export type WorkspaceFileWriteStatus = v.InferOutput<
    typeof workspaceFileWriteStatusSchema
>;

const fileReadAccess = {
    capabilities: ["files:read"],
    capabilityPolicy: "all",
    kind: "authenticated",
    principalKinds: ["session"],
} as const;
const fileWriteAccess = {
    capabilities: ["files:write"],
    kind: "recent-auth",
    principalKinds: ["session"],
    whenMfaDisabled: "deny",
    whenMfaEnabled: "mfa",
} as const;
const queryTransport = {
    batching: "adapter-default",
    handler: "default",
    requestBody: "default",
} as const;
const mutationTransport = {
    batching: "forbidden",
    handler: "default",
    requestBody: "default",
} as const;

/** Workspace-files procedure metadata. Raw bytes never enter a tRPC JSON body. */
export const workspaceFileProcedureContracts = [
    {
        access: fileReadAccess,
        domain: "files",
        errors: ["FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: listWorkspaceFileRootsInputSchema,
        inputSchemaId: "files.listRoots.input",
        kind: "query",
        name: "files.listRoots",
        output: listWorkspaceFileRootsOutputSchema,
        outputSchemaId: "files.listRoots.output",
        summary: "Lists reviewed named workspace-file roots without host paths.",
        transport: queryTransport,
    },
    {
        access: fileReadAccess,
        domain: "files",
        errors: [
            "BAD_REQUEST",
            "CONFLICT",
            "FORBIDDEN",
            "NOT_FOUND",
            "SERVICE_UNAVAILABLE",
            "UNAUTHORIZED",
        ],
        input: listWorkspaceFilesInputSchema,
        inputSchemaId: "files.list.input",
        kind: "query",
        name: "files.list",
        output: listWorkspaceFilesOutputSchema,
        outputSchemaId: "files.list.output",
        summary: "Lists one stable bounded page beneath an opaque directory reference.",
        transport: queryTransport,
    },
    {
        access: fileReadAccess,
        domain: "files",
        errors: [
            "BAD_REQUEST",
            "CONFLICT",
            "FORBIDDEN",
            "NOT_FOUND",
            "SERVICE_UNAVAILABLE",
            "UNAUTHORIZED",
        ],
        input: prepareWorkspaceFileContentInputSchema,
        inputSchemaId: "files.prepareContent.input",
        kind: "query",
        name: "files.prepareContent",
        output: workspaceFileContentTicketSchema,
        outputSchemaId: "files.prepareContent.output",
        summary:
            "Issues a short-lived actor-bound full representation or bounded-prefix URL.",
        transport: queryTransport,
    },
    {
        access: fileWriteAccess,
        domain: "files",
        errorReasons: ["mfa_enrollment_required", "step_up_required"],
        errors: [
            "BAD_REQUEST",
            "CONFLICT",
            "FORBIDDEN",
            "NOT_FOUND",
            "SERVICE_UNAVAILABLE",
            "TOO_MANY_REQUESTS",
            "UNAUTHORIZED",
        ],
        input: prepareWorkspaceFileWriteInputSchema,
        inputSchemaId: "files.prepareWrite.input",
        kind: "mutation",
        name: "files.prepareWrite",
        output: workspaceFileUploadTicketSchema,
        outputSchemaId: "files.prepareWrite.output",
        summary:
            "Reserves a CAS-bound worker write without granting web filesystem authority.",
        transport: mutationTransport,
    },
    {
        access: fileWriteAccess,
        domain: "files",
        errorReasons: ["mfa_enrollment_required", "step_up_required"],
        errors: [
            "BAD_REQUEST",
            "CONFLICT",
            "FORBIDDEN",
            "NOT_FOUND",
            "SERVICE_UNAVAILABLE",
            "TOO_MANY_REQUESTS",
            "UNAUTHORIZED",
        ],
        input: prepareWorkspaceFileRevealInputSchema,
        inputSchemaId: "files.prepareReveal.input",
        kind: "mutation",
        name: "files.prepareReveal",
        output: workspaceFileContentTicketSchema,
        outputSchemaId: "files.prepareReveal.output",
        summary:
            "Issues one uncached actor-bound raw config view or bounded prefix after recent authentication.",
        transport: mutationTransport,
    },
    {
        access: fileWriteAccess,
        domain: "files",
        errorReasons: ["mfa_enrollment_required", "step_up_required"],
        errors: [
            "BAD_REQUEST",
            "CONFLICT",
            "FORBIDDEN",
            "NOT_FOUND",
            "SERVICE_UNAVAILABLE",
            "TOO_MANY_REQUESTS",
            "UNAUTHORIZED",
        ],
        input: prepareWorkspaceFileUploadInputSchema,
        inputSchemaId: "files.prepareUpload.input",
        kind: "mutation",
        name: "files.prepareUpload",
        output: workspaceFileUploadTicketSchema,
        outputSchemaId: "files.prepareUpload.output",
        summary: "Reserves a bounded new-file upload for structural worker execution.",
        transport: mutationTransport,
    },
    {
        access: fileReadAccess,
        domain: "files",
        errors: ["FORBIDDEN", "NOT_FOUND", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: getWorkspaceFileWriteStatusInputSchema,
        inputSchemaId: "files.getWriteStatus.input",
        kind: "query",
        name: "files.getWriteStatus",
        output: workspaceFileWriteStatusSchema,
        outputSchemaId: "files.getWriteStatus.output",
        summary: "Reconciles a prepared write without permitting blind redispatch.",
        transport: queryTransport,
    },
] as const satisfies readonly ProcedureContract[];

const fileBinaryContentTypes = [
    "application/json",
    "application/octet-stream",
    "application/pdf",
    "audio/mpeg",
    "audio/ogg",
    "audio/wav",
    "image/avif",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
    "text/csv",
    "text/markdown",
    "text/plain",
] as const;

/** Same-origin raw file transfer contracts. */
export const workspaceFileRawHttpContracts = [
    ...(["GET", "HEAD"] as const).map((method): RawHttpContract => ({
        access: fileReadAccess,
        method,
        path: "/api/files/content/:ticketId",
        rangeRequests: "single-byte-range",
        requestBody: { kind: "none" },
        response: {
            contentTypes: fileBinaryContentTypes,
            kind: "binary",
            maximumBytes: workspaceFileLimits.maximumDownloadBytes,
            transfer: "buffered",
        },
        statusCodes: [200, 206, 400, 401, 403, 404, 405, 409, 410, 416, 429, 500, 503],
        summary: `${method === "HEAD" ? "Inspects" : "Reads"} one ticket-bound workspace file revision or bounded source prefix.`,
    })),
    {
        access: fileWriteAccess,
        method: "PUT",
        path: "/api/files/uploads/:ticketId",
        rangeRequests: "none",
        requestBody: {
            contentTypes: fileBinaryContentTypes,
            kind: "binary",
            maximumBytes: workspaceFileLimits.maximumUploadBytes,
            transfer: "streamed",
        },
        response: {
            contentTypes: ["application/json"],
            kind: "schema",
            schema: workspaceFileUploadAcceptedSchema,
            schemaId: "files.upload.accepted",
        },
        statusCodes: [
            202, 400, 401, 403, 404, 405, 409, 410, 411, 413, 415, 429, 500, 503,
        ],
        summary:
            "Spools one bounded upload and enqueues one audited structural worker write.",
    },
] as const satisfies readonly RawHttpContract[];
