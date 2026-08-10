import { afterEach, describe, expect, test } from "bun:test";
import Fs from "node:fs";
import Os from "node:os";
import Path from "node:path";

import { workspaceFileLimits } from "../../../contracts/files.ts";
import { createDescriptorWorkspaceFileReader } from "../../platform/files/descriptorWorkspaceFileReader.ts";
import { createDescriptorWorkspaceFileUploadSpool } from "../../platform/files/descriptorWorkspaceFileUploadSpool.ts";
import { captureFailure } from "../../test/support/promise.ts";
import { WorkspaceFileError } from "./errors.ts";
import type {
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

function fixture(
    options: {
        readonly enqueue?: WorkspaceFileWriteScheduler["enqueue"];
        readonly getStatus?: WorkspaceFileWriteScheduler["getStatus"];
        readonly includeOpenClaw?: boolean;
        readonly listActiveSpoolIds?: WorkspaceFileWriteScheduler["listActiveSpoolIds"];
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
    };
    const reader = createDescriptorWorkspaceFileReader({
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
                                  maximumSizeBytes: 1_048_576,
                                  segments: ["openclaw.json"],
                              },
                              {
                                  contentPolicy: "raw" as const,
                                  maximumSizeBytes: 1_048_576,
                                  segments: ["hooks", "transforms", "agentmail.ts"],
                              },
                          ],
                          path: openClawRoot,
                          writable: false,
                      },
                  ]
                : []),
        ],
    });
    const spool = createDescriptorWorkspaceFileUploadSpool(spoolRoot, {
        nowMs: () => now,
    });
    const service = createWorkspaceFilesService({
        generateId: () => uuid(nextId++),
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

afterEach(async () => {
    await Promise.allSettled(services.splice(0).map((service) => service.dispose()));
    for (const directory of temporaryDirectories.splice(0)) {
        Fs.rmSync(directory, { force: true, recursive: true });
    }
});

describe("workspace files service", () => {
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

    test("publishes the redacted OpenClaw tree while denying every write path", async () => {
        const { service } = fixture({ includeOpenClaw: true });
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
        const config = listing.entries.find(({ name }) => name === "openclaw.json")!;
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

    test("never redispatches an uncertain durable enqueue and retains bytes for reconciliation", async () => {
        const fixtureValue = fixture({
            enqueue: () => Promise.reject(new Error("lost scheduler response")),
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
        expect(Fs.readdirSync(fixtureValue.spoolRoot)).toHaveLength(1);
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
                service.prepareContent(actor, {
                    disposition: "download",
                    resourceId: refreshed.entries[0]!.resourceId,
                })
            )
        ).toBeInstanceOf(WorkspaceFileError);
    });
});
