import { afterEach, describe, expect, test } from "bun:test";
import Fs from "node:fs";
import Os from "node:os";
import Path from "node:path";

import { workspaceFileLimits } from "../../../contracts/files.ts";
import { CONFIG_REDACTION_SENTINEL } from "../../../shared/configRedaction.ts";
import { createDescriptorWorkspaceFileReader } from "../../platform/files/descriptorWorkspaceFileReader.ts";
import { createDescriptorWorkspaceFileUploadSpool } from "../../platform/files/descriptorWorkspaceFileUploadSpool.ts";
import { captureFailure } from "../../test/support/promise.ts";
import { WorkspaceFileError } from "./errors.ts";
import type {
    WorkspaceFileDirectorySnapshot,
    WorkspaceFileNode,
    WorkspaceFileReader,
    WorkspaceFileUploadSpool,
    WorkspaceFileWriteAuditContext,
    WorkspaceFileWriteCommand,
    WorkspaceFileWriteScheduler,
} from "./ports.ts";
import { createWorkspaceFilesService, type WorkspaceFilesService } from "./service.ts";

const actor = Object.freeze({ authenticatorId: "session-1", id: "user-1" });
const otherActor = Object.freeze({ authenticatorId: "session-2", id: "user-1" });
const temporaryDirectories: string[] = [];
const services: WorkspaceFilesService[] = [];

function uuid(index: number): string {
    return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function body(contents: string): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(contents));
            controller.close();
        },
    });
}

function chunkedBody(...contents: readonly string[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            for (const content of contents) {
                controller.enqueue(new TextEncoder().encode(content));
            }
            controller.close();
        },
    });
}

function splitSentinelBody(prefix = "", suffix = ""): ReadableStream<Uint8Array> {
    const firstBoundary = Math.floor(CONFIG_REDACTION_SENTINEL.length / 3);
    const secondBoundary = Math.floor((CONFIG_REDACTION_SENTINEL.length * 2) / 3);
    return chunkedBody(
        prefix + CONFIG_REDACTION_SENTINEL.slice(0, firstBoundary),
        CONFIG_REDACTION_SENTINEL.slice(firstBoundary, secondBoundary),
        CONFIG_REDACTION_SENTINEL.slice(secondBoundary) + suffix
    );
}

function fixture(
    options: {
        readonly discardFailures?: number;
        readonly enqueue?: WorkspaceFileWriteScheduler["enqueue"];
        readonly getStatus?: WorkspaceFileWriteScheduler["getStatus"];
        readonly includeOpenClaw?: boolean;
        readonly listActiveSpoolIds?: WorkspaceFileWriteScheduler["listActiveSpoolIds"];
        readonly maximumReferences?: number;
        readonly reader?: WorkspaceFileReader;
        readonly receive?: WorkspaceFileUploadSpool["receive"];
        readonly reconcileEnqueue?: WorkspaceFileWriteScheduler["reconcileEnqueue"];
    } = {}
) {
    const parent = Fs.mkdtempSync(Path.join(Os.tmpdir(), "mira-files-service-"));
    const root = Path.join(parent, "workspace");
    const openClawRoot = Path.join(parent, "openclaw");
    const spoolRoot = Path.join(parent, "spool");
    Fs.mkdirSync(root, { mode: 0o700 });
    if (options.includeOpenClaw === true) {
        Fs.mkdirSync(Path.join(openClawRoot, "hooks", "transforms"), {
            mode: 0o755,
            recursive: true,
        });
        // Recursive mkdir applies the requested mode to every created parent, and
        // the process umask differs between local development and GitHub Actions.
        // The descriptor reader intentionally requires the manifest root itself
        // to be private, so make that invariant explicit in the fixture.
        Fs.chmodSync(openClawRoot, 0o700);
        Fs.writeFileSync(
            Path.join(openClawRoot, "openclaw.json"),
            '{"gateway":{"token":"service-raw-secret","url":"ws://localhost"}}'
        );
        Fs.chmodSync(Path.join(openClawRoot, "openclaw.json"), 0o600);
        Fs.writeFileSync(
            Path.join(openClawRoot, "hooks", "transforms", "agentmail.ts"),
            "export {};\n"
        );
    }
    Fs.mkdirSync(spoolRoot, { mode: 0o700 });
    temporaryDirectories.push(parent);
    const calls: string[] = [];
    const commands: WorkspaceFileWriteCommand[] = [];
    const audits: WorkspaceFileWriteAuditContext[] = [];
    let now = 1_800_000_000_000;
    let nextId = 1;
    const scheduler: WorkspaceFileWriteScheduler = {
        async enqueue(command, audit, signal) {
            calls.push("enqueue");
            commands.push(command);
            audits.push(audit);
            if (options.enqueue !== undefined) {
                return options.enqueue(command, audit, signal);
            }
            return {
                acceptedAtMs: now,
                jobRunId: "job-1",
                ticketId: command.ticketId,
            };
        },
        async getStatus(ticketId, statusActor, signal) {
            calls.push("status");
            return options.getStatus?.(ticketId, statusActor, signal);
        },
        listActiveSpoolIds() {
            return (
                options.listActiveSpoolIds?.() ??
                Promise.resolve({ spoolIds: [], truncated: false })
            );
        },
        async reconcileEnqueue(command, statusActor, signal) {
            calls.push("reconcile");
            return (
                (await options.reconcileEnqueue?.(command, statusActor, signal)) ?? {
                    kind: "absent",
                }
            );
        },
    };
    const reader =
        options.reader ??
        createDescriptorWorkspaceFileReader({
            roots: [
                {
                    id: "workspace",
                    label: "Workspace",
                    path: root,
                    writable: true,
                },
                ...(options.includeOpenClaw === true
                    ? [
                          {
                              id: "openclaw-config",
                              label: "OpenClaw Config",
                              manifest: [
                                  {
                                      contentPolicy: "redacted-config-json" as const,
                                      maximumSizeBytes:
                                          workspaceFileLimits.maximumManifestFileBytes,
                                      segments: ["openclaw.json"],
                                      uploadContentPolicy:
                                          "reject-redaction-sentinel" as const,
                                      writable: true,
                                  },
                                  {
                                      contentPolicy: "raw" as const,
                                      maximumSizeBytes:
                                          workspaceFileLimits.maximumManifestFileBytes,
                                      segments: ["hooks", "transforms", "agentmail.ts"],
                                      uploadContentPolicy:
                                          "reject-redaction-sentinel" as const,
                                      writable: true,
                                  },
                              ],
                              path: openClawRoot,
                              writable: false,
                          },
                      ]
                    : []),
            ],
        });
    const descriptorSpool = createDescriptorWorkspaceFileUploadSpool(spoolRoot, {
        nowMs: () => now,
    });
    let discardFailures = options.discardFailures ?? 0;
    const spool = {
        ...descriptorSpool,
        discard(spoolId: string) {
            calls.push("discard");
            if (discardFailures > 0) {
                discardFailures -= 1;
                return Promise.reject(new Error("discard unavailable"));
            }
            return descriptorSpool.discard(spoolId);
        },
        receive(input: Parameters<WorkspaceFileUploadSpool["receive"]>[0]) {
            return options.receive?.(input) ?? descriptorSpool.receive(input);
        },
    };
    const service = createWorkspaceFilesService({
        generateId: () => uuid(nextId++),
        maximumReferences: options.maximumReferences,
        nowMs: () => now,
        reader,
        scheduler,
        spool,
    });
    services.push(service);
    return {
        audits,
        calls,
        commands,
        openClawRoot,
        root,
        service,
        setNow: (value: number) => {
            now = value;
        },
        spoolRoot,
    };
}

function largeDirectoryReader(entryCount: number): WorkspaceFileReader {
    const directory = Object.freeze<WorkspaceFileNode>({
        kind: "directory",
        locator: { rootId: "workspace", segments: [] },
        name: "Workspace",
        revision: "0".repeat(64),
        writable: true,
    });
    const entries = Object.freeze(
        Array.from({ length: entryCount }, (_, index) => {
            const name = `file-${String(index).padStart(4, "0")}.txt`;
            return Object.freeze<WorkspaceFileNode>({
                kind: "file",
                locator: { rootId: "workspace", segments: [name] },
                mimeType: "text/plain",
                name,
                previewKind: "text",
                revision: String(index + 1)
                    .padStart(64, "0")
                    .slice(-64),
                sizeBytes: 1,
                writable: true,
            });
        })
    );
    const reader: WorkspaceFileReader = {
        describe(locator) {
            const node =
                locator.segments.length === 0
                    ? directory
                    : entries.find((entry) => entry.name === locator.segments.at(-1));
            if (node === undefined) throw new WorkspaceFileError("not-found");
            return Promise.resolve(node);
        },
        dispose() {},
        list() {
            return Promise.resolve({
                directory: { ...directory, kind: "directory" as const },
                entries,
            });
        },
        read() {
            return Promise.reject(new WorkspaceFileError("not-found"));
        },
        resolveReference() {
            return Promise.resolve(undefined);
        },
        roots() {
            return [{ id: "workspace", label: "Workspace", writable: true }];
        },
    };
    return Object.freeze(reader);
}

function directorySnapshot(
    prefix: string,
    revision: string
): WorkspaceFileDirectorySnapshot {
    return {
        directory: {
            kind: "directory",
            locator: { rootId: "workspace", segments: [] },
            name: "Workspace",
            revision,
            writable: true,
        },
        entries: [1, 2].map((index) => ({
            kind: "file" as const,
            locator: {
                rootId: "workspace",
                segments: [`${prefix}-${index}.txt`],
            },
            mimeType: "text/plain",
            name: `${prefix}-${index}.txt`,
            previewKind: "text" as const,
            revision: String(index).repeat(64),
            sizeBytes: 1,
            writable: true,
        })),
    };
}

afterEach(async () => {
    await Promise.allSettled(services.splice(0).map((service) => service.dispose()));
    for (const directory of temporaryDirectories.splice(0)) {
        Fs.rmSync(directory, { force: true, recursive: true });
    }
});

describe("workspace files service", () => {
    test("issues a preview ticket only for a reviewed-root reference", async () => {
        const { root, service } = fixture();
        const file = Path.join(root, "guide.md");
        Fs.writeFileSync(file, "# Guide\n");

        const ticket = await service.prepareReference(actor, { reference: file });
        expect(ticket).toMatchObject({
            disposition: "preview",
            fileName: "guide.md",
            previewKind: "text",
        });
        expect(
            service.prepareReference(actor, { reference: "/etc/passwd" })
        ).rejects.toMatchObject({ reason: "not-found" });
        expect(
            service.readContent(otherActor, ticket.ticketId, undefined)
        ).rejects.toMatchObject({ reason: "not-found" });
    });

    test("releases an absolute-reference resource when ticket creation fails", async () => {
        const { root, service } = fixture({ maximumReferences: 16 });
        const file = Path.join(root, "oversized.txt");
        Fs.writeFileSync(file, "");
        Fs.truncateSync(file, workspaceFileLimits.maximumDownloadBytes + 1);

        for (let attempt = 0; attempt < 20; attempt += 1) {
            expect(
                await captureFailure(() =>
                    service.prepareReference(actor, { reference: file })
                )
            ).toMatchObject({ reason: "too-large" });
        }
    });

    test("issues actor-bound root and stable bounded page references", async () => {
        const { root, service } = fixture();
        Fs.mkdirSync(Path.join(root, "docs"));
        Fs.writeFileSync(Path.join(root, "a.txt"), "a");
        Fs.writeFileSync(Path.join(root, "b.txt"), "b");

        const roots = await service.listRoots(actor);
        expect(roots.roots).toEqual([
            expect.objectContaining({ id: "workspace", writable: true }),
        ]);
        const directoryId = roots.roots[0]!.resourceId;
        const first = await service.list(actor, { directoryId, limit: 1 });
        expect(first.entries).toHaveLength(1);
        expect(first.entries[0]).toMatchObject({ kind: "directory", name: "docs" });
        expect(first.nextCursor).toBeDefined();

        const second = await service.list(actor, {
            cursor: first.nextCursor,
            directoryId,
            limit: 1,
        });
        const replay = await service.list(actor, {
            cursor: first.nextCursor,
            directoryId,
            limit: 1,
        });
        expect(replay).toEqual(second);
        expect(second.entries[0]?.name).toBe("a.txt");
        expect(second.nextCursor).toBeDefined();

        expect(
            await captureFailure(() =>
                service.list(otherActor, { directoryId, limit: 1 })
            )
        ).toMatchObject({ reason: "not-found" });
        expect(
            await captureFailure(() =>
                service.list(actor, {
                    cursor: first.nextCursor,
                    directoryId,
                    limit: 2,
                })
            )
        ).toMatchObject({ reason: "conflict" });
    });

    test("does not let another actor invalidate the owner's cursor", async () => {
        const { root, service } = fixture();
        Fs.writeFileSync(Path.join(root, "a.txt"), "a");
        Fs.writeFileSync(Path.join(root, "b.txt"), "b");
        const roots = await service.listRoots(actor);
        const directoryId = roots.roots[0]!.resourceId;
        const first = await service.list(actor, { directoryId, limit: 1 });

        expect(
            await captureFailure(() =>
                service.list(otherActor, {
                    cursor: first.nextCursor,
                    directoryId,
                    limit: 1,
                })
            )
        ).toMatchObject({ reason: "not-found" });

        const second = await service.list(actor, {
            cursor: first.nextCursor,
            directoryId,
            limit: 1,
        });
        expect(second.entries[0]?.name).toBe("b.txt");
    });

    test("replaces a near-capacity directory snapshot when its first page refreshes", async () => {
        const { service } = fixture({
            reader: largeDirectoryReader(workspaceFileLimits.maximumDirectoryEntries - 1),
        });
        const roots = await service.listRoots(actor);
        const directoryId = roots.roots[0]!.resourceId;
        const first = await service.list(actor, {
            directoryId,
            limit: workspaceFileLimits.listPageMaximum,
        });
        const firstEntryId = first.entries[0]!.resourceId;
        const contentTicket = await service.prepareContent(actor, {
            disposition: "preview",
            resourceId: firstEntryId,
        });
        expect(first.entries).toHaveLength(workspaceFileLimits.listPageMaximum);
        expect(first.nextCursor).toBeDefined();

        const refreshed = await service.list(actor, {
            directoryId,
            limit: workspaceFileLimits.listPageMaximum,
        });
        expect(refreshed.entries).toHaveLength(workspaceFileLimits.listPageMaximum);
        expect(refreshed.entries[0]!.resourceId).not.toBe(firstEntryId);
        expect(refreshed.nextCursor).toBeDefined();
        expect(await service.inspectContent(actor, contentTicket.ticketId)).toMatchObject(
            {
                fileName: first.entries[0]!.name,
                revision: first.entries[0]!.revision,
            }
        );

        expect(
            await captureFailure(() =>
                service.list(actor, {
                    cursor: first.nextCursor,
                    directoryId,
                    limit: workspaceFileLimits.listPageMaximum,
                })
            )
        ).toMatchObject({ reason: "not-found" });
        expect(
            await captureFailure(() =>
                service.prepareContent(actor, {
                    disposition: "preview",
                    resourceId: firstEntryId,
                })
            )
        ).toMatchObject({ reason: "not-found" });

        const next = await service.list(actor, {
            cursor: refreshed.nextCursor,
            directoryId,
            limit: workspaceFileLimits.listPageMaximum,
        });
        expect(next.entries).toHaveLength(workspaceFileLimits.listPageMaximum);
    });

    test("cascades parent replacement through a materialized child snapshot", async () => {
        const rootDirectory: WorkspaceFileNode & { readonly kind: "directory" } = {
            kind: "directory",
            locator: { rootId: "workspace", segments: [] },
            name: "Workspace",
            revision: "0".repeat(64),
            writable: true,
        };
        const childDirectory: WorkspaceFileNode & { readonly kind: "directory" } = {
            kind: "directory",
            locator: { rootId: "workspace", segments: ["child"] },
            name: "child",
            revision: "1".repeat(64),
            writable: true,
        };
        const childEntries = Array.from(
            { length: workspaceFileLimits.maximumDirectoryEntries },
            (_, index) => {
                const name = `file-${String(index).padStart(4, "0")}.txt`;
                return {
                    kind: "file" as const,
                    locator: {
                        rootId: "workspace",
                        segments: ["child", name],
                    },
                    mimeType: "text/plain",
                    name,
                    previewKind: "text" as const,
                    revision: (index % 16).toString(16).repeat(64),
                    sizeBytes: 1,
                    writable: true,
                };
            }
        );
        const rootEntries = childEntries.map((entry) => ({
            ...entry,
            locator: {
                rootId: "workspace",
                segments: [entry.name],
            },
        }));
        let rootReads = 0;
        const reader: WorkspaceFileReader = {
            describe(locator) {
                if (locator.segments.length === 0) return Promise.resolve(rootDirectory);
                if (locator.segments.length === 1) {
                    return Promise.resolve(childDirectory);
                }
                const node = childEntries.find(
                    (entry) => entry.name === locator.segments.at(-1)
                );
                if (node === undefined) throw new WorkspaceFileError("not-found");
                return Promise.resolve(node);
            },
            dispose() {},
            list(locator) {
                if (locator.segments.length > 0) {
                    return Promise.resolve({
                        directory: childDirectory,
                        entries: childEntries,
                    });
                }
                rootReads += 1;
                return Promise.resolve({
                    directory: rootDirectory,
                    entries: rootReads === 2 ? rootEntries : [childDirectory],
                });
            },
            read() {
                return Promise.reject(new WorkspaceFileError("not-found"));
            },
            roots() {
                return [{ id: "workspace", label: "Workspace", writable: true }];
            },
        };
        const { service } = fixture({ reader });
        const roots = await service.listRoots(actor);
        const directoryId = roots.roots[0]!.resourceId;
        const firstRoot = await service.list(actor, { directoryId, limit: 1 });
        const firstChild = await service.list(actor, {
            directoryId: firstRoot.entries[0]!.resourceId,
            limit: workspaceFileLimits.listPageMaximum,
        });
        const secondRoot = await service.list(actor, { directoryId, limit: 1 });
        expect(secondRoot.entries[0]?.name).toBe("file-0000.txt");
        expect(secondRoot.nextCursor).toBeDefined();

        expect(
            await captureFailure(() =>
                service.list(actor, {
                    cursor: firstChild.nextCursor,
                    directoryId: firstRoot.entries[0]!.resourceId,
                    limit: workspaceFileLimits.listPageMaximum,
                })
            )
        ).toMatchObject({ reason: "not-found" });

        const thirdRoot = await service.list(actor, { directoryId, limit: 1 });
        const secondChild = await service.list(actor, {
            directoryId: thirdRoot.entries[0]!.resourceId,
            limit: workspaceFileLimits.listPageMaximum,
        });
        expect(secondChild.entries).toHaveLength(workspaceFileLimits.listPageMaximum);
        expect(secondChild.nextCursor).toBeDefined();
    });

    test("expires every cursor with its snapshot resources", async () => {
        const { root, service, setNow } = fixture();
        Fs.writeFileSync(Path.join(root, "a.txt"), "a");
        Fs.writeFileSync(Path.join(root, "b.txt"), "b");
        Fs.writeFileSync(Path.join(root, "c.txt"), "c");
        const initialNow = 1_800_000_000_000;
        const roots = await service.listRoots(actor);
        const directoryId = roots.roots[0]!.resourceId;
        setNow(initialNow + workspaceFileLimits.referenceTtlMs - 2);
        const first = await service.list(actor, { directoryId, limit: 1 });

        setNow(initialNow + workspaceFileLimits.referenceTtlMs - 1);
        const second = await service.list(actor, {
            cursor: first.nextCursor,
            directoryId,
            limit: 1,
        });
        const contentTicket = await service.prepareContent(actor, {
            disposition: "preview",
            resourceId: second.entries[0]!.resourceId,
        });

        setNow(initialNow + workspaceFileLimits.referenceTtlMs);
        expect(
            await captureFailure(() =>
                service.list(actor, {
                    cursor: second.nextCursor,
                    directoryId,
                    limit: 1,
                })
            )
        ).toMatchObject({ reason: "not-found" });
        expect(await service.inspectContent(actor, contentTicket.ticketId)).toMatchObject(
            { fileName: "b.txt" }
        );
    });

    test("keeps a newer concurrent refresh when an older read completes last", async () => {
        const firstRead = Promise.withResolvers<WorkspaceFileDirectorySnapshot>();
        const secondRead = Promise.withResolvers<WorkspaceFileDirectorySnapshot>();
        const olderSnapshot = directorySnapshot("older", "a".repeat(64));
        const newerSnapshot = directorySnapshot("newer", "b".repeat(64));
        const nodes = new Map(
            [...olderSnapshot.entries, ...newerSnapshot.entries].map((node) => [
                node.name,
                node,
            ])
        );
        let listCalls = 0;
        const reader: WorkspaceFileReader = {
            describe(locator) {
                const node =
                    locator.segments.length === 0
                        ? newerSnapshot.directory
                        : nodes.get(locator.segments.at(-1)!);
                if (node === undefined) throw new WorkspaceFileError("not-found");
                return Promise.resolve(node);
            },
            dispose() {},
            list() {
                listCalls += 1;
                if (listCalls === 1) return firstRead.promise;
                if (listCalls === 2) return secondRead.promise;
                return Promise.reject(new Error("Unexpected directory read"));
            },
            read() {
                return Promise.reject(new WorkspaceFileError("not-found"));
            },
            roots() {
                return [{ id: "workspace", label: "Workspace", writable: true }];
            },
        };
        const { service } = fixture({ reader });
        const roots = await service.listRoots(actor);
        const directoryId = roots.roots[0]!.resourceId;
        const older = service.list(actor, { directoryId, limit: 1 });
        const newer = service.list(actor, { directoryId, limit: 1 });
        expect(listCalls).toBe(2);

        secondRead.resolve(newerSnapshot);
        const newerPage = await newer;
        firstRead.resolve(olderSnapshot);

        expect(await captureFailure(() => older)).toMatchObject({
            reason: "conflict",
        });
        expect(newerPage.entries[0]?.name).toBe("newer-1.txt");
        const ticket = await service.prepareContent(actor, {
            disposition: "preview",
            resourceId: newerPage.entries[0]!.resourceId,
        });
        expect(ticket.fileName).toBe("newer-1.txt");
        const next = await service.list(actor, {
            cursor: newerPage.nextCursor,
            directoryId,
            limit: 1,
        });
        expect(next.entries[0]?.name).toBe("newer-2.txt");
    });

    test("does not publish an aborted directory refresh", async () => {
        const pendingRefresh = Promise.withResolvers<WorkspaceFileDirectorySnapshot>();
        const olderSnapshot = directorySnapshot("older", "a".repeat(64));
        const newerSnapshot = directorySnapshot("newer", "b".repeat(64));
        let listCalls = 0;
        const reader: WorkspaceFileReader = {
            describe(locator) {
                const node = [...olderSnapshot.entries, ...newerSnapshot.entries].find(
                    (entry) => entry.name === locator.segments.at(-1)
                );
                return Promise.resolve(node ?? olderSnapshot.directory);
            },
            dispose() {},
            list() {
                listCalls += 1;
                return listCalls === 1
                    ? Promise.resolve(olderSnapshot)
                    : pendingRefresh.promise;
            },
            read() {
                return Promise.reject(new WorkspaceFileError("not-found"));
            },
            roots() {
                return [{ id: "workspace", label: "Workspace", writable: true }];
            },
        };
        const { service } = fixture({ reader });
        const roots = await service.listRoots(actor);
        const directoryId = roots.roots[0]!.resourceId;
        const first = await service.list(actor, { directoryId, limit: 1 });
        const controller = new AbortController();
        const refresh = service.list(actor, { directoryId, limit: 1 }, controller.signal);
        const abortReason = new Error("Directory refresh cancelled");

        pendingRefresh.resolve(newerSnapshot);
        controller.abort(abortReason);

        expect(await captureFailure(() => refresh)).toBe(abortReason);
        const second = await service.list(actor, {
            cursor: first.nextCursor,
            directoryId,
            limit: 1,
        });
        expect(second.entries[0]?.name).toBe("older-2.txt");
    });

    test("rejects a refresh whose directory authority expires while reading", async () => {
        const pendingRefresh = Promise.withResolvers<WorkspaceFileDirectorySnapshot>();
        const snapshot = directorySnapshot("entry", "a".repeat(64));
        const { service, setNow } = fixture({
            reader: {
                describe() {
                    return Promise.resolve(snapshot.directory);
                },
                dispose() {},
                list() {
                    return pendingRefresh.promise;
                },
                read() {
                    return Promise.reject(new WorkspaceFileError("not-found"));
                },
                roots() {
                    return [{ id: "workspace", label: "Workspace", writable: true }];
                },
            },
        });
        const initialNow = 1_800_000_000_000;
        const roots = await service.listRoots(actor);
        const directoryId = roots.roots[0]!.resourceId;
        const refresh = service.list(actor, { directoryId, limit: 1 });

        setNow(initialNow + workspaceFileLimits.referenceTtlMs);
        pendingRefresh.resolve(snapshot);

        expect(await captureFailure(() => refresh)).toMatchObject({
            reason: "not-found",
        });
        const refreshedRoots = await service.listRoots(actor);
        expect(refreshedRoots.roots[0]!.resourceId).not.toBe(directoryId);
    });

    test("rejects a child refresh revoked by a newer parent snapshot", async () => {
        const childRefresh = Promise.withResolvers<WorkspaceFileDirectorySnapshot>();
        const rootSnapshot = directorySnapshot("unused", "0".repeat(64));
        const childDirectory: WorkspaceFileNode & { readonly kind: "directory" } = {
            kind: "directory",
            locator: { rootId: "workspace", segments: ["child"] },
            name: "child",
            revision: "1".repeat(64),
            writable: true,
        };
        let rootReads = 0;
        const reader: WorkspaceFileReader = {
            describe(locator) {
                return Promise.resolve(
                    locator.segments.length === 0
                        ? rootSnapshot.directory
                        : childDirectory
                );
            },
            dispose() {},
            list(locator) {
                if (locator.segments.length > 0) return childRefresh.promise;
                rootReads += 1;
                return Promise.resolve({
                    directory: rootSnapshot.directory,
                    entries: rootReads === 1 ? [childDirectory] : [],
                });
            },
            read() {
                return Promise.reject(new WorkspaceFileError("not-found"));
            },
            roots() {
                return [{ id: "workspace", label: "Workspace", writable: true }];
            },
        };
        const { service } = fixture({ reader });
        const roots = await service.listRoots(actor);
        const directoryId = roots.roots[0]!.resourceId;
        const parent = await service.list(actor, { directoryId, limit: 1 });
        const childDirectoryId = parent.entries[0]!.resourceId;
        const inFlightChild = service.list(actor, {
            directoryId: childDirectoryId,
            limit: 1,
        });

        await service.list(actor, { directoryId, limit: 1 });
        childRefresh.resolve({
            directory: childDirectory,
            entries: rootSnapshot.entries,
        });

        expect(await captureFailure(() => inFlightChild)).toMatchObject({
            reason: "conflict",
        });
        expect(
            await captureFailure(() =>
                service.list(actor, { directoryId: childDirectoryId, limit: 1 })
            )
        ).toMatchObject({ reason: "not-found" });
    });

    test("binds content tickets to actor, revision, disposition, and expiry", async () => {
        const { root, service, setNow } = fixture();
        Fs.writeFileSync(Path.join(root, "notes.md"), "abcdef");
        const roots = await service.listRoots(actor);
        const page = await service.list(actor, {
            directoryId: roots.roots[0]!.resourceId,
            limit: 10,
        });
        const file = page.entries[0]!;
        const ticket = await service.prepareContent(actor, {
            disposition: "preview",
            resourceId: file.resourceId,
        });
        expect(ticket).toMatchObject({
            disposition: "preview",
            fileName: "notes.md",
            mimeType: "text/markdown",
            sizeBytes: 6,
        });
        const content = await service.readContent(actor, ticket.ticketId, {
            endExclusive: 5,
            start: 2,
        });
        expect(new TextDecoder().decode(content.bytes)).toBe("cde");
        expect(
            await captureFailure(() =>
                service.inspectContent(otherActor, ticket.ticketId)
            )
        ).toMatchObject({ reason: "not-found" });

        Fs.writeFileSync(Path.join(root, "notes.md"), "changed");
        expect(
            await captureFailure(() => service.inspectContent(actor, ticket.ticketId))
        ).toMatchObject({ reason: "conflict" });

        setNow(ticket.expiresAtMs);
        expect(
            await captureFailure(() => service.inspectContent(actor, ticket.ticketId))
        ).toMatchObject({ reason: "expired" });
    });

    test("requires explicit reveal for config edits and allows only reviewed hook replacement", async () => {
        const { openClawRoot, service } = fixture({ includeOpenClaw: true });
        Fs.writeFileSync(
            Path.join(openClawRoot, "openclaw.json.bak"),
            '{"gateway":{"token":"previous-secret"}}',
            { mode: 0o600 }
        );
        const roots = await service.listRoots(actor);
        expect(
            roots.roots.map(({ id, label, writable }) => ({ id, label, writable }))
        ).toEqual([
            { id: "workspace", label: "Workspace", writable: true },
            {
                id: "openclaw-config",
                label: "OpenClaw Config",
                writable: false,
            },
        ]);
        const openClaw = roots.roots.find(({ id }) => id === "openclaw-config")!;
        const listing = await service.list(actor, {
            directoryId: openClaw.resourceId,
            limit: 10,
        });
        expect(listing.entries.some(({ name }) => name.endsWith(".bak"))).toBe(false);
        expect(JSON.stringify(listing)).not.toContain("previous-secret");
        const config = listing.entries.find(({ name }) => name === "openclaw.json")!;
        expect(config).toMatchObject({
            requiresSecretReveal: true,
            writable: true,
        });
        const ticket = await service.prepareContent(actor, {
            disposition: "preview",
            resourceId: config.resourceId,
        });
        expect(JSON.stringify(ticket)).not.toContain("service-raw-secret");
        const content = await service.readContent(actor, ticket.ticketId, undefined);
        expect(new TextDecoder().decode(content.bytes)).toContain(
            "__MIRA_DASHBOARD_REDACTED__"
        );
        expect(new TextDecoder().decode(content.bytes)).not.toContain(
            "service-raw-secret"
        );
        expect(
            await captureFailure(() =>
                service.prepareWrite(actor, {
                    expectedRevision: config.revision,
                    mimeType: "application/json",
                    resourceId: config.resourceId,
                    sizeBytes: 2,
                })
            )
        ).toMatchObject({ reason: "access-denied" });
        const revealed = await service.prepareReveal(actor, {
            resourceId: config.resourceId,
        });
        const raw = await service.readContent(actor, revealed.ticketId, undefined);
        expect(new TextDecoder().decode(raw.bytes)).toContain("service-raw-secret");
        expect(
            await service.prepareWrite(actor, {
                expectedRevision: config.revision,
                mimeType: "application/json",
                revealTicketId: revealed.ticketId,
                resourceId: config.resourceId,
                sizeBytes: workspaceFileLimits.maximumManifestFileBytes,
            })
        ).toMatchObject({ uploadUrl: expect.stringContaining("/api/files/uploads/") });
        expect(
            await captureFailure(() =>
                service.prepareWrite(actor, {
                    expectedRevision: config.revision,
                    mimeType: "application/json",
                    revealTicketId: revealed.ticketId,
                    resourceId: config.resourceId,
                    sizeBytes: workspaceFileLimits.maximumManifestFileBytes + 1,
                })
            )
        ).toMatchObject({ reason: "too-large" });

        const hooks = listing.entries.find(({ name }) => name === "hooks")!;
        const hooksListing = await service.list(actor, {
            directoryId: hooks.resourceId,
            limit: 10,
        });
        const transforms = hooksListing.entries.find(
            ({ name }) => name === "transforms"
        )!;
        const transformsListing = await service.list(actor, {
            directoryId: transforms.resourceId,
            limit: 10,
        });
        const agentmail = transformsListing.entries.find(
            ({ name }) => name === "agentmail.ts"
        )!;
        expect(agentmail).toMatchObject({ writable: true });
        expect(
            await service.prepareWrite(actor, {
                expectedRevision: agentmail.revision,
                mimeType: "text/plain",
                resourceId: agentmail.resourceId,
                sizeBytes: workspaceFileLimits.maximumManifestFileBytes,
            })
        ).toMatchObject({ uploadUrl: expect.stringContaining("/api/files/uploads/") });
        expect(
            await captureFailure(() =>
                service.prepareWrite(actor, {
                    expectedRevision: agentmail.revision,
                    mimeType: "text/plain",
                    resourceId: agentmail.resourceId,
                    sizeBytes: workspaceFileLimits.maximumManifestFileBytes + 1,
                })
            )
        ).toMatchObject({ reason: "too-large" });
        expect(
            await captureFailure(() =>
                service.prepareUpload(actor, {
                    directoryId: openClaw.resourceId,
                    fileName: "new.json",
                    mimeType: "application/json",
                    sizeBytes: 2,
                })
            )
        ).toMatchObject({ reason: "access-denied" });
    });

    test("publishes oversized reviewed sources as read-only bounded prefixes", async () => {
        const { openClawRoot, service } = fixture({ includeOpenClaw: true });
        const sourceSizeBytes = workspaceFileLimits.maximumManifestFileBytes + 1;
        const configSecret = "service-oversized-secret";
        Fs.writeFileSync(
            Path.join(openClawRoot, "openclaw.json"),
            `${configSecret}${"a".repeat(sourceSizeBytes - configSecret.length)}`
        );
        Fs.chmodSync(Path.join(openClawRoot, "openclaw.json"), 0o600);
        Fs.writeFileSync(
            Path.join(openClawRoot, "hooks", "transforms", "agentmail.ts"),
            Buffer.alloc(sourceSizeBytes, 0x62)
        );

        const roots = await service.listRoots(actor);
        const openClaw = roots.roots.find(({ id }) => id === "openclaw-config")!;
        const rootListing = await service.list(actor, {
            directoryId: openClaw.resourceId,
            limit: 10,
        });
        const config = rootListing.entries.find(({ name }) => name === "openclaw.json")!;
        expect(config).toMatchObject({
            requiresSecretReveal: true,
            sizeBytes: sourceSizeBytes,
            truncated: true,
            writable: false,
        });
        expect(
            await captureFailure(() =>
                service.prepareContent(actor, {
                    disposition: "preview",
                    resourceId: config.resourceId,
                })
            )
        ).toMatchObject({ reason: "too-large" });

        const revealed = await service.prepareReveal(actor, {
            resourceId: config.resourceId,
        });
        expect(revealed).toMatchObject({
            previewKind: "text",
            sizeBytes: workspaceFileLimits.maximumTextPreviewBytes,
            sourceSizeBytes,
            truncated: true,
        });
        const rawPrefix = await service.readContent(actor, revealed.ticketId, undefined);
        expect(rawPrefix.bytes).toHaveLength(workspaceFileLimits.maximumTextPreviewBytes);
        expect(new TextDecoder().decode(rawPrefix.bytes)).toStartWith(configSecret);
        expect(
            await captureFailure(() =>
                service.prepareWrite(actor, {
                    expectedRevision: config.revision,
                    mimeType: "application/json",
                    revealTicketId: revealed.ticketId,
                    resourceId: config.resourceId,
                    sizeBytes: 2,
                })
            )
        ).toMatchObject({ reason: "access-denied" });

        const hooks = rootListing.entries.find(({ name }) => name === "hooks")!;
        const hooksListing = await service.list(actor, {
            directoryId: hooks.resourceId,
            limit: 10,
        });
        const transforms = hooksListing.entries.find(
            ({ name }) => name === "transforms"
        )!;
        const transformsListing = await service.list(actor, {
            directoryId: transforms.resourceId,
            limit: 10,
        });
        const agentmail = transformsListing.entries.find(
            ({ name }) => name === "agentmail.ts"
        )!;
        expect(agentmail).toMatchObject({
            previewKind: "download-only",
            sizeBytes: sourceSizeBytes,
            truncated: true,
            writable: false,
        });
        const ticket = await service.prepareContent(actor, {
            disposition: "preview",
            resourceId: agentmail.resourceId,
        });
        expect(ticket).toMatchObject({
            previewKind: "text",
            sizeBytes: workspaceFileLimits.maximumTextPreviewBytes,
            sourceSizeBytes,
            truncated: true,
        });
        const prefix = await service.readContent(actor, ticket.ticketId, undefined);
        expect(prefix.bytes).toHaveLength(workspaceFileLimits.maximumTextPreviewBytes);
        expect(prefix.bytes.every((byte) => byte === 0x62)).toBe(true);
    });

    test("repairs invalid config JSON only through the actor-bound reveal revision", async () => {
        const { commands, openClawRoot, service } = fixture({
            includeOpenClaw: true,
        });
        const invalidConfig = '{"gateway":{"token":"repair-secret"';
        Fs.writeFileSync(Path.join(openClawRoot, "openclaw.json"), invalidConfig);
        Fs.chmodSync(Path.join(openClawRoot, "openclaw.json"), 0o600);
        const roots = await service.listRoots(actor);
        const openClaw = roots.roots.find(({ id }) => id === "openclaw-config")!;
        const listing = await service.list(actor, {
            directoryId: openClaw.resourceId,
            limit: 10,
        });
        const config = listing.entries.find(({ name }) => name === "openclaw.json")!;

        expect(
            await captureFailure(() =>
                service.prepareContent(actor, {
                    disposition: "preview",
                    resourceId: config.resourceId,
                })
            )
        ).toMatchObject({ reason: "unavailable" });
        expect(
            await captureFailure(() =>
                service.prepareWrite(actor, {
                    expectedRevision: config.revision,
                    mimeType: "application/json",
                    resourceId: config.resourceId,
                    sizeBytes: 2,
                })
            )
        ).toMatchObject({ reason: "unavailable" });

        const reveal = await service.prepareReveal(actor, {
            resourceId: config.resourceId,
        });
        const raw = await service.readContent(actor, reveal.ticketId, undefined);
        expect(new TextDecoder().decode(raw.bytes)).toBe(invalidConfig);

        const otherRoots = await service.listRoots(otherActor);
        const otherOpenClaw = otherRoots.roots.find(
            ({ id }) => id === "openclaw-config"
        )!;
        const otherListing = await service.list(otherActor, {
            directoryId: otherOpenClaw.resourceId,
            limit: 10,
        });
        const otherConfig = otherListing.entries.find(
            ({ name }) => name === "openclaw.json"
        )!;
        expect(
            await captureFailure(() =>
                service.prepareWrite(otherActor, {
                    expectedRevision: otherConfig.revision,
                    mimeType: "application/json",
                    revealTicketId: reveal.ticketId,
                    resourceId: otherConfig.resourceId,
                    sizeBytes: 2,
                })
            )
        ).toMatchObject({ reason: "not-found" });

        const repaired = '{"gateway":{"token":"repaired"}}';
        const upload = await service.prepareWrite(actor, {
            expectedRevision: config.revision,
            mimeType: "application/json",
            revealTicketId: reveal.ticketId,
            resourceId: config.resourceId,
            sizeBytes: Buffer.byteLength(repaired),
        });
        await service.acceptUpload(
            actor,
            upload.ticketId,
            body(repaired),
            "request-invalid-config-repair"
        );

        expect(commands).toHaveLength(1);
        expect(commands[0]).toMatchObject({
            expectedRevision: config.revision,
            fileName: "openclaw.json",
            locator: {
                rootId: "openclaw-config",
                segments: ["openclaw.json"],
            },
            operation: "replace",
            sizeBytes: Buffer.byteLength(repaired),
        });
        expect(JSON.stringify({ commands, upload })).not.toContain("repair-secret");
    });

    test("rejects split redaction sentinels only for reviewed manifest replacements", async () => {
        const { calls, commands, root, service, spoolRoot } = fixture({
            includeOpenClaw: true,
        });
        Fs.writeFileSync(Path.join(root, "openclaw.json"), "{}");
        const roots = await service.listRoots(actor);
        const openClaw = roots.roots.find(({ id }) => id === "openclaw-config")!;
        const openClawListing = await service.list(actor, {
            directoryId: openClaw.resourceId,
            limit: 10,
        });
        const config = openClawListing.entries.find(
            ({ name }) => name === "openclaw.json"
        )!;
        const reveal = await service.prepareReveal(actor, {
            resourceId: config.resourceId,
        });
        const configUpload = `{"token":"${CONFIG_REDACTION_SENTINEL}"}`;
        const configTicket = await service.prepareWrite(actor, {
            expectedRevision: config.revision,
            mimeType: "application/json",
            revealTicketId: reveal.ticketId,
            resourceId: config.resourceId,
            sizeBytes: Buffer.byteLength(configUpload),
        });
        expect(
            await captureFailure(() =>
                service.acceptUpload(
                    actor,
                    configTicket.ticketId,
                    splitSentinelBody('{"token":"', '"}'),
                    "request-config-sentinel"
                )
            )
        ).toMatchObject({ reason: "invalid-input" });
        expect(Fs.readdirSync(spoolRoot)).toHaveLength(0);
        expect(calls).not.toContain("enqueue");

        const hooks = openClawListing.entries.find(({ name }) => name === "hooks")!;
        const hooksListing = await service.list(actor, {
            directoryId: hooks.resourceId,
            limit: 10,
        });
        const transforms = hooksListing.entries.find(
            ({ name }) => name === "transforms"
        )!;
        const transformsListing = await service.list(actor, {
            directoryId: transforms.resourceId,
            limit: 10,
        });
        const agentmail = transformsListing.entries.find(
            ({ name }) => name === "agentmail.ts"
        )!;
        const hookUpload = `export default "${CONFIG_REDACTION_SENTINEL}";`;
        const hookTicket = await service.prepareWrite(actor, {
            expectedRevision: agentmail.revision,
            mimeType: "text/plain",
            resourceId: agentmail.resourceId,
            sizeBytes: Buffer.byteLength(hookUpload),
        });
        expect(
            await captureFailure(() =>
                service.acceptUpload(
                    actor,
                    hookTicket.ticketId,
                    splitSentinelBody('export default "', '";'),
                    "request-hook-sentinel"
                )
            )
        ).toMatchObject({ reason: "invalid-input" });
        expect(Fs.readdirSync(spoolRoot)).toHaveLength(0);
        expect(calls).not.toContain("enqueue");

        const workspace = roots.roots.find(({ id }) => id === "workspace")!;
        const workspaceListing = await service.list(actor, {
            directoryId: workspace.resourceId,
            limit: 10,
        });
        const workspaceConfig = workspaceListing.entries.find(
            ({ name }) => name === "openclaw.json"
        )!;
        const workspaceTicket = await service.prepareWrite(actor, {
            expectedRevision: workspaceConfig.revision,
            mimeType: "application/json",
            resourceId: workspaceConfig.resourceId,
            sizeBytes: Buffer.byteLength(CONFIG_REDACTION_SENTINEL),
        });
        const accepted = await service.acceptUpload(
            actor,
            workspaceTicket.ticketId,
            splitSentinelBody(),
            "request-workspace-sentinel"
        );
        expect(accepted).toMatchObject({ ticketId: workspaceTicket.ticketId });
        expect(commands).toHaveLength(1);
        expect(Fs.readdirSync(spoolRoot)).toHaveLength(1);
    });

    for (const failurePhase of ["before-read", "after-read"] as const) {
        test(`cancels and unlocks a guarded source when the spool fails ${failurePhase}`, async () => {
            const receiveFailure = new WorkspaceFileError("capacity");
            let cancellationReason: unknown;
            let receivedBodyWasLocked: boolean | undefined;
            const { service } = fixture({
                includeOpenClaw: true,
                async receive(input) {
                    receivedBodyWasLocked = input.body.locked;
                    if (failurePhase === "after-read") {
                        const reader = input.body.getReader();
                        try {
                            expect(await reader.read()).toMatchObject({ done: false });
                        } finally {
                            reader.releaseLock();
                        }
                    }
                    throw receiveFailure;
                },
            });
            const roots = await service.listRoots(actor);
            const openClaw = roots.roots.find(({ id }) => id === "openclaw-config")!;
            const listing = await service.list(actor, {
                directoryId: openClaw.resourceId,
                limit: 10,
            });
            const config = listing.entries.find(({ name }) => name === "openclaw.json")!;
            const reveal = await service.prepareReveal(actor, {
                resourceId: config.resourceId,
            });
            const replacement = "{}";
            const ticket = await service.prepareWrite(actor, {
                expectedRevision: config.revision,
                mimeType: "application/json",
                revealTicketId: reveal.ticketId,
                resourceId: config.resourceId,
                sizeBytes: Buffer.byteLength(replacement),
            });
            const uploadBody = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(replacement));
                },
                cancel(reason) {
                    cancellationReason = reason;
                },
            });

            expect(
                await captureFailure(() =>
                    service.acceptUpload(
                        actor,
                        ticket.ticketId,
                        uploadBody,
                        `request-${failurePhase}`
                    )
                )
            ).toMatchObject({ reason: "capacity" });
            expect(receivedBodyWasLocked).toBe(false);
            expect(cancellationReason).toBe(receiveFailure);
            expect(uploadBody.locked).toBe(false);
        });
    }

    test("spools an exact upload, durably enqueues once, and reconciles status", async () => {
        const { audits, commands, root, service, spoolRoot } = fixture();
        const roots = await service.listRoots(actor);
        const ticket = await service.prepareUpload(actor, {
            directoryId: roots.roots[0]!.resourceId,
            fileName: "new.txt",
            mimeType: "text/plain",
            sizeBytes: 5,
        });
        expect(service.inspectUpload(actor, ticket.ticketId)).toMatchObject({
            mimeType: "text/plain",
            sizeBytes: 5,
            status: "prepared",
        });
        const accepted = await service.acceptUpload(
            actor,
            ticket.ticketId,
            body("hello"),
            "request-1"
        );
        expect(accepted).toMatchObject({ jobRunId: "job-1", ticketId: ticket.ticketId });
        expect(commands).toEqual([
            expect.objectContaining({
                fileName: "new.txt",
                operation: "create",
                sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
                sizeBytes: 5,
                ticketId: ticket.ticketId,
            }),
        ]);
        expect(audits).toEqual([
            {
                actor: { authenticatorId: "session-1", id: "user-1", kind: "user" },
                requestId: "request-1",
            },
        ]);
        expect(Fs.readdirSync(spoolRoot)).toHaveLength(1);
        expect(
            await captureFailure(() =>
                service.acceptUpload(actor, ticket.ticketId, body("hello"), "request-2")
            )
        ).toMatchObject({ reason: "conflict" });
        expect(await service.getWriteStatus(actor, ticket.ticketId)).toEqual({
            jobRunId: "job-1",
            status: "accepted",
            ticketId: ticket.ticketId,
        });
        expect(Fs.existsSync(Path.join(root, "new.txt"))).toBe(false);
    });

    test("never redispatches a failed enqueue and reclaims an authoritatively absent spool", async () => {
        const controller = new AbortController();
        let reconciliationCalled = false;
        let reconciliationSignal: AbortSignal | undefined;
        const fixtureValue = fixture({
            enqueue: (_command, _audit, signal) => {
                expect(signal).toBe(controller.signal);
                controller.abort();
                return Promise.reject(new Error("lost scheduler response"));
            },
            reconcileEnqueue: (_command, _actor, signal) => {
                reconciliationCalled = true;
                reconciliationSignal = signal;
                return Promise.resolve({ kind: "absent" });
            },
        });
        const roots = await fixtureValue.service.listRoots(actor);
        const ticket = await fixtureValue.service.prepareUpload(actor, {
            directoryId: roots.roots[0]!.resourceId,
            fileName: "uncertain.txt",
            mimeType: "text/plain",
            sizeBytes: 1,
        });
        expect(
            await captureFailure(() =>
                fixtureValue.service.acceptUpload(
                    actor,
                    ticket.ticketId,
                    body("x"),
                    "request-uncertain",
                    controller.signal
                )
            )
        ).toMatchObject({ reason: "unavailable" });
        expect(Fs.readdirSync(fixtureValue.spoolRoot)).toHaveLength(0);
        expect(await fixtureValue.service.getWriteStatus(actor, ticket.ticketId)).toEqual(
            {
                status: "reconciliation-required",
                ticketId: ticket.ticketId,
            }
        );
        expect(
            await captureFailure(() =>
                fixtureValue.service.acceptUpload(
                    actor,
                    ticket.ticketId,
                    body("x"),
                    "request-retry"
                )
            )
        ).toMatchObject({ reason: "conflict" });
        expect(fixtureValue.calls.filter((call) => call === "enqueue")).toHaveLength(1);
        expect(fixtureValue.calls.filter((call) => call === "reconcile")).toHaveLength(1);
        expect(reconciliationCalled).toBe(true);
        expect(reconciliationSignal).toBeUndefined();
    });

    test("retains an unknown enqueue spool until a later probe proves absence", async () => {
        let reconciliationAttempts = 0;
        const fixtureValue = fixture({
            enqueue: () => Promise.reject(new Error("lost scheduler response")),
            reconcileEnqueue: () => {
                reconciliationAttempts += 1;
                return reconciliationAttempts === 1
                    ? Promise.reject(new Error("status unavailable"))
                    : Promise.resolve({ kind: "absent" });
            },
        });
        const roots = await fixtureValue.service.listRoots(actor);
        const ticket = await fixtureValue.service.prepareUpload(actor, {
            directoryId: roots.roots[0]!.resourceId,
            fileName: "uncertain.txt",
            mimeType: "text/plain",
            sizeBytes: 1,
        });

        expect(
            await captureFailure(() =>
                fixtureValue.service.acceptUpload(
                    actor,
                    ticket.ticketId,
                    body("x"),
                    "request-uncertain"
                )
            )
        ).toMatchObject({ reason: "unavailable" });
        expect(Fs.readdirSync(fixtureValue.spoolRoot)).toHaveLength(1);

        expect(await fixtureValue.service.getWriteStatus(actor, ticket.ticketId)).toEqual(
            {
                status: "reconciliation-required",
                ticketId: ticket.ticketId,
            }
        );
        expect(reconciliationAttempts).toBe(2);
        expect(Fs.readdirSync(fixtureValue.spoolRoot)).toHaveLength(0);
    });

    test("retries an absent spool discard during later status reconciliation", async () => {
        const fixtureValue = fixture({
            discardFailures: 1,
            enqueue: () => Promise.reject(new Error("lost scheduler response")),
        });
        const roots = await fixtureValue.service.listRoots(actor);
        const ticket = await fixtureValue.service.prepareUpload(actor, {
            directoryId: roots.roots[0]!.resourceId,
            fileName: "discard-retry.txt",
            mimeType: "text/plain",
            sizeBytes: 1,
        });

        expect(
            await captureFailure(() =>
                fixtureValue.service.acceptUpload(
                    actor,
                    ticket.ticketId,
                    body("x"),
                    "request-discard-retry"
                )
            )
        ).toMatchObject({ reason: "unavailable" });
        expect(Fs.readdirSync(fixtureValue.spoolRoot)).toHaveLength(1);
        expect(fixtureValue.calls.filter((call) => call === "discard")).toHaveLength(1);

        expect(await fixtureValue.service.getWriteStatus(actor, ticket.ticketId)).toEqual(
            {
                status: "reconciliation-required",
                ticketId: ticket.ticketId,
            }
        );
        expect(Fs.readdirSync(fixtureValue.spoolRoot)).toHaveLength(0);
        expect(fixtureValue.calls.filter((call) => call === "discard")).toHaveLength(2);
        expect(fixtureValue.calls.filter((call) => call === "enqueue")).toHaveLength(1);
    });

    test("retains a spool when the durable reconciliation result is malformed", async () => {
        const fixtureValue = fixture({
            enqueue: () => Promise.reject(new Error("lost scheduler response")),
            reconcileEnqueue: () => Promise.resolve({ kind: "unknown" } as never),
        });
        const roots = await fixtureValue.service.listRoots(actor);
        const ticket = await fixtureValue.service.prepareUpload(actor, {
            directoryId: roots.roots[0]!.resourceId,
            fileName: "malformed-status.txt",
            mimeType: "text/plain",
            sizeBytes: 1,
        });

        expect(
            await captureFailure(() =>
                fixtureValue.service.acceptUpload(
                    actor,
                    ticket.ticketId,
                    body("x"),
                    "request-malformed-status"
                )
            )
        ).toMatchObject({ reason: "unavailable" });
        expect(await fixtureValue.service.getWriteStatus(actor, ticket.ticketId)).toEqual(
            {
                status: "reconciliation-required",
                ticketId: ticket.ticketId,
            }
        );
        expect(Fs.readdirSync(fixtureValue.spoolRoot)).toHaveLength(1);
        expect(fixtureValue.calls.filter((call) => call === "discard")).toHaveLength(0);
        expect(fixtureValue.calls.filter((call) => call === "enqueue")).toHaveLength(1);
    });

    test("recovers a committed enqueue whose response was lost without discarding its spool", async () => {
        const fixtureValue = fixture({
            enqueue: () => Promise.reject(new Error("lost scheduler response")),
            reconcileEnqueue: (command) =>
                Promise.resolve({
                    kind: "accepted",
                    result: {
                        acceptedAtMs: 1_800_000_000_000,
                        jobRunId: "job-recovered",
                        ticketId: command.ticketId,
                    },
                }),
        });
        const roots = await fixtureValue.service.listRoots(actor);
        const ticket = await fixtureValue.service.prepareUpload(actor, {
            directoryId: roots.roots[0]!.resourceId,
            fileName: "committed.txt",
            mimeType: "text/plain",
            sizeBytes: 1,
        });

        expect(
            await fixtureValue.service.acceptUpload(
                actor,
                ticket.ticketId,
                body("x"),
                "request-committed"
            )
        ).toEqual({
            acceptedAtMs: 1_800_000_000_000,
            jobRunId: "job-recovered",
            ticketId: ticket.ticketId,
        });
        expect(Fs.readdirSync(fixtureValue.spoolRoot)).toHaveLength(1);
        expect(await fixtureValue.service.getWriteStatus(actor, ticket.ticketId)).toEqual(
            {
                jobRunId: "job-recovered",
                status: "accepted",
                ticketId: ticket.ticketId,
            }
        );
        expect(fixtureValue.calls.filter((call) => call === "enqueue")).toHaveLength(1);
        expect(fixtureValue.calls.filter((call) => call === "reconcile")).toHaveLength(1);
    });

    test("preserves durable active uploads and performs no cleanup when reconciliation is truncated", async () => {
        const activeSpoolId = uuid(901);
        const inactiveSpoolId = uuid(902);
        const active = fixture({
            listActiveSpoolIds: () =>
                Promise.resolve({ spoolIds: [activeSpoolId], truncated: false }),
        });
        for (const spoolId of [activeSpoolId, inactiveSpoolId]) {
            const path = Path.join(active.spoolRoot, `${spoolId}.upload`);
            Fs.writeFileSync(path, "x", { mode: 0o600 });
            Fs.utimesSync(path, new Date(0), new Date(0));
        }

        expect(
            await active.service.cleanupUploadOrphans({
                olderThanMs: workspaceFileLimits.uploadTicketTtlMs,
            })
        ).toMatchObject({ removed: 1 });
        expect(
            Fs.existsSync(Path.join(active.spoolRoot, `${activeSpoolId}.upload`))
        ).toBe(true);

        const truncated = fixture({
            listActiveSpoolIds: () => Promise.resolve({ spoolIds: [], truncated: true }),
        });
        const candidate = Path.join(truncated.spoolRoot, `${uuid(903)}.upload`);
        Fs.writeFileSync(candidate, "x", { mode: 0o600 });
        Fs.utimesSync(candidate, new Date(0), new Date(0));
        expect(truncated.service.cleanupUploadOrphans()).rejects.toMatchObject({
            reason: "unavailable",
        });
        expect(Fs.existsSync(candidate)).toBe(true);
    });

    test("rejects a scheduler status that is not for the requested ticket", async () => {
        const { service } = fixture({
            getStatus: () =>
                Promise.resolve({
                    status: "pending",
                    ticketId: uuid(998),
                }),
        });

        expect(
            await captureFailure(() => service.getWriteStatus(actor, uuid(999)))
        ).toMatchObject({ reason: "unavailable" });
    });

    test("requires the selected replacement revision and hides oversized content", async () => {
        const { root, service } = fixture();
        Fs.writeFileSync(Path.join(root, "replace.txt"), "old");
        const roots = await service.listRoots(actor);
        const page = await service.list(actor, {
            directoryId: roots.roots[0]!.resourceId,
            limit: 10,
        });
        const file = page.entries[0]!;
        expect(
            await captureFailure(() =>
                service.prepareWrite(actor, {
                    expectedRevision: "0".repeat(64),
                    mimeType: "text/plain",
                    resourceId: file.resourceId,
                    sizeBytes: 3,
                })
            )
        ).toMatchObject({ reason: "conflict" });
        const replacement = await service.prepareWrite(actor, {
            expectedRevision: file.revision,
            mimeType: "text/plain",
            resourceId: file.resourceId,
            sizeBytes: 3,
        });
        expect(replacement.uploadUrl).toContain(replacement.ticketId);

        Fs.truncateSync(
            Path.join(root, "replace.txt"),
            workspaceFileLimits.maximumDownloadBytes + 1
        );
        const refreshed = await service.list(actor, {
            directoryId: roots.roots[0]!.resourceId,
            limit: 10,
        });
        expect(refreshed.entries[0]?.sizeBytes).toBe(
            workspaceFileLimits.maximumDownloadBytes + 1
        );
        expect(
            await captureFailure(() =>
                service.prepareWrite(actor, {
                    expectedRevision: refreshed.entries[0]!.revision,
                    mimeType: "text/plain",
                    resourceId: refreshed.entries[0]!.resourceId,
                    sizeBytes: 3,
                })
            )
        ).toMatchObject({ reason: "too-large" });
        expect(
            await captureFailure(() =>
                service.prepareContent(actor, {
                    disposition: "download",
                    resourceId: refreshed.entries[0]!.resourceId,
                })
            )
        ).toBeInstanceOf(WorkspaceFileError);
    });
});
