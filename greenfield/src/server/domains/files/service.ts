import { randomUUID } from "node:crypto";

import * as v from "valibot";

import {
    getWorkspaceFileWriteStatusInputSchema,
    listWorkspaceFileRootsOutputSchema,
    listWorkspaceFilesInputSchema,
    listWorkspaceFilesOutputSchema,
    prepareWorkspaceFileContentInputSchema,
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
    WorkspaceFileLocator,
    WorkspaceFileNode,
    WorkspaceFileReadRange,
    WorkspaceFileReadResult,
    WorkspaceFileReader,
    WorkspaceFileUploadSpool,
    WorkspaceFileWriteAuditContext,
    WorkspaceFileWriteCommand,
    WorkspaceFileWriteScheduler,
} from "./ports.ts";

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
    readonly id: string;
    readonly kind: "directory" | "file";
    readonly locator: WorkspaceFileLocator;
    readonly rootIndexKey?: string;
}

interface DirectoryPageSnapshot {
    readonly directory: ListWorkspaceFilesOutput["directory"];
    readonly entries: readonly ListWorkspaceFilesOutput["entries"][number][];
}

interface CursorRecord extends ExpiringActorRecord {
    readonly directoryId: string;
    readonly id: string;
    readonly limit: number;
    nextCursorId?: string;
    readonly offset: number;
    readonly snapshot: DirectoryPageSnapshot;
}

interface ContentTicketRecord extends ExpiringActorRecord {
    readonly locator: WorkspaceFileLocator;
    readonly ticket: WorkspaceFileContentTicket;
}

type UploadTicketState =
    | { readonly kind: "accepted"; readonly result: WorkspaceFileUploadAccepted }
    | { readonly kind: "prepared" }
    | { readonly kind: "receiving"; readonly spoolId: string }
    | { readonly kind: "reconciliation-required" };

interface UploadTicketRecord extends ExpiringActorRecord {
    readonly command: Omit<WorkspaceFileWriteCommand, "sha256" | "spoolId">;
    readonly id: string;
    state: UploadTicketState;
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
        node.sizeBytes === undefined
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
        node.sizeBytes === ticket.sizeBytes
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
        resourceId,
        revision: node.revision,
        ...(node.sizeBytes === undefined ? {} : { sizeBytes: node.sizeBytes }),
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

    function deleteResource(record: ResourceRecord): void {
        resources.delete(record.id);
        if (record.rootIndexKey !== undefined) {
            rootResourceIds.delete(record.rootIndexKey);
        }
    }

    function sweep(now: number): void {
        for (const record of resources.values()) {
            if (record.expiresAtMs <= now) deleteResource(record);
        }
        for (const [id, record] of cursors) {
            if (record.expiresAtMs <= now) cursors.delete(id);
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
        rootIndexKey?: string
    ): ResourceRecord {
        const record: ResourceRecord = {
            actorKey: key,
            expiresAtMs: now + workspaceFileLimits.referenceTtlMs,
            id: nextId(),
            kind,
            locator,
            ...(rootIndexKey === undefined ? {} : { rootIndexKey }),
        };
        resources.set(record.id, record);
        if (rootIndexKey !== undefined) rootResourceIds.set(rootIndexKey, record.id);
        return record;
    }

    function resolveResource(
        actor: WorkspaceFileActor,
        id: string,
        kind?: ResourceRecord["kind"]
    ): ResourceRecord {
        const key = actorKey(actor);
        const now = checkedNow();
        const record = resources.get(id);
        if (record === undefined || record.actorKey !== key) {
            throw new WorkspaceFileError("not-found");
        }
        if (record.expiresAtMs <= now) {
            deleteResource(record);
            throw new WorkspaceFileError("not-found");
        }
        if (kind !== undefined && record.kind !== kind) {
            throw new WorkspaceFileError("not-file");
        }
        sweep(now);
        return record;
    }

    function createSnapshot(
        key: string,
        directoryId: string,
        snapshot: WorkspaceFileDirectorySnapshot,
        now: number,
        limit: number
    ): DirectoryPageSnapshot {
        reserveCapacity(
            snapshot.entries.length + (snapshot.entries.length > limit ? 1 : 0),
            now
        );
        const entries = snapshot.entries.map((node) => {
            const resource = createResource(key, node.locator, node.kind, now);
            return entryOutput(node, resource.id);
        });
        return {
            directory: {
                displayPath: displayPath(snapshot.directory.locator),
                name: snapshot.directory.name,
                resourceId: directoryId,
                revision: snapshot.directory.revision,
                rootId: snapshot.directory.locator.rootId,
                writable: snapshot.directory.writable,
            },
            entries,
        };
    }

    function createCursor(
        key: string,
        directoryId: string,
        snapshot: DirectoryPageSnapshot,
        offset: number,
        limit: number,
        now: number
    ): CursorRecord {
        const record: CursorRecord = {
            actorKey: key,
            directoryId,
            expiresAtMs: now + workspaceFileLimits.referenceTtlMs,
            id: nextId(),
            limit,
            offset,
            snapshot,
        };
        cursors.set(record.id, record);
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
                nextCursor = createCursor(key, directoryId, snapshot, end, limit, now).id;
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
        const node = await dependencies.reader.describe(record.locator, signal);
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
        };
    }

    function createUploadTicket(
        key: string,
        now: number,
        command: Omit<WorkspaceFileWriteCommand, "sha256" | "spoolId" | "ticketId">
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
        });
        return v.parse(workspaceFileUploadTicketSchema, {
            expiresAtMs,
            ticketId,
            uploadUrl: `/api/files/uploads/${ticketId}`,
        });
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
            let receipt: Awaited<ReturnType<WorkspaceFileUploadSpool["receive"]>>;
            try {
                receipt = await dependencies.spool.receive({
                    body,
                    expectedBytes: record.command.sizeBytes,
                    signal,
                    spoolId,
                });
            } catch (error) {
                record.state = { kind: "prepared" };
                throw workspaceFileError(error);
            }
            try {
                const result = v.parse(
                    workspaceFileUploadAcceptedSchema,
                    await dependencies.scheduler.enqueue(
                        {
                            ...record.command,
                            sha256: receipt.sha256,
                            spoolId: receipt.spoolId,
                        },
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
                record.state = { kind: "reconciliation-required" };
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
                if (
                    cursor === undefined ||
                    cursor.actorKey !== key ||
                    cursor.expiresAtMs <= now
                ) {
                    cursors.delete(input.cursor);
                    throw new WorkspaceFileError("not-found");
                }
                if (
                    cursor.directoryId !== input.directoryId ||
                    cursor.limit !== input.limit
                ) {
                    throw new WorkspaceFileError("conflict");
                }
                sweep(now);
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
            let snapshot: WorkspaceFileDirectorySnapshot;
            try {
                snapshot = await dependencies.reader.list(resource.locator, signal);
            } catch (error) {
                throw workspaceFileError(error);
            }
            const prepared = createSnapshot(key, resource.id, snapshot, now, input.limit);
            return page(key, resource.id, prepared, 0, input.limit, now);
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
                        indexKey
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
            const resource = resolveResource(actor, input.resourceId, "file");
            let node: WorkspaceFileNode;
            try {
                node = await dependencies.reader.describe(resource.locator, signal);
            } catch (error) {
                throw workspaceFileError(error);
            }
            completeFileNode(node);
            if (node.sizeBytes > workspaceFileLimits.maximumDownloadBytes) {
                throw new WorkspaceFileError("too-large");
            }
            const now = checkedNow();
            reserveCapacity(1, now);
            const ticketId = nextId();
            const ticket = v.parse(workspaceFileContentTicketSchema, {
                disposition: input.disposition,
                expiresAtMs: now + workspaceFileLimits.contentTicketTtlMs,
                fileName: node.name,
                mimeType: node.mimeType,
                previewKind: node.previewKind,
                revision: node.revision,
                sizeBytes: node.sizeBytes,
                ticketId,
                url: `/api/files/content/${ticketId}`,
            });
            contentTickets.set(ticketId, {
                actorKey: actorKey(actor),
                expiresAtMs: ticket.expiresAtMs,
                locator: resource.locator,
                ticket,
            });
            return ticket;
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
            let node: WorkspaceFileNode;
            try {
                node = await dependencies.reader.describe(resource.locator, signal);
            } catch (error) {
                throw workspaceFileError(error);
            }
            completeFileNode(node);
            if (!node.writable) throw new WorkspaceFileError("access-denied");
            if (node.revision !== input.expectedRevision) {
                throw new WorkspaceFileError("conflict");
            }
            const now = checkedNow();
            return createUploadTicket(actorKey(actor), now, {
                expectedRevision: input.expectedRevision,
                fileName: node.name,
                locator: resource.locator,
                mimeType: input.mimeType,
                operation: "replace",
                sizeBytes: input.sizeBytes,
            });
        },
        async readContent(actor, ticketId, range, signal) {
            const record = resolveContentRecord(actor, ticketId);
            let result: WorkspaceFileReadResult;
            try {
                result = await dependencies.reader.read(
                    record.locator,
                    record.ticket.revision,
                    range,
                    signal
                );
            } catch (error) {
                throw workspaceFileError(error);
            }
            if (
                result.fileName !== record.ticket.fileName ||
                result.mimeType !== record.ticket.mimeType ||
                result.previewKind !== record.ticket.previewKind ||
                result.revision !== record.ticket.revision ||
                result.sizeBytes !== record.ticket.sizeBytes
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
            };
        },
    });
}
