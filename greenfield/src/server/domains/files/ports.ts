import type {
    WorkspaceFilePreviewKind,
    WorkspaceFileUploadAccepted,
    WorkspaceFileWriteStatus,
} from "./types.ts";

export type { WorkspaceFilePreviewKind } from "./types.ts";

/** Internal locator; only descriptor-safe adapters may interpret its path segments. */
export interface WorkspaceFileLocator {
    readonly rootId: string;
    readonly segments: readonly string[];
}

export interface WorkspaceFileRootPolicy {
    readonly id: string;
    readonly label: string;
    readonly writable: boolean;
}

/** Server-only content handling for one exact reviewed manifest entry. */
export type WorkspaceFileManifestContentPolicy = "raw" | "redacted-config-json";

/** One exact regular file made visible beneath an otherwise opaque root. */
export interface WorkspaceFileManifestEntry {
    readonly contentPolicy: WorkspaceFileManifestContentPolicy;
    readonly maximumSizeBytes: number;
    readonly segments: readonly string[];
    readonly writable: boolean;
}

/** Server-reviewed root configuration shared by descriptor readers and worker writers. */
export interface WorkspaceFileRootConfiguration extends WorkspaceFileRootPolicy {
    /** When present, only these files and their synthetic directory prefixes are visible. */
    readonly manifest?: readonly WorkspaceFileManifestEntry[];
    readonly path: string;
}

export interface WorkspaceFileNode {
    readonly kind: "directory" | "file";
    readonly locator: WorkspaceFileLocator;
    readonly mimeType?: string;
    readonly modifiedAtMs?: number;
    readonly name: string;
    readonly previewKind?: WorkspaceFilePreviewKind;
    readonly requiresSecretReveal?: boolean;
    readonly revision: string;
    readonly sizeBytes?: number;
    readonly writeMaximumSizeBytes?: number;
    readonly writable: boolean;
}

/** Internal content policy selected only after the service authorizes a reveal. */
export type WorkspaceFileContentAccess = "default" | "reveal-secrets";

export interface WorkspaceFileDirectorySnapshot {
    readonly directory: WorkspaceFileNode & { readonly kind: "directory" };
    readonly entries: readonly WorkspaceFileNode[];
}

export interface WorkspaceFileReadRange {
    readonly endExclusive: number;
    readonly start: number;
}

export interface WorkspaceFileReadResult {
    readonly bytes: Uint8Array;
    readonly fileName: string;
    readonly mimeType: string;
    readonly previewKind: WorkspaceFilePreviewKind;
    readonly revision: string;
    readonly sizeBytes: number;
}

/** Web-safe descriptor-rooted read port. It has no workspace mutation method. */
export interface WorkspaceFileReader {
    readonly describe: (
        locator: WorkspaceFileLocator,
        signal?: AbortSignal,
        contentAccess?: WorkspaceFileContentAccess
    ) => Promise<WorkspaceFileNode>;
    readonly dispose: () => Promise<void> | void;
    readonly list: (
        locator: WorkspaceFileLocator,
        signal?: AbortSignal
    ) => Promise<WorkspaceFileDirectorySnapshot>;
    readonly read: (
        locator: WorkspaceFileLocator,
        expectedRevision: string,
        range: WorkspaceFileReadRange | undefined,
        signal?: AbortSignal,
        contentAccess?: WorkspaceFileContentAccess
    ) => Promise<WorkspaceFileReadResult>;
    readonly roots: () => readonly WorkspaceFileRootPolicy[];
}

export interface WorkspaceFileSpoolReceipt {
    readonly sha256: string;
    readonly spoolId: string;
    readonly sizeBytes: number;
}

/** Narrow project-local spool. It never accepts or returns a host path. */
export interface WorkspaceFileUploadSpool {
    readonly cleanupOrphans: (input?: {
        readonly maximumEntries?: number;
        readonly olderThanMs?: number;
        readonly preserveSpoolIds?: readonly string[];
    }) => Promise<{
        readonly inspected: number;
        readonly removed: number;
        readonly truncated: boolean;
    }>;
    readonly discard: (spoolId: string) => Promise<void>;
    readonly dispose: () => Promise<void> | void;
    readonly receive: (input: {
        readonly body: ReadableStream<Uint8Array>;
        readonly expectedBytes: number;
        readonly signal?: AbortSignal;
        readonly spoolId: string;
    }) => Promise<WorkspaceFileSpoolReceipt>;
}

export interface WorkspaceFileWriteAuditContext {
    readonly actor: {
        readonly authenticatorId: string;
        readonly id: string;
        readonly kind: "user";
    };
    readonly requestId: string;
}

export interface WorkspaceFileWriteCommand {
    readonly expectedRevision?: string;
    readonly fileName: string;
    readonly locator: WorkspaceFileLocator;
    readonly mimeType: string;
    readonly operation: "create" | "replace";
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly spoolId: string;
    readonly ticketId: string;
}

export type WorkspaceFileEnqueueReconciliation =
    | { readonly kind: "absent" }
    | {
          readonly kind: "accepted";
          readonly result: WorkspaceFileUploadAccepted;
      };

/**
 * Durable web-to-worker boundary. Implementations atomically persist the attempted audit
 * and idempotent job enqueue before returning acceptance.
 */
export interface WorkspaceFileWriteScheduler {
    readonly enqueue: (
        command: WorkspaceFileWriteCommand,
        audit: WorkspaceFileWriteAuditContext,
        signal?: AbortSignal
    ) => Promise<WorkspaceFileUploadAccepted>;
    readonly getStatus: (
        ticketId: string,
        actor: WorkspaceFileWriteAuditContext["actor"],
        signal?: AbortSignal
    ) => Promise<WorkspaceFileWriteStatus | undefined>;
    readonly listActiveSpoolIds: (signal?: AbortSignal) => Promise<{
        readonly spoolIds: readonly string[];
        readonly truncated: boolean;
    }>;
    /**
     * Linearized post-enqueue probe for one exact command. `absent` is returned only
     * when the durable repository contains no matching idempotency row; any present
     * but invalid or mismatched row fails closed instead.
     */
    readonly reconcileEnqueue: (
        command: WorkspaceFileWriteCommand,
        actor: WorkspaceFileWriteAuditContext["actor"],
        signal?: AbortSignal
    ) => Promise<WorkspaceFileEnqueueReconciliation>;
}

/** Worker-only structural writer. Web composition must never receive this port. */
export interface WorkspaceFileStructuralWriter {
    readonly apply: (
        command: WorkspaceFileWriteCommand,
        signal?: AbortSignal
    ) => Promise<{
        readonly modifiedAtMs: number;
        readonly revision: string;
        readonly sizeBytes: number;
    }>;
}
