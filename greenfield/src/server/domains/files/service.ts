import { randomUUID } from "node:crypto";

import * as v from "valibot";

import {
    getWorkspaceFileWriteStatusInputSchema,
    listWorkspaceFileRootsOutputSchema,
    listWorkspaceFilesInputSchema,
    listWorkspaceFilesOutputSchema,
    prepareWorkspaceFileContentInputSchema,
    prepareWorkspaceFileReferenceInputSchema,
    prepareWorkspaceFileRevealInputSchema,
    prepareWorkspaceFileUploadInputSchema,
    prepareWorkspaceFileWriteInputSchema,
    workspaceFileContentTicketSchema,
    workspaceFileLimits,
    workspaceFileResourceIdSchema,
    workspaceFileUploadAcceptedSchema,
    workspaceFileUploadTicketSchema,
    workspaceFileWriteStatusSchema,
    type ListWorkspaceFilesInput,
    type ListWorkspaceFilesOutput,
    type PrepareWorkspaceFileContentInput,
    type PrepareWorkspaceFileReferenceInput,
    type PrepareWorkspaceFileRevealInput,
    type PrepareWorkspaceFileUploadInput,
    type PrepareWorkspaceFileWriteInput,
    type WorkspaceFileContentTicket,
    type WorkspaceFileUploadAccepted,
    type WorkspaceFileUploadTicket,
    type WorkspaceFileWriteStatus,
} from "../../../contracts/files.ts";
import { WorkspaceFileError, workspaceFileError } from "./errors.ts";
import type {
    WorkspaceFileDirectorySnapshot,
    WorkspaceFileContentAccess,
    WorkspaceFileLocator,
    WorkspaceFileNode,
    WorkspaceFileReadRange,
    WorkspaceFileReadResult,
    WorkspaceFileReader,
    WorkspaceFileSpoolReceipt,
    WorkspaceFileUploadContentPolicy,
    WorkspaceFileUploadSpool,
    WorkspaceFileWriteAuditContext,
    WorkspaceFileWriteCommand,
    WorkspaceFileWriteScheduler,
} from "./ports.ts";
import { rejectRedactionSentinel } from "./uploadContentGuard.ts";

export interface WorkspaceFileActor {
    readonly authenticatorId: string;
    readonly id: string;
}

export interface WorkspaceFileContentMetadata {
    readonly disposition: WorkspaceFileContentTicket["disposition"];
    readonly fileName: string;
    readonly mimeType: string;
    readonly previewKind: WorkspaceFileContentTicket["previewKind"];
    readonly revision: string;
    readonly sizeBytes: number;
    readonly sourceSizeBytes?: number;
    readonly truncated?: true;
}

export interface WorkspaceFileUploadMetadata {
    readonly expiresAtMs: number;
    readonly mimeType: string;
    readonly sizeBytes: number;
    readonly status: "prepared";
    readonly ticketId: string;
}

export interface WorkspaceFilesServiceDependencies {
    readonly generateId?: () => string;
    readonly maximumReferences?: number;
    readonly nowMs?: () => number;
    readonly reader: WorkspaceFileReader;
    readonly scheduler: WorkspaceFileWriteScheduler;
    readonly spool: WorkspaceFileUploadSpool;
}

export interface WorkspaceFilesService {
    readonly acceptUpload: (
        actor: WorkspaceFileActor,
        ticketId: string,
        body: ReadableStream<Uint8Array>,
        requestId: string,
        signal?: AbortSignal
    ) => Promise<WorkspaceFileUploadAccepted>;
    readonly cleanupUploadOrphans: WorkspaceFileUploadSpool["cleanupOrphans"];
    readonly dispose: () => Promise<void>;
    readonly getWriteStatus: (
        actor: WorkspaceFileActor,
        ticketId: string,
        signal?: AbortSignal
    ) => Promise<WorkspaceFileWriteStatus>;
    readonly inspectContent: (
        actor: WorkspaceFileActor,
        ticketId: string,
        signal?: AbortSignal
    ) => Promise<WorkspaceFileContentMetadata>;
    readonly inspectUpload: (
        actor: WorkspaceFileActor,
        ticketId: string
    ) => WorkspaceFileUploadMetadata;
    readonly list: (
        actor: WorkspaceFileActor,
        input: ListWorkspaceFilesInput,
        signal?: AbortSignal
    ) => Promise<ListWorkspaceFilesOutput>;
    readonly listRoots: (
        actor: WorkspaceFileActor,
        signal?: AbortSignal
    ) => Promise<v.InferOutput<typeof listWorkspaceFileRootsOutputSchema>>;
    readonly prepareContent: (
        actor: WorkspaceFileActor,
        input: PrepareWorkspaceFileContentInput,
        signal?: AbortSignal
    ) => Promise<WorkspaceFileContentTicket>;
    readonly prepareReveal: (
        actor: WorkspaceFileActor,
        input: PrepareWorkspaceFileRevealInput,
        signal?: AbortSignal
    ) => Promise<WorkspaceFileContentTicket>;
    readonly prepareReference: (
        actor: WorkspaceFileActor,
        input: PrepareWorkspaceFileReferenceInput,
        signal?: AbortSignal
    ) => Promise<WorkspaceFileContentTicket>;
    readonly prepareUpload: (
        actor: WorkspaceFileActor,
        input: PrepareWorkspaceFileUploadInput,
        signal?: AbortSignal
    ) => Promise<WorkspaceFileUploadTicket>;
    readonly prepareWrite: (
        actor: WorkspaceFileActor,
        input: PrepareWorkspaceFileWriteInput,
        signal?: AbortSignal
    ) => Promise<WorkspaceFileUploadTicket>;
    readonly readContent: (
        actor: WorkspaceFileActor,
        ticketId: string,
        range: WorkspaceFileReadRange | undefined,
        signal?: AbortSignal
    ) => Promise<WorkspaceFileContentMetadata & { readonly bytes: Uint8Array }>;
}

interface ExpiringActorRecord {
    readonly actorKey: string;
    readonly expiresAtMs: number;
}

interface ResourceRecord extends ExpiringActorRecord {
    readonly directorySnapshotKey?: string;
    readonly id: string;
    readonly kind: "directory" | "file";
    readonly locator: WorkspaceFileLocator;
    readonly rootIndexKey?: string;
}

interface ResourceRecordOptions {
    readonly directorySnapshotKey?: string;
    readonly expiresAtMs?: number;
    readonly rootIndexKey?: string;
}

interface DirectoryPageSnapshot {
    readonly directory: ListWorkspaceFilesOutput["directory"];
    readonly directorySnapshotKey: string;
    readonly entries: readonly ListWorkspaceFilesOutput["entries"][number][];
    readonly expiresAtMs: number;
}

interface CursorRecord extends ExpiringActorRecord {
    readonly directoryId: string;
    readonly directorySnapshotKey: string;
    readonly id: string;
    readonly limit: number;
    nextCursorId?: string;
    readonly offset: number;
    readonly snapshot: DirectoryPageSnapshot;
}

interface ContentTicketRecord extends ExpiringActorRecord {
    readonly contentAccess: WorkspaceFileContentAccess;
    readonly locator: WorkspaceFileLocator;
    readonly ticket: WorkspaceFileContentTicket;
}

type UploadTicketState =
    | { readonly kind: "accepted"; readonly result: WorkspaceFileUploadAccepted }
    | { readonly kind: "prepared" }
    | { readonly kind: "receiving"; readonly spoolId: string }
    | {
          readonly kind: "reconciliation-required";
          readonly receipt?: WorkspaceFileSpoolReceipt;
      };

interface UploadTicketRecord extends ExpiringActorRecord {
    readonly command: Omit<WorkspaceFileWriteCommand, "sha256" | "spoolId">;
    readonly id: string;
    reconciliation?: Promise<WorkspaceFileUploadAccepted | undefined>;
    state: UploadTicketState;
    readonly uploadContentPolicy?: WorkspaceFileUploadContentPolicy;
}

function actorKey(actor: WorkspaceFileActor): string {
    for (const value of [actor.id, actor.authenticatorId]) {
        if (
            value.length === 0 ||
            value.length > 256 ||
            value !== value.trim() ||
            /[\p{Cc}\p{Cf}]/u.test(value)
        ) {
            throw new WorkspaceFileError("invalid-input");
        }
    }
    return `${actor.id}\0${actor.authenticatorId}`;
}

function directorySnapshotKey(key: string, directoryId: string): string {
    return `${key}\0${directoryId}`;
}

function abortIfRequested(signal?: AbortSignal): void {
    if (signal?.aborted !== true) return;
    throw signal.reason ?? new DOMException("Workspace files aborted", "AbortError");
}

function auditActor(actor: WorkspaceFileActor): WorkspaceFileWriteAuditContext["actor"] {
    return Object.freeze({
        authenticatorId: actor.authenticatorId,
        id: actor.id,
        kind: "user",
    });
}

function displayPath(locator: WorkspaceFileLocator): string {
    const value = `/${locator.segments.join("/")}`;
    if (value.length > 4096) throw new WorkspaceFileError("too-large");
    return value;
}

function sameLocator(left: WorkspaceFileLocator, right: WorkspaceFileLocator): boolean {
    return (
        left.rootId === right.rootId &&
        left.segments.length === right.segments.length &&
        left.segments.every((segment, index) => segment === right.segments[index])
    );
}

function completeFileNode(node: WorkspaceFileNode): asserts node is WorkspaceFileNode & {
    readonly kind: "file";
    readonly mimeType: string;
    readonly previewKind: WorkspaceFileContentTicket["previewKind"];
    readonly sizeBytes: number;
} {
    if (
        node.kind !== "file" ||
        node.mimeType === undefined ||
        node.previewKind === undefined ||
        node.sizeBytes === undefined ||
        (node.truncated === true &&
            (node.sourceSizeBytes === undefined ||
                node.sourceSizeBytes <= node.sizeBytes ||
                node.sizeBytes > workspaceFileLimits.maximumTextPreviewBytes)) ||
        (node.truncated !== true && node.sourceSizeBytes !== undefined)
    ) {
        throw new WorkspaceFileError("not-file");
    }
}

function sameContentMetadata(
    node: WorkspaceFileNode,
    ticket: WorkspaceFileContentTicket
): boolean {
    return (
        node.kind === "file" &&
        node.name === ticket.fileName &&
        node.mimeType === ticket.mimeType &&
        node.previewKind === ticket.previewKind &&
        node.revision === ticket.revision &&
        node.sizeBytes === ticket.sizeBytes &&
        node.sourceSizeBytes === ticket.sourceSizeBytes &&
        node.truncated === ticket.truncated
    );
}

function entryOutput(
    node: WorkspaceFileNode,
    resourceId: string
): ListWorkspaceFilesOutput["entries"][number] {
    return {
        kind: node.kind,
        ...(node.mimeType === undefined ? {} : { mimeType: node.mimeType }),
        ...(node.modifiedAtMs === undefined ? {} : { modifiedAtMs: node.modifiedAtMs }),
        name: node.name,
        ...(node.previewKind === undefined ? {} : { previewKind: node.previewKind }),
        ...(node.requiresSecretReveal === undefined
            ? {}
            : { requiresSecretReveal: node.requiresSecretReveal }),
        resourceId,
        revision: node.revision,
        ...(node.sizeBytes === undefined ? {} : { sizeBytes: node.sizeBytes }),
        ...(node.truncated === true ? { truncated: true as const } : {}),
        writable: node.writable,
    };
}

/**
 * Creates the bounded actor-bound resource, cursor, and raw-transfer lifecycle.
 * @param dependencies Descriptor reader, private spool, and durable scheduler ports.
 * @returns Process-local files control plane shared by tRPC and raw HTTP handlers.
 */
export function createWorkspaceFilesService(
    dependencies: WorkspaceFilesServiceDependencies
): WorkspaceFilesService {
    const generateId = dependencies.generateId ?? randomUUID;
    const maximumReferences =
        dependencies.maximumReferences ?? workspaceFileLimits.maximumReferenceCount;
    const nowMs = dependencies.nowMs ?? Date.now;
    if (
        !Number.isSafeInteger(maximumReferences) ||
        maximumReferences < workspaceFileLimits.maximumConfiguredRoots ||
        maximumReferences > workspaceFileLimits.maximumReferenceCount
    ) {
        throw new TypeError("Workspace file reference capacity is invalid");
    }

    const resources = new Map<string, ResourceRecord>();
    const rootResourceIds = new Map<string, string>();
    const materializedDirectorySnapshots = new Set<string>();
    const directorySnapshotResourceIds = new Map<string, Set<string>>();
    const directorySnapshotCursorIds = new Map<string, Set<string>>();
    const directoryRefreshGenerations = new Map<string, symbol>();
    const cursors = new Map<string, CursorRecord>();
    const contentTickets = new Map<string, ContentTicketRecord>();
    const uploadTickets = new Map<string, UploadTicketRecord>();
    let disposed = false;

    function checkedNow(): number {
        if (disposed) throw new WorkspaceFileError("unavailable");
        const now = nowMs();
        if (!Number.isSafeInteger(now) || now < 0) {
            throw new WorkspaceFileError("unavailable");
        }
        return now;
    }

    function deleteResourceRecord(record: ResourceRecord): void {
        resources.delete(record.id);
        if (record.directorySnapshotKey !== undefined) {
            const resourceIds = directorySnapshotResourceIds.get(
                record.directorySnapshotKey
            );
            resourceIds?.delete(record.id);
            if (resourceIds?.size === 0) {
                directorySnapshotResourceIds.delete(record.directorySnapshotKey);
            }
        }
        if (
            record.rootIndexKey !== undefined &&
            rootResourceIds.get(record.rootIndexKey) === record.id
        ) {
            rootResourceIds.delete(record.rootIndexKey);
        }
    }

    function deleteDirectorySnapshot(
        initialSnapshotKey: string,
        preservedGenerationKey?: string
    ): void {
        const pending = [initialSnapshotKey];
        const visited = new Set<string>();
        while (pending.length > 0) {
            const snapshotKey = pending.pop()!;
            if (visited.has(snapshotKey)) continue;
            visited.add(snapshotKey);
            materializedDirectorySnapshots.delete(snapshotKey);
            if (snapshotKey !== preservedGenerationKey) {
                directoryRefreshGenerations.delete(snapshotKey);
            }
            const resourceIds = directorySnapshotResourceIds.get(snapshotKey);
            directorySnapshotResourceIds.delete(snapshotKey);
            for (const resourceId of resourceIds ?? []) {
                const resource = resources.get(resourceId);
                if (resource === undefined) continue;
                deleteResourceRecord(resource);
                if (resource.kind !== "directory") continue;
                const childSnapshotKey = directorySnapshotKey(
                    resource.actorKey,
                    resource.id
                );
                if (
                    materializedDirectorySnapshots.has(childSnapshotKey) ||
                    directoryRefreshGenerations.has(childSnapshotKey)
                ) {
                    pending.push(childSnapshotKey);
                }
            }
            const cursorIds = directorySnapshotCursorIds.get(snapshotKey);
            directorySnapshotCursorIds.delete(snapshotKey);
            for (const cursorId of cursorIds ?? []) {
                cursors.delete(cursorId);
            }
        }
    }

    function deleteResource(record: ResourceRecord): void {
        deleteResourceRecord(record);
        if (record.kind !== "directory") return;
        const ownedSnapshotKey = directorySnapshotKey(record.actorKey, record.id);
        if (
            materializedDirectorySnapshots.has(ownedSnapshotKey) ||
            directoryRefreshGenerations.has(ownedSnapshotKey)
        ) {
            deleteDirectorySnapshot(ownedSnapshotKey);
        }
    }

    function deleteExpiredResource(record: ResourceRecord): void {
        if (record.directorySnapshotKey === undefined) {
            deleteResource(record);
            return;
        }
        deleteDirectorySnapshot(record.directorySnapshotKey, record.directorySnapshotKey);
    }

    function sweep(now: number): void {
        for (const record of resources.values()) {
            if (record.expiresAtMs <= now) deleteExpiredResource(record);
        }
        for (const record of cursors.values()) {
            if (record.expiresAtMs <= now) {
                deleteDirectorySnapshot(
                    record.directorySnapshotKey,
                    record.directorySnapshotKey
                );
            }
        }
        for (const [id, record] of contentTickets) {
            if (record.expiresAtMs <= now) contentTickets.delete(id);
        }
        for (const [id, record] of uploadTickets) {
            if (record.expiresAtMs <= now) uploadTickets.delete(id);
        }
    }

    function referenceCount(): number {
        return resources.size + cursors.size + contentTickets.size + uploadTickets.size;
    }

    function reserveCapacity(count: number, now: number): void {
        sweep(now);
        if (count < 0 || referenceCount() > maximumReferences - count) {
            throw new WorkspaceFileError("capacity");
        }
    }

    function hasId(id: string): boolean {
        return (
            resources.has(id) ||
            cursors.has(id) ||
            contentTickets.has(id) ||
            uploadTickets.has(id)
        );
    }

    function nextId(): string {
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const parsed = v.safeParse(workspaceFileResourceIdSchema, generateId(), {
                abortEarly: true,
            });
            if (parsed.success && !hasId(parsed.output)) return parsed.output;
        }
        throw new WorkspaceFileError("unavailable");
    }

    function createResource(
        key: string,
        locator: WorkspaceFileLocator,
        kind: ResourceRecord["kind"],
        now: number,
        options: ResourceRecordOptions = {}
    ): ResourceRecord {
        const record: ResourceRecord = {
            actorKey: key,
            ...(options.directorySnapshotKey === undefined
                ? {}
                : { directorySnapshotKey: options.directorySnapshotKey }),
            expiresAtMs: options.expiresAtMs ?? now + workspaceFileLimits.referenceTtlMs,
            id: nextId(),
            kind,
            locator,
            ...(options.rootIndexKey === undefined
                ? {}
                : { rootIndexKey: options.rootIndexKey }),
        };
        resources.set(record.id, record);
        if (record.directorySnapshotKey !== undefined) {
            const resourceIds =
                directorySnapshotResourceIds.get(record.directorySnapshotKey) ??
                new Set<string>();
            resourceIds.add(record.id);
            directorySnapshotResourceIds.set(record.directorySnapshotKey, resourceIds);
        }
        if (options.rootIndexKey !== undefined) {
            rootResourceIds.set(options.rootIndexKey, record.id);
        }
        return record;
    }

    function directorySnapshotReferenceCount(initialSnapshotKey: string): number {
        let count = 0;
        const pending = [initialSnapshotKey];
        const visited = new Set<string>();
        while (pending.length > 0) {
            const snapshotKey = pending.pop()!;
            if (visited.has(snapshotKey)) continue;
            visited.add(snapshotKey);
            const resourceIds = directorySnapshotResourceIds.get(snapshotKey);
            count += resourceIds?.size ?? 0;
            for (const resourceId of resourceIds ?? []) {
                const resource = resources.get(resourceId);
                if (resource === undefined) continue;
                if (resource.kind !== "directory") continue;
                const childSnapshotKey = directorySnapshotKey(
                    resource.actorKey,
                    resource.id
                );
                if (materializedDirectorySnapshots.has(childSnapshotKey)) {
                    pending.push(childSnapshotKey);
                }
            }
            count += directorySnapshotCursorIds.get(snapshotKey)?.size ?? 0;
        }
        return count;
    }

    function replaceDirectorySnapshot(
        key: string,
        directoryId: string,
        count: number,
        now: number
    ): string {
        sweep(now);
        const snapshotKey = directorySnapshotKey(key, directoryId);
        const reclaimed = directorySnapshotReferenceCount(snapshotKey);
        if (count < 0 || referenceCount() - reclaimed > maximumReferences - count) {
            throw new WorkspaceFileError("capacity");
        }
        deleteDirectorySnapshot(snapshotKey, snapshotKey);
        materializedDirectorySnapshots.add(snapshotKey);
        return snapshotKey;
    }

    function beginDirectoryRefresh(snapshotKey: string): symbol {
        if (
            !directoryRefreshGenerations.has(snapshotKey) &&
            directoryRefreshGenerations.size >= maximumReferences
        ) {
            throw new WorkspaceFileError("capacity");
        }
        const generation = Symbol();
        directoryRefreshGenerations.set(snapshotKey, generation);
        return generation;
    }

    function requireCurrentDirectoryRefresh(
        snapshotKey: string,
        generation: symbol
    ): void {
        if (directoryRefreshGenerations.get(snapshotKey) !== generation) {
            throw new WorkspaceFileError("conflict");
        }
    }

    function finishDirectoryRefresh(snapshotKey: string, generation: symbol): void {
        if (directoryRefreshGenerations.get(snapshotKey) === generation) {
            directoryRefreshGenerations.delete(snapshotKey);
        }
    }

    function resolveResource(
        actor: WorkspaceFileActor,
        id: string,
        kind?: ResourceRecord["kind"]
    ): ResourceRecord {
        const key = actorKey(actor);
        const now = checkedNow();
        sweep(now);
        const record = resources.get(id);
        if (record === undefined || record.actorKey !== key) {
            throw new WorkspaceFileError("not-found");
        }
        if (record.expiresAtMs <= now) {
            deleteExpiredResource(record);
            throw new WorkspaceFileError("not-found");
        }
        if (kind !== undefined && record.kind !== kind) {
            throw new WorkspaceFileError("not-file");
        }
        return record;
    }

    function createSnapshot(
        key: string,
        directoryId: string,
        snapshot: WorkspaceFileDirectorySnapshot,
        now: number,
        limit: number,
        directoryExpiresAtMs: number
    ): DirectoryPageSnapshot {
        const expiresAtMs = Math.min(
            now + workspaceFileLimits.referenceTtlMs,
            directoryExpiresAtMs
        );
        const directorySnapshotKey = replaceDirectorySnapshot(
            key,
            directoryId,
            snapshot.entries.length + (snapshot.entries.length > limit ? 1 : 0),
            now
        );
        try {
            const entries = snapshot.entries.map((node) => {
                const resource = createResource(key, node.locator, node.kind, now, {
                    directorySnapshotKey,
                    expiresAtMs,
                });
                return entryOutput(node, resource.id);
            });
            const prepared = {
                directory: {
                    displayPath: displayPath(snapshot.directory.locator),
                    name: snapshot.directory.name,
                    resourceId: directoryId,
                    revision: snapshot.directory.revision,
                    rootId: snapshot.directory.locator.rootId,
                    writable: snapshot.directory.writable,
                },
                directorySnapshotKey,
                entries,
                expiresAtMs,
            } satisfies DirectoryPageSnapshot;
            return prepared;
        } catch (error) {
            deleteDirectorySnapshot(directorySnapshotKey, directorySnapshotKey);
            throw error;
        }
    }

    function createCursor(
        key: string,
        directoryId: string,
        snapshot: DirectoryPageSnapshot,
        offset: number,
        limit: number
    ): CursorRecord {
        const record: CursorRecord = {
            actorKey: key,
            directoryId,
            directorySnapshotKey: snapshot.directorySnapshotKey,
            expiresAtMs: snapshot.expiresAtMs,
            id: nextId(),
            limit,
            offset,
            snapshot,
        };
        cursors.set(record.id, record);
        const cursorIds =
            directorySnapshotCursorIds.get(snapshot.directorySnapshotKey) ??
            new Set<string>();
        cursorIds.add(record.id);
        directorySnapshotCursorIds.set(snapshot.directorySnapshotKey, cursorIds);
        return record;
    }

    function page(
        key: string,
        directoryId: string,
        snapshot: DirectoryPageSnapshot,
        offset: number,
        limit: number,
        now: number,
        sourceCursor?: CursorRecord
    ): ListWorkspaceFilesOutput {
        const end = Math.min(offset + limit, snapshot.entries.length);
        let nextCursor: string | undefined;
        if (end < snapshot.entries.length) {
            if (sourceCursor?.nextCursorId === undefined) {
                reserveCapacity(1, now);
                nextCursor = createCursor(key, directoryId, snapshot, end, limit).id;
                if (sourceCursor !== undefined) sourceCursor.nextCursorId = nextCursor;
            } else {
                nextCursor = sourceCursor.nextCursorId;
            }
        }
        return v.parse(listWorkspaceFilesOutputSchema, {
            directory: snapshot.directory,
            entries: snapshot.entries.slice(offset, end),
            ...(nextCursor === undefined ? {} : { nextCursor }),
        });
    }

    function resolveContentRecord(
        actor: WorkspaceFileActor,
        ticketId: string
    ): ContentTicketRecord {
        const key = actorKey(actor);
        const now = checkedNow();
        const record = contentTickets.get(ticketId);
        if (record === undefined || record.actorKey !== key) {
            throw new WorkspaceFileError("not-found");
        }
        if (record.expiresAtMs <= now) {
            contentTickets.delete(ticketId);
            throw new WorkspaceFileError("expired");
        }
        sweep(now);
        return record;
    }

    function resolveUploadRecord(
        actor: WorkspaceFileActor,
        ticketId: string
    ): UploadTicketRecord {
        const key = actorKey(actor);
        const now = checkedNow();
        const record = uploadTickets.get(ticketId);
        if (record === undefined || record.actorKey !== key) {
            throw new WorkspaceFileError("not-found");
        }
        if (record.expiresAtMs <= now) {
            uploadTickets.delete(ticketId);
            throw new WorkspaceFileError("expired");
        }
        sweep(now);
        return record;
    }

    async function currentContentMetadata(
        record: ContentTicketRecord,
        signal?: AbortSignal
    ): Promise<WorkspaceFileContentMetadata> {
        const node = await dependencies.reader.describe(
            record.locator,
            signal,
            record.contentAccess
        );
        if (!sameContentMetadata(node, record.ticket)) {
            throw new WorkspaceFileError("conflict");
        }
        return {
            disposition: record.ticket.disposition,
            fileName: record.ticket.fileName,
            mimeType: record.ticket.mimeType,
            previewKind: record.ticket.previewKind,
            revision: record.ticket.revision,
            sizeBytes: record.ticket.sizeBytes,
            ...(record.ticket.sourceSizeBytes === undefined
                ? {}
                : { sourceSizeBytes: record.ticket.sourceSizeBytes }),
            ...(record.ticket.truncated === true ? { truncated: true as const } : {}),
        };
    }

    async function createContentTicket(
        actor: WorkspaceFileActor,
        resourceId: string,
        disposition: WorkspaceFileContentTicket["disposition"],
        contentAccess: WorkspaceFileContentAccess,
        signal?: AbortSignal
    ): Promise<WorkspaceFileContentTicket> {
        const resource = resolveResource(actor, resourceId, "file");
        let node: WorkspaceFileNode;
        try {
            node = await dependencies.reader.describe(
                resource.locator,
                signal,
                contentAccess
            );
        } catch (error) {
            throw workspaceFileError(error);
        }
        completeFileNode(node);
        if (contentAccess === "reveal-secrets" && node.requiresSecretReveal !== true) {
            throw new WorkspaceFileError("access-denied");
        }
        if (node.sizeBytes > workspaceFileLimits.maximumDownloadBytes) {
            throw new WorkspaceFileError("too-large");
        }
        const now = checkedNow();
        reserveCapacity(1, now);
        const ticketId = nextId();
        const ticket = v.parse(workspaceFileContentTicketSchema, {
            disposition,
            expiresAtMs: now + workspaceFileLimits.contentTicketTtlMs,
            fileName: node.name,
            mimeType: node.mimeType,
            previewKind: node.previewKind,
            revision: node.revision,
            sizeBytes: node.sizeBytes,
            ...(node.sourceSizeBytes === undefined
                ? {}
                : { sourceSizeBytes: node.sourceSizeBytes }),
            ticketId,
            ...(node.truncated === true ? { truncated: true as const } : {}),
            url: `/api/files/content/${ticketId}`,
        });
        contentTickets.set(ticketId, {
            actorKey: actorKey(actor),
            contentAccess,
            expiresAtMs: ticket.expiresAtMs,
            locator: resource.locator,
            ticket,
        });
        return ticket;
    }

    function createUploadTicket(
        key: string,
        now: number,
        command: Omit<WorkspaceFileWriteCommand, "sha256" | "spoolId" | "ticketId">,
        uploadContentPolicy?: WorkspaceFileUploadContentPolicy
    ): WorkspaceFileUploadTicket {
        reserveCapacity(1, now);
        const ticketId = nextId();
        const expiresAtMs = now + workspaceFileLimits.uploadTicketTtlMs;
        uploadTickets.set(ticketId, {
            actorKey: key,
            command: { ...command, ticketId },
            expiresAtMs,
            id: ticketId,
            state: { kind: "prepared" },
            ...(uploadContentPolicy === undefined ? {} : { uploadContentPolicy }),
        });
        return v.parse(workspaceFileUploadTicketSchema, {
            expiresAtMs,
            ticketId,
            uploadUrl: `/api/files/uploads/${ticketId}`,
        });
    }

    function reconcileUploadEnqueue(
        actor: WorkspaceFileActor,
        record: UploadTicketRecord
    ): Promise<WorkspaceFileUploadAccepted | undefined> {
        const state = record.state;
        if (state.kind === "accepted") {
            return Promise.resolve(state.result);
        }
        if (state.kind !== "reconciliation-required" || state.receipt === undefined) {
            return Promise.resolve(undefined);
        }
        if (record.reconciliation !== undefined) return record.reconciliation;

        const receipt = state.receipt;
        const command: WorkspaceFileWriteCommand = {
            ...record.command,
            sha256: receipt.sha256,
            spoolId: receipt.spoolId,
        };
        const reconciliation = (async () => {
            const durable = await dependencies.scheduler.reconcileEnqueue(
                command,
                auditActor(actor)
            );
            switch (durable.kind) {
                case "accepted": {
                    const result = v.parse(
                        workspaceFileUploadAcceptedSchema,
                        durable.result
                    );
                    if (result.ticketId !== record.id) {
                        throw new WorkspaceFileError("unavailable");
                    }
                    record.state = { kind: "accepted", result };
                    return result;
                }
                case "absent": {
                    break;
                }
                default: {
                    durable satisfies never;
                    throw new WorkspaceFileError("unavailable");
                }
            }
            await dependencies.spool.discard(receipt.spoolId);
            if (record.state === state) {
                record.state = { kind: "reconciliation-required" };
            }
            return;
        })();
        record.reconciliation = reconciliation;
        void reconciliation.then(
            () => {
                if (record.reconciliation === reconciliation) {
                    delete record.reconciliation;
                }
                return;
            },
            () => {
                if (record.reconciliation === reconciliation) {
                    delete record.reconciliation;
                }
                return;
            }
        );
        return reconciliation;
    }

    return Object.freeze<WorkspaceFilesService>({
        async acceptUpload(actor, ticketId, body, requestId, signal) {
            const record = resolveUploadRecord(actor, ticketId);
            if (record.state.kind !== "prepared") {
                throw new WorkspaceFileError("conflict");
            }
            if (
                requestId.length === 0 ||
                requestId.length > 256 ||
                /[\p{Cc}\p{Cf}]/u.test(requestId)
            ) {
                throw new WorkspaceFileError("invalid-input");
            }
            reserveCapacity(0, checkedNow());
            const spoolId = nextId();
            record.state = { kind: "receiving", spoolId };
            let guardedBody: ReadableStream<Uint8Array> | undefined;
            let receipt: Awaited<ReturnType<WorkspaceFileUploadSpool["receive"]>>;
            try {
                guardedBody =
                    record.uploadContentPolicy === "reject-redaction-sentinel"
                        ? rejectRedactionSentinel(body)
                        : undefined;
                receipt = await dependencies.spool.receive({
                    body: guardedBody ?? body,
                    expectedBytes: record.command.sizeBytes,
                    signal,
                    spoolId,
                });
            } catch (error) {
                await guardedBody?.cancel(error).catch(() => {});
                record.state = { kind: "prepared" };
                throw workspaceFileError(error);
            }
            const command: WorkspaceFileWriteCommand = {
                ...record.command,
                sha256: receipt.sha256,
                spoolId: receipt.spoolId,
            };
            try {
                const result = v.parse(
                    workspaceFileUploadAcceptedSchema,
                    await dependencies.scheduler.enqueue(
                        command,
                        { actor: auditActor(actor), requestId },
                        signal
                    )
                );
                if (result.ticketId !== ticketId) {
                    throw new WorkspaceFileError("unavailable");
                }
                record.state = { kind: "accepted", result };
                return result;
            } catch (error) {
                record.state = { kind: "reconciliation-required", receipt };
                try {
                    const recovered = await reconcileUploadEnqueue(actor, record);
                    if (recovered !== undefined) return recovered;
                } catch {
                    // Unknown durable state retains its private spool for later polling.
                }
                throw workspaceFileError(error);
            }
        },
        async cleanupUploadOrphans(input) {
            try {
                const active = await dependencies.scheduler.listActiveSpoolIds();
                if (active.truncated) throw new WorkspaceFileError("unavailable");
                return await dependencies.spool.cleanupOrphans({
                    ...input,
                    preserveSpoolIds: active.spoolIds,
                });
            } catch (error) {
                throw workspaceFileError(error);
            }
        },
        async dispose() {
            if (disposed) return;
            disposed = true;
            resources.clear();
            rootResourceIds.clear();
            materializedDirectorySnapshots.clear();
            directorySnapshotResourceIds.clear();
            directorySnapshotCursorIds.clear();
            directoryRefreshGenerations.clear();
            cursors.clear();
            contentTickets.clear();
            uploadTickets.clear();
            await Promise.allSettled([
                dependencies.reader.dispose(),
                dependencies.spool.dispose(),
            ]);
        },
        async getWriteStatus(actor, ticketId, signal) {
            const parsed = v.parse(getWorkspaceFileWriteStatusInputSchema, {
                ticketId,
            });
            let durable: WorkspaceFileWriteStatus | undefined;
            try {
                const candidate = await dependencies.scheduler.getStatus(
                    parsed.ticketId,
                    auditActor(actor),
                    signal
                );
                durable =
                    candidate === undefined
                        ? undefined
                        : v.parse(workspaceFileWriteStatusSchema, candidate);
                if (durable !== undefined && durable.ticketId !== parsed.ticketId) {
                    throw new WorkspaceFileError("unavailable");
                }
            } catch (error) {
                throw workspaceFileError(error);
            }
            if (durable !== undefined) return durable;
            let record: UploadTicketRecord;
            try {
                record = resolveUploadRecord(actor, parsed.ticketId);
            } catch (error) {
                if (error instanceof WorkspaceFileError && error.reason === "expired") {
                    throw new WorkspaceFileError("not-found", error);
                }
                throw error;
            }
            switch (record.state.kind) {
                case "accepted": {
                    return {
                        jobRunId: record.state.result.jobRunId,
                        status: "accepted",
                        ticketId: parsed.ticketId,
                    };
                }
                case "prepared":
                case "receiving": {
                    return { status: "pending", ticketId: parsed.ticketId };
                }
                case "reconciliation-required": {
                    try {
                        const recovered = await reconcileUploadEnqueue(actor, record);
                        if (recovered !== undefined) {
                            return {
                                jobRunId: recovered.jobRunId,
                                status: "accepted",
                                ticketId: parsed.ticketId,
                            };
                        }
                    } catch {
                        // Reconciliation remains unknown; retaining the spool is fail-closed.
                    }
                    return {
                        status: "reconciliation-required",
                        ticketId: parsed.ticketId,
                    };
                }
            }
        },
        async inspectContent(actor, ticketId, signal) {
            return currentContentMetadata(resolveContentRecord(actor, ticketId), signal);
        },
        inspectUpload(actor, ticketId) {
            const record = resolveUploadRecord(actor, ticketId);
            if (record.state.kind !== "prepared") {
                throw new WorkspaceFileError("conflict");
            }
            return {
                expiresAtMs: record.expiresAtMs,
                mimeType: record.command.mimeType,
                sizeBytes: record.command.sizeBytes,
                status: "prepared",
                ticketId,
            };
        },
        async list(actor, rawInput, signal) {
            const input = v.parse(listWorkspaceFilesInputSchema, rawInput);
            const key = actorKey(actor);
            const now = checkedNow();
            if (input.cursor !== undefined) {
                const cursor = cursors.get(input.cursor);
                if (cursor === undefined || cursor.actorKey !== key) {
                    throw new WorkspaceFileError("not-found");
                }
                if (cursor.expiresAtMs <= now) {
                    deleteDirectorySnapshot(
                        cursor.directorySnapshotKey,
                        cursor.directorySnapshotKey
                    );
                    throw new WorkspaceFileError("not-found");
                }
                if (
                    cursor.directoryId !== input.directoryId ||
                    cursor.limit !== input.limit
                ) {
                    throw new WorkspaceFileError("conflict");
                }
                sweep(now);
                const directory = resources.get(cursor.directoryId);
                if (
                    cursors.get(cursor.id) !== cursor ||
                    directory === undefined ||
                    directory.actorKey !== key ||
                    directory.kind !== "directory" ||
                    directory.expiresAtMs <= now
                ) {
                    deleteDirectorySnapshot(
                        cursor.directorySnapshotKey,
                        cursor.directorySnapshotKey
                    );
                    throw new WorkspaceFileError("not-found");
                }
                return page(
                    key,
                    input.directoryId,
                    cursor.snapshot,
                    cursor.offset,
                    cursor.limit,
                    now,
                    cursor
                );
            }
            const resource = resolveResource(actor, input.directoryId, "directory");
            const snapshotKey = directorySnapshotKey(key, resource.id);
            const refreshGeneration = beginDirectoryRefresh(snapshotKey);
            try {
                let snapshot: WorkspaceFileDirectorySnapshot;
                try {
                    snapshot = await dependencies.reader.list(resource.locator, signal);
                } catch (error) {
                    throw workspaceFileError(error);
                }
                abortIfRequested(signal);
                requireCurrentDirectoryRefresh(snapshotKey, refreshGeneration);
                const refreshedNow = checkedNow();
                sweep(refreshedNow);
                if (resources.get(resource.id) !== resource) {
                    if (resource.expiresAtMs <= refreshedNow) {
                        throw new WorkspaceFileError("not-found");
                    }
                    requireCurrentDirectoryRefresh(snapshotKey, refreshGeneration);
                    throw new WorkspaceFileError("conflict");
                }
                requireCurrentDirectoryRefresh(snapshotKey, refreshGeneration);
                if (resource.actorKey !== key || resource.kind !== "directory") {
                    throw new WorkspaceFileError("conflict");
                }
                if (resource.expiresAtMs <= refreshedNow) {
                    deleteExpiredResource(resource);
                    throw new WorkspaceFileError("not-found");
                }
                const prepared = createSnapshot(
                    key,
                    resource.id,
                    snapshot,
                    refreshedNow,
                    input.limit,
                    resource.expiresAtMs
                );
                return page(key, resource.id, prepared, 0, input.limit, refreshedNow);
            } finally {
                finishDirectoryRefresh(snapshotKey, refreshGeneration);
            }
        },
        listRoots(actor, signal) {
            const key = actorKey(actor);
            const now = checkedNow();
            const policies = dependencies.reader.roots();
            const missingRootCount = policies.filter((policy) => {
                const existingId = rootResourceIds.get(`${key}\0${policy.id}`);
                const resource =
                    existingId === undefined ? undefined : resources.get(existingId);
                return resource === undefined || resource.expiresAtMs <= now;
            }).length;
            reserveCapacity(missingRootCount, now);
            const roots = [];
            for (const policy of policies) {
                const indexKey = `${key}\0${policy.id}`;
                const existingId = rootResourceIds.get(indexKey);
                let resource =
                    existingId === undefined ? undefined : resources.get(existingId);
                if (resource === undefined || resource.expiresAtMs <= now) {
                    if (resource !== undefined) deleteResource(resource);
                    resource = createResource(
                        key,
                        { rootId: policy.id, segments: [] },
                        "directory",
                        now,
                        { rootIndexKey: indexKey }
                    );
                }
                roots.push({
                    id: policy.id,
                    label: policy.label,
                    resourceId: resource.id,
                    writable: policy.writable,
                });
            }
            if (signal?.aborted === true) {
                throw (
                    signal.reason ??
                    new DOMException("Workspace files aborted", "AbortError")
                );
            }
            return Promise.resolve(
                v.parse(listWorkspaceFileRootsOutputSchema, { roots })
            );
        },
        async prepareContent(actor, rawInput, signal) {
            const input = v.parse(prepareWorkspaceFileContentInputSchema, rawInput);
            return createContentTicket(
                actor,
                input.resourceId,
                input.disposition,
                "default",
                signal
            );
        },
        async prepareReference(actor, rawInput, signal) {
            const input = v.parse(prepareWorkspaceFileReferenceInputSchema, rawInput);
            let locator: WorkspaceFileLocator | undefined;
            try {
                locator = await dependencies.reader.resolveReference?.(
                    input.reference,
                    signal
                );
            } catch (error) {
                throw workspaceFileError(error);
            }
            if (locator === undefined) throw new WorkspaceFileError("not-found");
            const now = checkedNow();
            reserveCapacity(2, now);
            const resource = createResource(actorKey(actor), locator, "file", now);
            try {
                return await createContentTicket(
                    actor,
                    resource.id,
                    "preview",
                    "default",
                    signal
                );
            } catch (error) {
                deleteResource(resource);
                throw error;
            }
        },
        async prepareReveal(actor, rawInput, signal) {
            const input = v.parse(prepareWorkspaceFileRevealInputSchema, rawInput);
            return createContentTicket(
                actor,
                input.resourceId,
                "preview",
                "reveal-secrets",
                signal
            );
        },
        async prepareUpload(actor, rawInput, signal) {
            const input = v.parse(prepareWorkspaceFileUploadInputSchema, rawInput);
            if (
                input.fileName.startsWith(".") &&
                input.fileName !== ".env.example" &&
                input.fileName !== ".environment.example"
            ) {
                throw new WorkspaceFileError("access-denied");
            }
            const directory = resolveResource(actor, input.directoryId, "directory");
            let node: WorkspaceFileNode;
            try {
                node = await dependencies.reader.describe(directory.locator, signal);
            } catch (error) {
                throw workspaceFileError(error);
            }
            if (node.kind !== "directory" || !node.writable) {
                throw new WorkspaceFileError("access-denied");
            }
            const now = checkedNow();
            return createUploadTicket(actorKey(actor), now, {
                fileName: input.fileName,
                locator: directory.locator,
                mimeType: input.mimeType,
                operation: "create",
                sizeBytes: input.sizeBytes,
            });
        },
        async prepareWrite(actor, rawInput, signal) {
            const input = v.parse(prepareWorkspaceFileWriteInputSchema, rawInput);
            const resource = resolveResource(actor, input.resourceId, "file");
            let reveal: ContentTicketRecord | undefined;
            if (input.revealTicketId !== undefined) {
                reveal = resolveContentRecord(actor, input.revealTicketId);
                if (
                    reveal.contentAccess !== "reveal-secrets" ||
                    !sameLocator(reveal.locator, resource.locator)
                ) {
                    throw new WorkspaceFileError("access-denied");
                }
                if (reveal.ticket.revision !== input.expectedRevision) {
                    throw new WorkspaceFileError("conflict");
                }
            }
            let node: WorkspaceFileNode;
            try {
                node = await dependencies.reader.describe(
                    resource.locator,
                    signal,
                    reveal === undefined ? "default" : "reveal-secrets"
                );
            } catch (error) {
                throw workspaceFileError(error);
            }
            completeFileNode(node);
            if (!node.writable) throw new WorkspaceFileError("access-denied");
            if (node.sizeBytes > workspaceFileLimits.maximumDownloadBytes) {
                throw new WorkspaceFileError("too-large");
            }
            if (
                node.writeMaximumSizeBytes !== undefined &&
                input.sizeBytes > node.writeMaximumSizeBytes
            ) {
                throw new WorkspaceFileError("too-large");
            }
            if (node.revision !== input.expectedRevision) {
                throw new WorkspaceFileError("conflict");
            }
            if (node.requiresSecretReveal === true) {
                if (reveal === undefined) {
                    throw new WorkspaceFileError("access-denied");
                }
            } else if (reveal !== undefined) {
                throw new WorkspaceFileError("invalid-input");
            }
            const now = checkedNow();
            return createUploadTicket(
                actorKey(actor),
                now,
                {
                    expectedRevision: input.expectedRevision,
                    fileName: node.name,
                    locator: resource.locator,
                    mimeType: input.mimeType,
                    operation: "replace",
                    sizeBytes: input.sizeBytes,
                },
                node.uploadContentPolicy
            );
        },
        async readContent(actor, ticketId, range, signal) {
            const record = resolveContentRecord(actor, ticketId);
            let result: WorkspaceFileReadResult;
            try {
                result = await dependencies.reader.read(
                    record.locator,
                    record.ticket.revision,
                    range,
                    signal,
                    record.contentAccess
                );
            } catch (error) {
                throw workspaceFileError(error);
            }
            if (
                result.fileName !== record.ticket.fileName ||
                result.mimeType !== record.ticket.mimeType ||
                result.previewKind !== record.ticket.previewKind ||
                result.revision !== record.ticket.revision ||
                result.sizeBytes !== record.ticket.sizeBytes ||
                result.sourceSizeBytes !== record.ticket.sourceSizeBytes ||
                result.truncated !== record.ticket.truncated
            ) {
                throw new WorkspaceFileError("conflict");
            }
            return {
                bytes: result.bytes,
                disposition: record.ticket.disposition,
                fileName: result.fileName,
                mimeType: result.mimeType,
                previewKind: result.previewKind,
                revision: result.revision,
                sizeBytes: result.sizeBytes,
                ...(result.sourceSizeBytes === undefined
                    ? {}
                    : { sourceSizeBytes: result.sourceSizeBytes }),
                ...(result.truncated === true ? { truncated: true as const } : {}),
            };
        },
    });
}
