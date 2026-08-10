import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import Fs from "node:fs";
import Os from "node:os";
import Path from "node:path";

import { workspaceFileRevisionForStat } from "../../server/platform/files/workspaceFileRevision.ts";
import { captureFailure } from "../../server/test/support/promise.ts";
import {
    createDescriptorWorkspaceFileStructuralWriter,
    type DescriptorWorkspaceFileStructuralWriter,
    type WorkerWorkspaceFileWriteCommand,
    WorkspaceFileStructuralWriteError,
} from "./descriptorWorkspaceFileStructuralWriter.ts";
import { linuxRenameExchange } from "./linuxRenameExchange.ts";

const directories: string[] = [];
const writers: DescriptorWorkspaceFileStructuralWriter[] = [];

function fixture() {
    const parent = Fs.mkdtempSync(Path.join(Os.tmpdir(), "mira-files-writer-"));
    const root = Path.join(parent, "workspace");
    const spool = Path.join(parent, "spool");
    Fs.mkdirSync(root, { mode: 0o700 });
    Fs.mkdirSync(spool, { mode: 0o700 });
    directories.push(parent);
    const writer = createDescriptorWorkspaceFileStructuralWriter({
        roots: [{ id: "workspace", path: root, writable: true }],
        spoolRoot: spool,
    });
    writers.push(writer);
    return { root, spool, writer };
}

function stageUpload(spool: string, spoolId: string, contents: string): string {
    const bytes = Buffer.from(contents);
    Fs.writeFileSync(Path.join(spool, `${spoolId}.upload`), bytes, { mode: 0o600 });
    return createHash("sha256").update(bytes).digest("hex");
}

function replacementRevision(root: string, fileName: string): string {
    return workspaceFileRevisionForStat(
        "workspace",
        [fileName],
        Fs.statSync(Path.join(root, fileName), { bigint: true })
    );
}

afterEach(() => {
    for (const writer of writers.splice(0)) writer.dispose();
    for (const directory of directories.splice(0)) {
        Fs.rmSync(directory, { force: true, recursive: true });
    }
});

describe("descriptor workspace file structural writer", () => {
    test("creates through a private fsynced stage without overwriting an existing child", async () => {
        const { root, spool, writer } = fixture();
        Fs.mkdirSync(Path.join(root, "docs"));
        const spoolId = "11111111-1111-4111-8111-111111111111";
        const sha256 = stageUpload(spool, spoolId, "hello");
        const result = await writer.apply({
            fileName: "note.txt",
            locator: { rootId: "workspace", segments: ["docs"] },
            mimeType: "text/plain",
            operation: "create",
            sha256,
            sizeBytes: 5,
            spoolId,
            ticketId: "22222222-2222-4222-8222-222222222222",
        });

        const target = Path.join(root, "docs", "note.txt");
        expect(Fs.readFileSync(target, "utf8")).toBe("hello");
        expect(Fs.statSync(target).mode & 0o777).toBe(0o600);
        expect(result).toMatchObject({ sizeBytes: 5 });
        expect(Fs.existsSync(Path.join(spool, `${spoolId}.upload`))).toBe(false);

        const nextSpoolId = "33333333-3333-4333-8333-333333333333";
        const nextHash = stageUpload(spool, nextSpoolId, "other");
        expect(
            await captureFailure(() =>
                writer.apply({
                    fileName: "note.txt",
                    locator: { rootId: "workspace", segments: ["docs"] },
                    mimeType: "text/plain",
                    operation: "create",
                    sha256: nextHash,
                    sizeBytes: 5,
                    spoolId: nextSpoolId,
                    ticketId: "44444444-4444-4444-8444-444444444444",
                })
            )
        ).toMatchObject({ reason: "conflict" });
        expect(Fs.readFileSync(target, "utf8")).toBe("hello");
    });

    test("does not publish a target when the atomic create commit fails", async () => {
        const parent = Fs.mkdtempSync(Path.join(Os.tmpdir(), "mira-files-create-fault-"));
        const root = Path.join(parent, "workspace");
        const spool = Path.join(parent, "spool");
        Fs.mkdirSync(root, { mode: 0o700 });
        Fs.mkdirSync(spool, { mode: 0o700 });
        directories.push(parent);
        const writer = createDescriptorWorkspaceFileStructuralWriter({
            renameNoReplace() {
                throw Object.assign(new Error("injected commit fault"), {
                    code: "EIO",
                });
            },
            roots: [{ id: "workspace", path: root, writable: true }],
            spoolRoot: spool,
        });
        writers.push(writer);
        const spoolId = "14141414-1414-4414-8414-141414141414";
        const sha256 = stageUpload(spool, spoolId, "created");

        expect(
            await captureFailure(() =>
                writer.apply({
                    fileName: "new.txt",
                    locator: { rootId: "workspace", segments: [] },
                    mimeType: "text/plain",
                    operation: "create",
                    sha256,
                    sizeBytes: 7,
                    spoolId,
                    ticketId: "15151515-1515-4515-8515-151515151515",
                })
            )
        ).toMatchObject({ reason: "unavailable" });
        expect(Fs.existsSync(Path.join(root, "new.txt"))).toBe(false);
        expect(Fs.existsSync(Path.join(spool, `${spoolId}.upload`))).toBe(true);
        expect(Fs.readdirSync(root)).toEqual([]);
    });

    test("replaces exactly one matching CAS revision and preserves its mode", async () => {
        const { root, spool, writer } = fixture();
        const target = Path.join(root, "note.txt");
        Fs.writeFileSync(target, "old");
        Fs.chmodSync(target, 0o640);
        const expectedRevision = replacementRevision(root, "note.txt");
        const spoolId = "55555555-5555-4555-8555-555555555555";
        const sha256 = stageUpload(spool, spoolId, "replacement");

        const result = await writer.apply({
            expectedRevision,
            fileName: "note.txt",
            locator: { rootId: "workspace", segments: ["note.txt"] },
            mimeType: "text/plain",
            operation: "replace",
            sha256,
            sizeBytes: 11,
            spoolId,
            ticketId: "66666666-6666-4666-8666-666666666666",
        });

        expect(Fs.readFileSync(target, "utf8")).toBe("replacement");
        expect(Fs.statSync(target).mode & 0o777).toBe(0o640);
        expect(result.revision).toBe(replacementRevision(root, "note.txt"));
        expect(result.revision).not.toBe(expectedRevision);
    });

    test("limits an OpenClaw writer root to exact bounded replacements", async () => {
        const parent = Fs.mkdtempSync(Path.join(Os.tmpdir(), "mira-openclaw-writer-"));
        const root = Path.join(parent, "openclaw");
        const spool = Path.join(parent, "spool");
        Fs.mkdirSync(Path.join(root, "hooks", "transforms"), {
            mode: 0o700,
            recursive: true,
        });
        Fs.chmodSync(root, 0o700);
        Fs.mkdirSync(spool, { mode: 0o700 });
        Fs.writeFileSync(Path.join(root, "openclaw.json"), "old", { mode: 0o600 });
        Fs.writeFileSync(Path.join(root, "credentials.json"), "keep", {
            mode: 0o600,
        });
        directories.push(parent);
        const writer = createDescriptorWorkspaceFileStructuralWriter({
            roots: [
                {
                    id: "openclaw-config",
                    path: root,
                    replacementManifest: [
                        { maximumSizeBytes: 16, segments: ["openclaw.json"] },
                        {
                            maximumSizeBytes: 16,
                            segments: ["hooks", "transforms", "agentmail.ts"],
                        },
                    ],
                    writable: true,
                },
            ],
            spoolRoot: spool,
        });
        writers.push(writer);

        const allowedSpoolId = "56565656-5656-4656-8656-565656565656";
        const allowedSha = stageUpload(spool, allowedSpoolId, "new");
        await writer.apply({
            expectedRevision: workspaceFileRevisionForStat(
                "openclaw-config",
                ["openclaw.json"],
                Fs.statSync(Path.join(root, "openclaw.json"), { bigint: true })
            ),
            fileName: "openclaw.json",
            locator: { rootId: "openclaw-config", segments: ["openclaw.json"] },
            mimeType: "application/json",
            operation: "replace",
            sha256: allowedSha,
            sizeBytes: 3,
            spoolId: allowedSpoolId,
            ticketId: "57575757-5757-4757-8757-575757575757",
        });
        expect(Fs.readFileSync(Path.join(root, "openclaw.json"), "utf8")).toBe("new");

        const deniedSpoolId = "58585858-5858-4858-8858-585858585858";
        const deniedSha = stageUpload(spool, deniedSpoolId, "leak");
        expect(
            await captureFailure(() =>
                writer.apply({
                    expectedRevision: workspaceFileRevisionForStat(
                        "openclaw-config",
                        ["credentials.json"],
                        Fs.statSync(Path.join(root, "credentials.json"), {
                            bigint: true,
                        })
                    ),
                    fileName: "credentials.json",
                    locator: {
                        rootId: "openclaw-config",
                        segments: ["credentials.json"],
                    },
                    mimeType: "application/json",
                    operation: "replace",
                    sha256: deniedSha,
                    sizeBytes: 4,
                    spoolId: deniedSpoolId,
                    ticketId: "59595959-5959-4959-8959-595959595959",
                })
            )
        ).toMatchObject({ reason: "access-denied" });
        expect(Fs.readFileSync(Path.join(root, "credentials.json"), "utf8")).toBe("keep");
    });

    test("atomically rolls back when the target changes after CAS verification", async () => {
        const parent = Fs.mkdtempSync(Path.join(Os.tmpdir(), "mira-files-cas-race-"));
        const root = Path.join(parent, "workspace");
        const spool = Path.join(parent, "spool");
        Fs.mkdirSync(root, { mode: 0o700 });
        Fs.mkdirSync(spool, { mode: 0o700 });
        directories.push(parent);
        const target = Path.join(root, "note.txt");
        Fs.writeFileSync(target, "old");
        const expectedRevision = replacementRevision(root, "note.txt");
        let exchangeCount = 0;
        const writer = createDescriptorWorkspaceFileStructuralWriter({
            renameExchange(directoryFd, leftName, rightName) {
                exchangeCount += 1;
                if (exchangeCount === 1) Fs.writeFileSync(target, "concurrent");
                linuxRenameExchange(directoryFd, leftName, rightName);
            },
            roots: [{ id: "workspace", path: root, writable: true }],
            spoolRoot: spool,
        });
        writers.push(writer);
        const spoolId = "12121212-1212-4212-8212-121212121212";
        const sha256 = stageUpload(spool, spoolId, "replacement");

        expect(
            await captureFailure(() =>
                writer.apply({
                    expectedRevision,
                    fileName: "note.txt",
                    locator: { rootId: "workspace", segments: ["note.txt"] },
                    mimeType: "text/plain",
                    operation: "replace",
                    sha256,
                    sizeBytes: 11,
                    spoolId,
                    ticketId: "13131313-1313-4313-8313-131313131313",
                })
            )
        ).toMatchObject({ reason: "conflict" });
        expect(exchangeCount).toBe(2);
        expect(Fs.readFileSync(target, "utf8")).toBe("concurrent");
        expect(Fs.existsSync(Path.join(spool, `${spoolId}.upload`))).toBe(true);
        expect(
            Fs.readdirSync(root).filter((name) => name.startsWith(".mira-files-"))
        ).toHaveLength(0);
    });

    test("detects same-size concurrent bytes even when mtime is restored", async () => {
        const parent = Fs.mkdtempSync(
            Path.join(Os.tmpdir(), "mira-files-cas-digest-race-")
        );
        const root = Path.join(parent, "workspace");
        const spool = Path.join(parent, "spool");
        Fs.mkdirSync(root, { mode: 0o700 });
        Fs.mkdirSync(spool, { mode: 0o700 });
        directories.push(parent);
        const target = Path.join(root, "note.txt");
        Fs.writeFileSync(target, "old");
        Fs.utimesSync(target, 1_700_000_000, 1_700_000_000);
        const expectedMtimeNs = Fs.statSync(target, { bigint: true }).mtimeNs;
        const expectedRevision = replacementRevision(root, "note.txt");
        let exchangeCount = 0;
        const writer = createDescriptorWorkspaceFileStructuralWriter({
            renameExchange(directoryFd, leftName, rightName) {
                exchangeCount += 1;
                if (exchangeCount === 1) {
                    Fs.writeFileSync(target, "bad");
                    Fs.utimesSync(target, 1_700_000_000, 1_700_000_000);
                    expect(Fs.statSync(target, { bigint: true }).mtimeNs).toBe(
                        expectedMtimeNs
                    );
                }
                linuxRenameExchange(directoryFd, leftName, rightName);
            },
            roots: [{ id: "workspace", path: root, writable: true }],
            spoolRoot: spool,
        });
        writers.push(writer);
        const spoolId = "16161616-1616-4616-8616-161616161616";
        const sha256 = stageUpload(spool, spoolId, "replacement");

        expect(
            await captureFailure(() =>
                writer.apply({
                    expectedRevision,
                    fileName: "note.txt",
                    locator: { rootId: "workspace", segments: ["note.txt"] },
                    mimeType: "text/plain",
                    operation: "replace",
                    sha256,
                    sizeBytes: 11,
                    spoolId,
                    ticketId: "17171717-1717-4717-8717-171717171717",
                })
            )
        ).toMatchObject({ reason: "conflict" });
        expect(exchangeCount).toBe(2);
        expect(Fs.readFileSync(target, "utf8")).toBe("bad");
    });

    test("recovers idempotently after a crash-window exchange", async () => {
        const parent = Fs.mkdtempSync(
            Path.join(Os.tmpdir(), "mira-files-exchange-recovery-")
        );
        const root = Path.join(parent, "workspace");
        const spool = Path.join(parent, "spool");
        Fs.mkdirSync(root, { mode: 0o700 });
        Fs.mkdirSync(spool, { mode: 0o700 });
        directories.push(parent);
        const target = Path.join(root, "note.txt");
        Fs.writeFileSync(target, "old");
        const spoolId = "18181818-1818-4818-8818-181818181818";
        const command: WorkerWorkspaceFileWriteCommand = {
            expectedRevision: replacementRevision(root, "note.txt"),
            fileName: "note.txt",
            locator: { rootId: "workspace", segments: ["note.txt"] },
            mimeType: "text/plain",
            operation: "replace",
            sha256: stageUpload(spool, spoolId, "replacement"),
            sizeBytes: 11,
            spoolId,
            ticketId: "19191919-1919-4919-8919-191919191919",
        };
        let injected = false;
        const interruptedWriter = createDescriptorWorkspaceFileStructuralWriter({
            renameExchange(directoryFd, leftName, rightName) {
                linuxRenameExchange(directoryFd, leftName, rightName);
                if (!injected) {
                    injected = true;
                    throw Object.assign(new Error("injected post-exchange crash"), {
                        code: "EIO",
                    });
                }
            },
            roots: [{ id: "workspace", path: root, writable: true }],
            spoolRoot: spool,
        });
        writers.push(interruptedWriter);

        expect(
            await captureFailure(() => interruptedWriter.apply(command))
        ).toMatchObject({ reason: "unavailable" });
        expect(Fs.readFileSync(target, "utf8")).toBe("replacement");
        expect(Fs.existsSync(Path.join(spool, `${spoolId}.replace-intent`))).toBe(true);

        interruptedWriter.dispose();
        writers.splice(writers.indexOf(interruptedWriter), 1);
        const recoveredWriter = createDescriptorWorkspaceFileStructuralWriter({
            roots: [{ id: "workspace", path: root, writable: true }],
            spoolRoot: spool,
        });
        writers.push(recoveredWriter);
        const result = await recoveredWriter.apply(command);

        expect(result.revision).toBe(replacementRevision(root, "note.txt"));
        expect(Fs.readFileSync(target, "utf8")).toBe("replacement");
        expect(Fs.existsSync(Path.join(spool, `${spoolId}.upload`))).toBe(false);
        expect(
            Fs.readdirSync(root).filter((name) => name.startsWith(".mira-files-"))
        ).toHaveLength(0);
        expect(Fs.existsSync(Path.join(spool, `${spoolId}.replace-settled`))).toBe(true);

        await recoveredWriter.removeSettledReplacementIntent(command);
        expect(Fs.existsSync(Path.join(spool, `${spoolId}.replace-settled`))).toBe(false);
    });

    test("rejects crash recovery after ctime-only target drift", async () => {
        const parent = Fs.mkdtempSync(
            Path.join(Os.tmpdir(), "mira-files-ctime-recovery-")
        );
        const root = Path.join(parent, "workspace");
        const spool = Path.join(parent, "spool");
        Fs.mkdirSync(root, { mode: 0o700 });
        Fs.mkdirSync(spool, { mode: 0o700 });
        directories.push(parent);
        const target = Path.join(root, "note.txt");
        Fs.writeFileSync(target, "old");
        Fs.chmodSync(target, 0o640);
        const original = Fs.statSync(target, { bigint: true });
        const spoolId = "24242424-2424-4424-8424-242424242424";
        const command: WorkerWorkspaceFileWriteCommand = {
            expectedRevision: replacementRevision(root, "note.txt"),
            fileName: "note.txt",
            locator: { rootId: "workspace", segments: ["note.txt"] },
            mimeType: "text/plain",
            operation: "replace",
            sha256: stageUpload(spool, spoolId, "replacement"),
            sizeBytes: 11,
            spoolId,
            ticketId: "25252525-2525-4525-8525-252525252525",
        };
        const interruptedWriter = createDescriptorWorkspaceFileStructuralWriter({
            renameExchange() {
                Fs.chmodSync(target, 0o600);
                Fs.chmodSync(target, 0o640);
                throw Object.assign(new Error("injected pre-exchange crash"), {
                    code: "EIO",
                });
            },
            roots: [{ id: "workspace", path: root, writable: true }],
            spoolRoot: spool,
        });
        writers.push(interruptedWriter);

        expect(
            await captureFailure(() => interruptedWriter.apply(command))
        ).toMatchObject({ reason: "unavailable" });
        const drifted = Fs.statSync(target, { bigint: true });
        expect(drifted.ctimeNs).not.toBe(original.ctimeNs);
        expect(drifted.mode).toBe(original.mode);
        expect(drifted.mtimeNs).toBe(original.mtimeNs);
        expect(Fs.readFileSync(target, "utf8")).toBe("old");

        interruptedWriter.dispose();
        writers.splice(writers.indexOf(interruptedWriter), 1);
        const recoveredWriter = createDescriptorWorkspaceFileStructuralWriter({
            roots: [{ id: "workspace", path: root, writable: true }],
            spoolRoot: spool,
        });
        writers.push(recoveredWriter);

        expect(await captureFailure(() => recoveredWriter.apply(command))).toMatchObject({
            reason: "conflict",
        });
        expect(Fs.readFileSync(target, "utf8")).toBe("old");
        expect(replacementRevision(root, "note.txt")).not.toBe(command.expectedRevision);
        expect(Fs.existsSync(Path.join(spool, `${spoolId}.replace-intent`))).toBe(false);
        expect(
            Fs.readdirSync(root).filter((name) => name.startsWith(".mira-files-"))
        ).toHaveLength(0);
    });

    test("reclaims every durably settled replacement intent before capacity is reused", async () => {
        const { root, spool, writer } = fixture();
        const target = Path.join(root, "note.txt");
        Fs.writeFileSync(target, "initial");

        for (let index = 0; index < 257; index += 1) {
            const contents = `replacement-${index}`;
            const spoolId = randomUUID();
            const command: WorkerWorkspaceFileWriteCommand = {
                expectedRevision: replacementRevision(root, "note.txt"),
                fileName: "note.txt",
                locator: { rootId: "workspace", segments: ["note.txt"] },
                mimeType: "text/plain",
                operation: "replace",
                sha256: stageUpload(spool, spoolId, contents),
                sizeBytes: Buffer.byteLength(contents),
                spoolId,
                ticketId: randomUUID(),
            };

            await writer.apply(command);
            await writer.removeSettledReplacementIntent(command);
        }

        expect(Fs.readFileSync(target, "utf8")).toBe("replacement-256");
        expect(
            Fs.readdirSync(spool).filter((name) => name.endsWith(".replace-settled"))
        ).toHaveLength(0);
    }, 30_000);

    test("rejects replacement targets beyond the bounded digest budget", async () => {
        const { root, spool, writer } = fixture();
        const target = Path.join(root, "large.bin");
        Fs.writeFileSync(target, "");
        Fs.truncateSync(target, 32 * 1024 * 1024 + 1);
        const spoolId = "20202020-2020-4020-8020-202020202020";
        const sha256 = stageUpload(spool, spoolId, "x");

        expect(
            await captureFailure(() =>
                writer.apply({
                    expectedRevision: replacementRevision(root, "large.bin"),
                    fileName: "large.bin",
                    locator: { rootId: "workspace", segments: ["large.bin"] },
                    mimeType: "application/octet-stream",
                    operation: "replace",
                    sha256,
                    sizeBytes: 1,
                    spoolId,
                    ticketId: "21212121-2121-4121-8121-212121212121",
                })
            )
        ).toMatchObject({ reason: "too-large" });
        expect(Fs.statSync(target).size).toBe(32 * 1024 * 1024 + 1);
    });

    test("rejects stale CAS, symbolic targets, hard-linked targets, and untrusted spools", async () => {
        const { root, spool, writer } = fixture();
        const target = Path.join(root, "note.txt");
        Fs.writeFileSync(target, "old");
        const staleRevision = replacementRevision(root, "note.txt");
        Fs.writeFileSync(target, "changed");
        const staleSpoolId = "77777777-7777-4777-8777-777777777777";
        const staleHash = stageUpload(spool, staleSpoolId, "replacement");
        expect(
            await captureFailure(() =>
                writer.apply({
                    expectedRevision: staleRevision,
                    fileName: "note.txt",
                    locator: { rootId: "workspace", segments: ["note.txt"] },
                    mimeType: "text/plain",
                    operation: "replace",
                    sha256: staleHash,
                    sizeBytes: 11,
                    spoolId: staleSpoolId,
                    ticketId: "88888888-8888-4888-8888-888888888888",
                })
            )
        ).toMatchObject({ reason: "conflict" });
        expect(Fs.readFileSync(target, "utf8")).toBe("changed");

        Fs.unlinkSync(target);
        Fs.symlinkSync("/etc/passwd", target);
        expect(
            await captureFailure(() =>
                writer.apply({
                    expectedRevision: staleRevision,
                    fileName: "note.txt",
                    locator: { rootId: "workspace", segments: ["note.txt"] },
                    mimeType: "text/plain",
                    operation: "replace",
                    sha256: staleHash,
                    sizeBytes: 11,
                    spoolId: staleSpoolId,
                    ticketId: "99999999-9999-4999-8999-999999999999",
                })
            )
        ).toMatchObject({ reason: "access-denied" });

        Fs.unlinkSync(target);
        Fs.writeFileSync(target, "linked");
        Fs.linkSync(target, Path.join(root, "second-link.txt"));
        const linkedRevision = replacementRevision(root, "note.txt");
        expect(
            await captureFailure(() =>
                writer.apply({
                    expectedRevision: linkedRevision,
                    fileName: "note.txt",
                    locator: { rootId: "workspace", segments: ["note.txt"] },
                    mimeType: "text/plain",
                    operation: "replace",
                    sha256: staleHash,
                    sizeBytes: 11,
                    spoolId: staleSpoolId,
                    ticketId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                })
            )
        ).toMatchObject({ reason: "access-denied" });

        Fs.chmodSync(Path.join(spool, `${staleSpoolId}.upload`), 0o644);
        expect(
            await captureFailure(() =>
                writer.apply({
                    fileName: "new.txt",
                    locator: { rootId: "workspace", segments: [] },
                    mimeType: "text/plain",
                    operation: "create",
                    sha256: staleHash,
                    sizeBytes: 11,
                    spoolId: staleSpoolId,
                    ticketId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                })
            )
        ).toBeInstanceOf(WorkspaceFileStructuralWriteError);
    });

    test("validates exact spool size and hash before exposing any target bytes", async () => {
        const { root, spool, writer } = fixture();
        const spoolId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        stageUpload(spool, spoolId, "payload");
        expect(
            await captureFailure(() =>
                writer.apply({
                    fileName: "invalid.txt",
                    locator: { rootId: "workspace", segments: [] },
                    mimeType: "text/plain",
                    operation: "create",
                    sha256: "0".repeat(64),
                    sizeBytes: 7,
                    spoolId,
                    ticketId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                })
            )
        ).toMatchObject({ reason: "conflict" });
        expect(Fs.existsSync(Path.join(root, "invalid.txt"))).toBe(false);
        expect(Fs.readdirSync(root).some((name) => name.startsWith(".mira-files-"))).toBe(
            false
        );
    });

    test("rejects unrecognized operations and malformed MIME metadata", async () => {
        const { root, spool, writer } = fixture();
        const spoolId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
        const sha256 = stageUpload(spool, spoolId, "x");
        const base = {
            fileName: "invalid.txt",
            locator: { rootId: "workspace", segments: [] },
            mimeType: "text/plain",
            operation: "create",
            sha256,
            sizeBytes: 1,
            spoolId,
            ticketId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        } as const;

        for (const command of [
            { ...base, operation: "delete" },
            { ...base, mimeType: "text/plain; charset=utf-8" },
        ]) {
            expect(
                await captureFailure(() =>
                    writer.apply(command as unknown as WorkerWorkspaceFileWriteCommand)
                )
            ).toMatchObject({ reason: "invalid-input" });
        }
        expect(Fs.existsSync(Path.join(root, "invalid.txt"))).toBe(false);
    });

    test("rejects unreviewable root identifiers at composition", () => {
        const { root, spool } = fixture();
        expect(() =>
            createDescriptorWorkspaceFileStructuralWriter({
                roots: [{ id: "../workspace", path: root, writable: true }],
                spoolRoot: spool,
            })
        ).toThrow("metadata");
        Fs.chmodSync(root, 0o770);
        expect(() =>
            createDescriptorWorkspaceFileStructuralWriter({
                roots: [{ id: "workspace", path: root, writable: true }],
                spoolRoot: spool,
            })
        ).toThrow("owner or mode");
    });
});
