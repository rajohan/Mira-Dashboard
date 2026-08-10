import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import Fs from "node:fs";
import Os from "node:os";
import Path from "node:path";

import { workspaceFileLimits } from "../../contracts/files.ts";
import { workspaceFileRevisionForStat } from "../../server/platform/files/workspaceFileRevision.ts";
import { captureFailure } from "../../server/test/support/promise.ts";
import {
    createDescriptorWorkspaceFileStructuralWriter,
    type DescriptorWorkspaceFileStructuralWriter,
    type WorkerWorkspaceFileRootConfiguration,
    type WorkerWorkspaceFileWriteCommand,
    WorkspaceFileStructuralWriteError,
} from "./descriptorWorkspaceFileStructuralWriter.ts";
import { linuxRenameExchange, linuxRenameReplace } from "./linuxRenameExchange.ts";

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

function fsyncDirectory(path: string): void {
    const fd = Fs.openSync(path, Fs.constants.O_RDONLY | Fs.constants.O_DIRECTORY);
    try {
        Fs.fsyncSync(fd);
    } finally {
        Fs.closeSync(fd);
    }
}

function reviewedOpenClawRoot(root: string): WorkerWorkspaceFileRootConfiguration {
    return {
        id: "openclaw-config",
        path: root,
        replacementManifest: [
            {
                backupPolicy: "sibling-dot-bak",
                maximumSizeBytes: workspaceFileLimits.maximumManifestFileBytes,
                segments: ["openclaw.json"],
            },
            {
                backupPolicy: "sibling-dot-bak",
                maximumSizeBytes: workspaceFileLimits.maximumManifestFileBytes,
                segments: ["hooks", "transforms", "agentmail.ts"],
            },
        ],
        writable: true,
    };
}

function reviewedReplacement(
    segments: readonly string[],
    backup = false
): NonNullable<WorkerWorkspaceFileRootConfiguration["replacementManifest"]>[number] {
    return {
        ...(backup ? { backupPolicy: "sibling-dot-bak" as const } : {}),
        maximumSizeBytes: workspaceFileLimits.maximumManifestFileBytes,
        segments,
    };
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

    test("revalidates root trust before root-level and nested writes", async () => {
        const { root, spool, writer } = fixture();
        const nestedDirectory = Path.join(root, "docs");
        Fs.mkdirSync(nestedDirectory);
        const rootSpoolId = "45454545-4545-4545-8545-454545454545";
        const nestedSpoolId = "46464646-4646-4646-8646-464646464646";
        const rootSha256 = stageUpload(spool, rootSpoolId, "root");
        const nestedSha256 = stageUpload(spool, nestedSpoolId, "nested");

        Fs.chmodSync(root, 0o777);
        try {
            expect(
                await captureFailure(() =>
                    writer.apply({
                        fileName: "root.txt",
                        locator: { rootId: "workspace", segments: [] },
                        mimeType: "text/plain",
                        operation: "create",
                        sha256: rootSha256,
                        sizeBytes: 4,
                        spoolId: rootSpoolId,
                        ticketId: "47474747-4747-4747-8747-474747474747",
                    })
                )
            ).toMatchObject({ reason: "access-denied" });
            expect(
                await captureFailure(() =>
                    writer.apply({
                        fileName: "nested.txt",
                        locator: { rootId: "workspace", segments: ["docs"] },
                        mimeType: "text/plain",
                        operation: "create",
                        sha256: nestedSha256,
                        sizeBytes: 6,
                        spoolId: nestedSpoolId,
                        ticketId: "48484848-4848-4848-8848-484848484848",
                    })
                )
            ).toMatchObject({ reason: "access-denied" });
        } finally {
            Fs.chmodSync(root, 0o700);
        }

        expect(Fs.existsSync(Path.join(root, "root.txt"))).toBe(false);
        expect(Fs.existsSync(Path.join(nestedDirectory, "nested.txt"))).toBe(false);
        expect(
            Fs.readdirSync(root).filter((name) => name.startsWith(".mira-files-"))
        ).toEqual([]);
        expect(Fs.existsSync(Path.join(spool, `${rootSpoolId}.upload`))).toBe(true);
        expect(Fs.existsSync(Path.join(spool, `${nestedSpoolId}.upload`))).toBe(true);
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
        expect(Fs.existsSync(`${target}.bak`)).toBe(false);
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
        const repairSecret = "recognizable-repair-secret";
        const invalidOldJson = `{"token":"${repairSecret}",`;
        const validNewJson = '{"token":"rotated"}\n';
        expect(() => {
            JSON.parse(invalidOldJson);
        }).toThrow();
        expect(JSON.parse(validNewJson)).toEqual({ token: "rotated" });
        Fs.writeFileSync(Path.join(root, "openclaw.json"), invalidOldJson, {
            mode: 0o600,
        });
        Fs.writeFileSync(Path.join(root, "openclaw.json.bak"), "earlier backup", {
            mode: 0o600,
        });
        Fs.writeFileSync(Path.join(root, "credentials.json"), "keep", {
            mode: 0o600,
        });
        directories.push(parent);
        const writer = createDescriptorWorkspaceFileStructuralWriter({
            roots: [reviewedOpenClawRoot(root)],
            spoolRoot: spool,
        });
        writers.push(writer);

        const allowedSpoolId = "56565656-5656-4656-8656-565656565656";
        const allowedSha = stageUpload(spool, allowedSpoolId, validNewJson);
        const command: WorkerWorkspaceFileWriteCommand = {
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
            sizeBytes: Buffer.byteLength(validNewJson),
            spoolId: allowedSpoolId,
            ticketId: "57575757-5757-4757-8757-575757575757",
        };
        const result = await writer.apply(command);
        expect(Fs.readFileSync(Path.join(root, "openclaw.json"), "utf8")).toBe(
            validNewJson
        );
        expect(Fs.readFileSync(Path.join(root, "openclaw.json.bak"), "utf8")).toBe(
            invalidOldJson
        );
        expect(Fs.statSync(Path.join(root, "openclaw.json.bak")).mode & 0o777).toBe(
            0o600
        );
        expect(Fs.readdirSync(root).filter((name) => name.endsWith(".bak"))).toEqual([
            "openclaw.json.bak",
        ]);
        expect(JSON.stringify(command)).not.toContain(repairSecret);
        expect(JSON.stringify(result)).not.toContain(repairSecret);

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

    test("leaves a reviewed backup untouched when target CAS is stale", async () => {
        const parent = Fs.mkdtempSync(Path.join(Os.tmpdir(), "mira-openclaw-stale-"));
        const root = Path.join(parent, "openclaw");
        const spool = Path.join(parent, "spool");
        Fs.mkdirSync(root, { mode: 0o700 });
        Fs.mkdirSync(spool, { mode: 0o700 });
        directories.push(parent);
        const target = Path.join(root, "openclaw.json");
        const backup = `${target}.bak`;
        Fs.writeFileSync(target, "old", { mode: 0o600 });
        Fs.writeFileSync(backup, "earlier", { mode: 0o600 });
        const expectedRevision = workspaceFileRevisionForStat(
            "openclaw-config",
            ["openclaw.json"],
            Fs.statSync(target, { bigint: true })
        );
        Fs.writeFileSync(target, "concurrent", { mode: 0o600 });
        const spoolId = "67676767-6767-4767-8767-676767676767";
        const writer = createDescriptorWorkspaceFileStructuralWriter({
            roots: [reviewedOpenClawRoot(root)],
            spoolRoot: spool,
        });
        writers.push(writer);

        expect(
            await captureFailure(() =>
                writer.apply({
                    expectedRevision,
                    fileName: "openclaw.json",
                    locator: {
                        rootId: "openclaw-config",
                        segments: ["openclaw.json"],
                    },
                    mimeType: "application/json",
                    operation: "replace",
                    sha256: stageUpload(spool, spoolId, "replacement"),
                    sizeBytes: 11,
                    spoolId,
                    ticketId: "68686868-6868-4868-8868-686868686868",
                })
            )
        ).toMatchObject({ reason: "conflict" });
        expect(Fs.readFileSync(target, "utf8")).toBe("concurrent");
        expect(Fs.readFileSync(backup, "utf8")).toBe("earlier");
    });

    test("rejects an oversized reviewed target before staging or backup", async () => {
        const parent = Fs.mkdtempSync(
            Path.join(Os.tmpdir(), "mira-openclaw-oversized-target-")
        );
        const root = Path.join(parent, "openclaw");
        const spool = Path.join(parent, "spool");
        Fs.mkdirSync(root, { mode: 0o700 });
        Fs.mkdirSync(spool, { mode: 0o700 });
        directories.push(parent);
        const target = Path.join(root, "openclaw.json");
        const backup = `${target}.bak`;
        Fs.writeFileSync(
            target,
            Buffer.alloc(workspaceFileLimits.maximumManifestFileBytes + 1, 0x61),
            { mode: 0o600 }
        );
        Fs.writeFileSync(backup, "earlier", { mode: 0o600 });
        const targetRevision = workspaceFileRevisionForStat(
            "openclaw-config",
            ["openclaw.json"],
            Fs.statSync(target, { bigint: true })
        );
        const backupRevision = workspaceFileRevisionForStat(
            "openclaw-config",
            ["openclaw.json.bak"],
            Fs.statSync(backup, { bigint: true })
        );
        const spoolId = "77777777-7777-4777-8777-777777777777";
        const writer = createDescriptorWorkspaceFileStructuralWriter({
            roots: [reviewedOpenClawRoot(root)],
            spoolRoot: spool,
        });
        writers.push(writer);

        expect(
            await captureFailure(() =>
                writer.apply({
                    expectedRevision: targetRevision,
                    fileName: "openclaw.json",
                    locator: {
                        rootId: "openclaw-config",
                        segments: ["openclaw.json"],
                    },
                    mimeType: "application/json",
                    operation: "replace",
                    sha256: stageUpload(spool, spoolId, "replacement"),
                    sizeBytes: 11,
                    spoolId,
                    ticketId: "78787878-7878-4878-8878-787878787878",
                })
            )
        ).toMatchObject({ reason: "too-large" });
        expect(
            workspaceFileRevisionForStat(
                "openclaw-config",
                ["openclaw.json"],
                Fs.statSync(target, { bigint: true })
            )
        ).toBe(targetRevision);
        expect(
            workspaceFileRevisionForStat(
                "openclaw-config",
                ["openclaw.json.bak"],
                Fs.statSync(backup, { bigint: true })
            )
        ).toBe(backupRevision);
        expect(Fs.readFileSync(backup, "utf8")).toBe("earlier");
        expect(Fs.existsSync(Path.join(root, `.mira-files-${spoolId}.stage`))).toBe(
            false
        );
        expect(Fs.existsSync(Path.join(spool, `${spoolId}.replace-intent`))).toBe(false);
    });

    test("rejects an unsafe reviewed backup before replacing its target", async () => {
        const parent = Fs.mkdtempSync(Path.join(Os.tmpdir(), "mira-openclaw-backup-"));
        const root = Path.join(parent, "openclaw");
        const spool = Path.join(parent, "spool");
        const external = Path.join(parent, "external-secret");
        Fs.mkdirSync(root, { mode: 0o700 });
        Fs.mkdirSync(spool, { mode: 0o700 });
        directories.push(parent);
        const target = Path.join(root, "openclaw.json");
        Fs.writeFileSync(target, "old", { mode: 0o600 });
        Fs.writeFileSync(external, "external", { mode: 0o600 });
        Fs.symlinkSync(external, `${target}.bak`);
        const spoolId = "69696969-6969-4969-8969-696969696969";
        const writer = createDescriptorWorkspaceFileStructuralWriter({
            roots: [reviewedOpenClawRoot(root)],
            spoolRoot: spool,
        });
        writers.push(writer);

        expect(
            await captureFailure(() =>
                writer.apply({
                    expectedRevision: workspaceFileRevisionForStat(
                        "openclaw-config",
                        ["openclaw.json"],
                        Fs.statSync(target, { bigint: true })
                    ),
                    fileName: "openclaw.json",
                    locator: {
                        rootId: "openclaw-config",
                        segments: ["openclaw.json"],
                    },
                    mimeType: "application/json",
                    operation: "replace",
                    sha256: stageUpload(spool, spoolId, "replacement"),
                    sizeBytes: 11,
                    spoolId,
                    ticketId: "70707070-7070-4070-8070-707070707070",
                })
            )
        ).toMatchObject({ reason: "access-denied" });
        expect(Fs.readFileSync(target, "utf8")).toBe("old");
        expect(Fs.readFileSync(external, "utf8")).toBe("external");
        expect(Fs.lstatSync(`${target}.bak`).isSymbolicLink()).toBe(true);
    });

    test("recovers a reviewed backup after the target exchange window", async () => {
        const parent = Fs.mkdtempSync(
            Path.join(Os.tmpdir(), "mira-openclaw-exchange-recovery-")
        );
        const root = Path.join(parent, "openclaw");
        const spool = Path.join(parent, "spool");
        Fs.mkdirSync(root, { mode: 0o700 });
        Fs.mkdirSync(spool, { mode: 0o700 });
        directories.push(parent);
        const target = Path.join(root, "openclaw.json");
        Fs.writeFileSync(target, "old", { mode: 0o600 });
        Fs.writeFileSync(`${target}.bak`, "earlier", { mode: 0o600 });
        const spoolId = "71717171-7171-4171-8171-717171717171";
        const command: WorkerWorkspaceFileWriteCommand = {
            expectedRevision: workspaceFileRevisionForStat(
                "openclaw-config",
                ["openclaw.json"],
                Fs.statSync(target, { bigint: true })
            ),
            fileName: "openclaw.json",
            locator: {
                rootId: "openclaw-config",
                segments: ["openclaw.json"],
            },
            mimeType: "application/json",
            operation: "replace",
            sha256: stageUpload(spool, spoolId, "replacement"),
            sizeBytes: 11,
            spoolId,
            ticketId: "72727272-7272-4272-8272-727272727272",
        };
        let exchangeCount = 0;
        const observedExchange = (
            directoryFd: number,
            leftName: string,
            rightName: string
        ): void => {
            exchangeCount += 1;
            linuxRenameExchange(directoryFd, leftName, rightName);
            if (exchangeCount === 1) {
                throw Object.assign(new Error("injected post-exchange crash"), {
                    code: "EIO",
                });
            }
        };
        const interruptedWriter = createDescriptorWorkspaceFileStructuralWriter({
            renameExchange: observedExchange,
            roots: [reviewedOpenClawRoot(root)],
            spoolRoot: spool,
        });
        writers.push(interruptedWriter);

        expect(
            await captureFailure(() => interruptedWriter.apply(command))
        ).toMatchObject({ reason: "unavailable" });
        expect(Fs.readFileSync(target, "utf8")).toBe("replacement");
        expect(Fs.readFileSync(`${target}.bak`, "utf8")).toBe("earlier");
        interruptedWriter.dispose();
        writers.splice(writers.indexOf(interruptedWriter), 1);
        const recoveredWriter = createDescriptorWorkspaceFileStructuralWriter({
            renameExchange: observedExchange,
            roots: [reviewedOpenClawRoot(root)],
            spoolRoot: spool,
        });
        writers.push(recoveredWriter);

        await recoveredWriter.apply(command);
        expect(exchangeCount).toBe(1);
        expect(Fs.readFileSync(target, "utf8")).toBe("replacement");
        expect(Fs.readFileSync(`${target}.bak`, "utf8")).toBe("old");
    });

    test("preserves recovery state when a reviewed backup becomes unsafe", async () => {
        const parent = Fs.mkdtempSync(
            Path.join(Os.tmpdir(), "mira-openclaw-unsafe-backup-recovery-")
        );
        const root = Path.join(parent, "openclaw");
        const spool = Path.join(parent, "spool");
        Fs.mkdirSync(root, { mode: 0o700 });
        Fs.mkdirSync(spool, { mode: 0o700 });
        directories.push(parent);
        const target = Path.join(root, "openclaw.json");
        Fs.writeFileSync(target, "old", { mode: 0o600 });
        const spoolId = "75757575-7575-4575-8575-757575757575";
        const command: WorkerWorkspaceFileWriteCommand = {
            expectedRevision: workspaceFileRevisionForStat(
                "openclaw-config",
                ["openclaw.json"],
                Fs.statSync(target, { bigint: true })
            ),
            fileName: "openclaw.json",
            locator: {
                rootId: "openclaw-config",
                segments: ["openclaw.json"],
            },
            mimeType: "application/json",
            operation: "replace",
            sha256: stageUpload(spool, spoolId, "replacement"),
            sizeBytes: 11,
            spoolId,
            ticketId: "76767676-7676-4676-8676-767676767676",
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
            roots: [reviewedOpenClawRoot(root)],
            spoolRoot: spool,
        });
        writers.push(interruptedWriter);

        expect(
            await captureFailure(() => interruptedWriter.apply(command))
        ).toMatchObject({ reason: "unavailable" });
        const stage = Path.join(root, `.mira-files-${spoolId}.stage`);
        const intent = Path.join(spool, `${spoolId}.replace-intent`);
        expect(Fs.readFileSync(target, "utf8")).toBe("replacement");
        expect(Fs.readFileSync(stage, "utf8")).toBe("old");
        expect(Fs.existsSync(intent)).toBe(true);
        interruptedWriter.dispose();
        writers.splice(writers.indexOf(interruptedWriter), 1);

        const external = Path.join(parent, "external");
        Fs.writeFileSync(external, "external", { mode: 0o600 });
        Fs.symlinkSync(external, `${target}.bak`);
        const recoveredWriter = createDescriptorWorkspaceFileStructuralWriter({
            roots: [reviewedOpenClawRoot(root)],
            spoolRoot: spool,
        });
        writers.push(recoveredWriter);

        expect(await captureFailure(() => recoveredWriter.apply(command))).toMatchObject({
            reason: "access-denied",
        });
        expect(Fs.readFileSync(target, "utf8")).toBe("replacement");
        expect(Fs.readFileSync(stage, "utf8")).toBe("old");
        expect(Fs.readFileSync(external, "utf8")).toBe("external");
        expect(Fs.lstatSync(`${target}.bak`).isSymbolicLink()).toBe(true);
        expect(Fs.existsSync(intent)).toBe(true);
    });

    test("recovers idempotently after the reviewed backup publish window", async () => {
        const parent = Fs.mkdtempSync(
            Path.join(Os.tmpdir(), "mira-openclaw-backup-recovery-")
        );
        const root = Path.join(parent, "openclaw");
        const spool = Path.join(parent, "spool");
        Fs.mkdirSync(root, { mode: 0o700 });
        Fs.mkdirSync(spool, { mode: 0o700 });
        directories.push(parent);
        const target = Path.join(root, "openclaw.json");
        Fs.writeFileSync(target, "old", { mode: 0o600 });
        Fs.writeFileSync(`${target}.bak`, "earlier", { mode: 0o600 });
        const spoolId = "73737373-7373-4373-8373-737373737373";
        const command: WorkerWorkspaceFileWriteCommand = {
            expectedRevision: workspaceFileRevisionForStat(
                "openclaw-config",
                ["openclaw.json"],
                Fs.statSync(target, { bigint: true })
            ),
            fileName: "openclaw.json",
            locator: {
                rootId: "openclaw-config",
                segments: ["openclaw.json"],
            },
            mimeType: "application/json",
            operation: "replace",
            sha256: stageUpload(spool, spoolId, "replacement"),
            sizeBytes: 11,
            spoolId,
            ticketId: "74747474-7474-4474-8474-747474747474",
        };
        let replaceCount = 0;
        let injectFailure = true;
        const observedReplace = (
            directoryFd: number,
            leftName: string,
            rightName: string
        ): void => {
            replaceCount += 1;
            linuxRenameReplace(directoryFd, leftName, rightName);
            if (injectFailure) {
                injectFailure = false;
                throw Object.assign(new Error("injected post-backup crash"), {
                    code: "EIO",
                });
            }
        };
        const interruptedWriter = createDescriptorWorkspaceFileStructuralWriter({
            renameReplace: observedReplace,
            roots: [reviewedOpenClawRoot(root)],
            spoolRoot: spool,
        });
        writers.push(interruptedWriter);

        expect(
            await captureFailure(() => interruptedWriter.apply(command))
        ).toMatchObject({ reason: "unavailable" });
        expect(Fs.readFileSync(target, "utf8")).toBe("replacement");
        expect(Fs.readFileSync(`${target}.bak`, "utf8")).toBe("old");
        interruptedWriter.dispose();
        writers.splice(writers.indexOf(interruptedWriter), 1);
        const targetHardlink = Path.join(root, "replacement-hardlink");
        Fs.linkSync(target, targetHardlink);
        const recoveredWriter = createDescriptorWorkspaceFileStructuralWriter({
            renameReplace: observedReplace,
            roots: [reviewedOpenClawRoot(root)],
            spoolRoot: spool,
        });
        writers.push(recoveredWriter);

        expect(await captureFailure(() => recoveredWriter.apply(command))).toMatchObject({
            reason: "access-denied",
        });
        expect(Fs.existsSync(Path.join(spool, `${spoolId}.replace-intent`))).toBe(true);
        Fs.unlinkSync(targetHardlink);
        fsyncDirectory(root);
        await recoveredWriter.apply(command);
        expect(replaceCount).toBe(1);
        expect(Fs.readFileSync(target, "utf8")).toBe("replacement");
        expect(Fs.readFileSync(`${target}.bak`, "utf8")).toBe("old");
    });

    test("rolls back a reviewed replacement when the target changes after CAS", async () => {
        const parent = Fs.mkdtempSync(Path.join(Os.tmpdir(), "mira-openclaw-cas-race-"));
        const root = Path.join(parent, "openclaw");
        const spool = Path.join(parent, "spool");
        Fs.mkdirSync(root, { mode: 0o700 });
        Fs.mkdirSync(spool, { mode: 0o700 });
        directories.push(parent);
        const target = Path.join(root, "openclaw.json");
        const backup = `${target}.bak`;
        Fs.writeFileSync(target, "old", { mode: 0o600 });
        Fs.writeFileSync(backup, "earlier", { mode: 0o600 });
        const expectedRevision = workspaceFileRevisionForStat(
            "openclaw-config",
            ["openclaw.json"],
            Fs.statSync(target, { bigint: true })
        );
        const backupRevision = workspaceFileRevisionForStat(
            "openclaw-config",
            ["openclaw.json.bak"],
            Fs.statSync(backup, { bigint: true })
        );
        let exchangeCount = 0;
        const writer = createDescriptorWorkspaceFileStructuralWriter({
            renameExchange(directoryFd, leftName, rightName) {
                exchangeCount += 1;
                if (exchangeCount === 1) {
                    Fs.writeFileSync(target, "concurrent");
                }
                linuxRenameExchange(directoryFd, leftName, rightName);
            },
            roots: [reviewedOpenClawRoot(root)],
            spoolRoot: spool,
        });
        writers.push(writer);
        const spoolId = "81818181-8181-4181-8181-818181818181";

        expect(
            await captureFailure(() =>
                writer.apply({
                    expectedRevision,
                    fileName: "openclaw.json",
                    locator: {
                        rootId: "openclaw-config",
                        segments: ["openclaw.json"],
                    },
                    mimeType: "application/json",
                    operation: "replace",
                    sha256: stageUpload(spool, spoolId, "replacement"),
                    sizeBytes: 11,
                    spoolId,
                    ticketId: "82828282-8282-4282-8282-828282828282",
                })
            )
        ).toMatchObject({ reason: "conflict" });
        expect(exchangeCount).toBe(2);
        expect(Fs.readFileSync(target, "utf8")).toBe("concurrent");
        expect(Fs.readFileSync(backup, "utf8")).toBe("earlier");
        expect(
            workspaceFileRevisionForStat(
                "openclaw-config",
                ["openclaw.json.bak"],
                Fs.statSync(backup, { bigint: true })
            )
        ).toBe(backupRevision);
        expect(Fs.existsSync(Path.join(spool, `${spoolId}.replace-intent`))).toBe(false);
        expect(
            Fs.readdirSync(root).filter((name) => name.startsWith(".mira-files-"))
        ).toHaveLength(0);
    });

    test("rolls back an unsafe reviewed target that changes after CAS", async () => {
        const parent = Fs.mkdtempSync(
            Path.join(Os.tmpdir(), "mira-openclaw-unsafe-cas-race-")
        );
        const root = Path.join(parent, "openclaw");
        const spool = Path.join(parent, "spool");
        Fs.mkdirSync(root, { mode: 0o700 });
        Fs.mkdirSync(spool, { mode: 0o700 });
        directories.push(parent);
        const target = Path.join(root, "openclaw.json");
        const backup = `${target}.bak`;
        Fs.writeFileSync(target, "old", { mode: 0o600 });
        Fs.writeFileSync(backup, "earlier", { mode: 0o600 });
        const expectedRevision = workspaceFileRevisionForStat(
            "openclaw-config",
            ["openclaw.json"],
            Fs.statSync(target, { bigint: true })
        );
        const backupRevision = workspaceFileRevisionForStat(
            "openclaw-config",
            ["openclaw.json.bak"],
            Fs.statSync(backup, { bigint: true })
        );
        let exchangeCount = 0;
        const writer = createDescriptorWorkspaceFileStructuralWriter({
            renameExchange(directoryFd, leftName, rightName) {
                exchangeCount += 1;
                if (exchangeCount === 1) Fs.chmodSync(target, 0o666);
                linuxRenameExchange(directoryFd, leftName, rightName);
            },
            roots: [reviewedOpenClawRoot(root)],
            spoolRoot: spool,
        });
        writers.push(writer);
        const spoolId = "85858585-8585-4585-8585-858585858585";

        expect(
            await captureFailure(() =>
                writer.apply({
                    expectedRevision,
                    fileName: "openclaw.json",
                    locator: {
                        rootId: "openclaw-config",
                        segments: ["openclaw.json"],
                    },
                    mimeType: "application/json",
                    operation: "replace",
                    sha256: stageUpload(spool, spoolId, "replacement"),
                    sizeBytes: 11,
                    spoolId,
                    ticketId: "86868686-8686-4686-8686-868686868686",
                })
            )
        ).toMatchObject({ reason: "access-denied" });
        expect(exchangeCount).toBe(2);
        expect(Fs.readFileSync(target, "utf8")).toBe("old");
        expect(Fs.statSync(target).mode & 0o777).toBe(0o666);
        expect(Fs.readFileSync(backup, "utf8")).toBe("earlier");
        expect(
            workspaceFileRevisionForStat(
                "openclaw-config",
                ["openclaw.json.bak"],
                Fs.statSync(backup, { bigint: true })
            )
        ).toBe(backupRevision);
        expect(Fs.existsSync(Path.join(spool, `${spoolId}.replace-intent`))).toBe(false);
        expect(
            Fs.readdirSync(root).filter((name) => name.startsWith(".mira-files-"))
        ).toHaveLength(0);
    });

    test("rolls back reviewed targets that cannot be inspected after exchange", async () => {
        for (const scenario of [
            "symbolic",
            "oversized",
            "hardlinked",
            "directory",
        ] as const) {
            const parent = Fs.mkdtempSync(
                Path.join(Os.tmpdir(), `mira-openclaw-${scenario}-race-`)
            );
            const root = Path.join(parent, "openclaw");
            const spool = Path.join(parent, "spool");
            Fs.mkdirSync(root, { mode: 0o700 });
            Fs.mkdirSync(spool, { mode: 0o700 });
            directories.push(parent);
            const target = Path.join(root, "openclaw.json");
            const backup = `${target}.bak`;
            const concurrent = Path.join(root, "concurrent.json");
            Fs.writeFileSync(target, "old", { mode: 0o600 });
            Fs.writeFileSync(backup, "earlier", { mode: 0o600 });
            if (scenario === "symbolic" || scenario === "hardlinked") {
                Fs.writeFileSync(concurrent, "concurrent", { mode: 0o600 });
            } else if (scenario === "oversized") {
                Fs.writeFileSync(concurrent, "", { mode: 0o600 });
                Fs.truncateSync(concurrent, workspaceFileLimits.maximumDownloadBytes + 1);
            } else {
                Fs.mkdirSync(concurrent, { mode: 0o700 });
            }
            const expectedRevision = workspaceFileRevisionForStat(
                "openclaw-config",
                ["openclaw.json"],
                Fs.statSync(target, { bigint: true })
            );
            let exchangeCount = 0;
            const writer = createDescriptorWorkspaceFileStructuralWriter({
                renameExchange(directoryFd, leftName, rightName) {
                    exchangeCount += 1;
                    if (exchangeCount === 1) {
                        Fs.unlinkSync(target);
                        if (scenario === "symbolic") {
                            Fs.symlinkSync(Path.basename(concurrent), target);
                        } else if (scenario === "hardlinked") {
                            Fs.linkSync(concurrent, target);
                        } else {
                            Fs.renameSync(concurrent, target);
                        }
                    }
                    linuxRenameExchange(directoryFd, leftName, rightName);
                },
                roots: [reviewedOpenClawRoot(root)],
                spoolRoot: spool,
            });
            writers.push(writer);
            const spoolId = randomUUID();

            expect(
                await captureFailure(() =>
                    writer.apply({
                        expectedRevision,
                        fileName: "openclaw.json",
                        locator: {
                            rootId: "openclaw-config",
                            segments: ["openclaw.json"],
                        },
                        mimeType: "application/json",
                        operation: "replace",
                        sha256: stageUpload(spool, spoolId, "replacement"),
                        sizeBytes: 11,
                        spoolId,
                        ticketId: randomUUID(),
                    })
                )
            ).toMatchObject({
                reason: scenario === "oversized" ? "too-large" : "access-denied",
            });
            expect(exchangeCount).toBe(2);
            if (scenario === "symbolic") {
                expect(Fs.readlinkSync(target)).toBe(Path.basename(concurrent));
            } else if (scenario === "oversized") {
                expect(Fs.statSync(target).size).toBe(
                    workspaceFileLimits.maximumDownloadBytes + 1
                );
            } else if (scenario === "hardlinked") {
                expect(Fs.statSync(target).nlink).toBe(2);
                expect(Fs.readFileSync(target, "utf8")).toBe("concurrent");
            } else {
                expect(Fs.statSync(target).isDirectory()).toBe(true);
            }
            expect(Fs.readFileSync(backup, "utf8")).toBe("earlier");
            expect(Fs.existsSync(Path.join(spool, `${spoolId}.replace-intent`))).toBe(
                false
            );
            expect(
                Fs.readdirSync(root).filter((name) => name.startsWith(".mira-files-"))
            ).toHaveLength(0);
        }
    });

    test("rolls back a reviewed replacement after an atomic target rename", async () => {
        const parent = Fs.mkdtempSync(
            Path.join(Os.tmpdir(), "mira-openclaw-rename-race-")
        );
        const root = Path.join(parent, "openclaw");
        const spool = Path.join(parent, "spool");
        Fs.mkdirSync(root, { mode: 0o700 });
        Fs.mkdirSync(spool, { mode: 0o700 });
        directories.push(parent);
        const target = Path.join(root, "openclaw.json");
        const backup = `${target}.bak`;
        const concurrent = Path.join(root, "concurrent.json");
        Fs.writeFileSync(target, "old", { mode: 0o600 });
        Fs.writeFileSync(backup, "earlier", { mode: 0o600 });
        Fs.writeFileSync(concurrent, "concurrent", { mode: 0o600 });
        const expectedRevision = workspaceFileRevisionForStat(
            "openclaw-config",
            ["openclaw.json"],
            Fs.statSync(target, { bigint: true })
        );
        const backupRevision = workspaceFileRevisionForStat(
            "openclaw-config",
            ["openclaw.json.bak"],
            Fs.statSync(backup, { bigint: true })
        );
        let exchangeCount = 0;
        const writer = createDescriptorWorkspaceFileStructuralWriter({
            renameExchange(directoryFd, leftName, rightName) {
                exchangeCount += 1;
                if (exchangeCount === 1) Fs.renameSync(concurrent, target);
                linuxRenameExchange(directoryFd, leftName, rightName);
            },
            roots: [reviewedOpenClawRoot(root)],
            spoolRoot: spool,
        });
        writers.push(writer);
        const spoolId = "83838383-8383-4383-8383-838383838383";

        expect(
            await captureFailure(() =>
                writer.apply({
                    expectedRevision,
                    fileName: "openclaw.json",
                    locator: {
                        rootId: "openclaw-config",
                        segments: ["openclaw.json"],
                    },
                    mimeType: "application/json",
                    operation: "replace",
                    sha256: stageUpload(spool, spoolId, "replacement"),
                    sizeBytes: 11,
                    spoolId,
                    ticketId: "84848484-8484-4484-8484-848484848484",
                })
            )
        ).toMatchObject({ reason: "conflict" });
        expect(exchangeCount).toBe(2);
        expect(Fs.readFileSync(target, "utf8")).toBe("concurrent");
        expect(Fs.statSync(target).mode & 0o777).toBe(0o600);
        expect(Fs.readFileSync(backup, "utf8")).toBe("earlier");
        expect(
            workspaceFileRevisionForStat(
                "openclaw-config",
                ["openclaw.json.bak"],
                Fs.statSync(backup, { bigint: true })
            )
        ).toBe(backupRevision);
        expect(Fs.existsSync(Path.join(spool, `${spoolId}.replace-intent`))).toBe(false);
        expect(
            Fs.readdirSync(root).filter((name) => name.startsWith(".mira-files-"))
        ).toHaveLength(0);
    });

    test("settles a reviewed conflict after a crash following rollback fsync", async () => {
        const parent = Fs.mkdtempSync(
            Path.join(Os.tmpdir(), "mira-openclaw-rollback-recovery-")
        );
        const root = Path.join(parent, "openclaw");
        const spool = Path.join(parent, "spool");
        Fs.mkdirSync(root, { mode: 0o700 });
        Fs.mkdirSync(spool, { mode: 0o700 });
        directories.push(parent);
        const target = Path.join(root, "openclaw.json");
        const backup = `${target}.bak`;
        Fs.writeFileSync(target, "old", { mode: 0o600 });
        Fs.writeFileSync(backup, "earlier", { mode: 0o600 });
        const spoolId = "87878787-8787-4787-8787-878787878787";
        const command: WorkerWorkspaceFileWriteCommand = {
            expectedRevision: workspaceFileRevisionForStat(
                "openclaw-config",
                ["openclaw.json"],
                Fs.statSync(target, { bigint: true })
            ),
            fileName: "openclaw.json",
            locator: {
                rootId: "openclaw-config",
                segments: ["openclaw.json"],
            },
            mimeType: "application/json",
            operation: "replace",
            sha256: stageUpload(spool, spoolId, "replacement"),
            sizeBytes: 11,
            spoolId,
            ticketId: "88888888-8888-4888-8888-888888888888",
        };
        let exchangeCount = 0;
        const interruptedWriter = createDescriptorWorkspaceFileStructuralWriter({
            renameExchange(directoryFd, leftName, rightName) {
                exchangeCount += 1;
                if (exchangeCount === 1) Fs.writeFileSync(target, "concurrent");
                linuxRenameExchange(directoryFd, leftName, rightName);
                if (exchangeCount === 2) {
                    Fs.fsyncSync(directoryFd);
                    throw Object.assign(new Error("injected post-rollback crash"), {
                        code: "EIO",
                    });
                }
            },
            roots: [reviewedOpenClawRoot(root)],
            spoolRoot: spool,
        });
        writers.push(interruptedWriter);

        expect(
            await captureFailure(() => interruptedWriter.apply(command))
        ).toMatchObject({ reason: "unavailable" });
        expect(exchangeCount).toBe(2);
        expect(Fs.readFileSync(target, "utf8")).toBe("concurrent");
        expect(Fs.readFileSync(backup, "utf8")).toBe("earlier");
        expect(Fs.existsSync(Path.join(spool, `${spoolId}.replace-intent`))).toBe(true);
        expect(
            Fs.readdirSync(root).filter((name) => name.startsWith(".mira-files-"))
        ).toHaveLength(1);

        interruptedWriter.dispose();
        writers.splice(writers.indexOf(interruptedWriter), 1);
        const recoveredWriter = createDescriptorWorkspaceFileStructuralWriter({
            roots: [reviewedOpenClawRoot(root)],
            spoolRoot: spool,
        });
        writers.push(recoveredWriter);

        expect(await captureFailure(() => recoveredWriter.apply(command))).toMatchObject({
            reason: "conflict",
        });
        expect(Fs.readFileSync(target, "utf8")).toBe("concurrent");
        expect(Fs.readFileSync(backup, "utf8")).toBe("earlier");
        expect(Fs.existsSync(Path.join(spool, `${spoolId}.replace-intent`))).toBe(false);
        expect(
            Fs.readdirSync(root).filter((name) => name.startsWith(".mira-files-"))
        ).toHaveLength(0);
    });

    test("settles an uninspectable reviewed target after a rollback crash", async () => {
        for (const removeStageBeforeRecovery of [false, true]) {
            const parent = Fs.mkdtempSync(
                Path.join(Os.tmpdir(), "mira-openclaw-unsafe-rollback-recovery-")
            );
            const root = Path.join(parent, "openclaw");
            const spool = Path.join(parent, "spool");
            Fs.mkdirSync(root, { mode: 0o700 });
            Fs.mkdirSync(spool, { mode: 0o700 });
            directories.push(parent);
            const target = Path.join(root, "openclaw.json");
            const backup = `${target}.bak`;
            const concurrent = Path.join(root, "concurrent.json");
            Fs.writeFileSync(target, "old", { mode: 0o600 });
            Fs.writeFileSync(backup, "earlier", { mode: 0o600 });
            Fs.writeFileSync(concurrent, "concurrent", { mode: 0o600 });
            const spoolId = randomUUID();
            const command: WorkerWorkspaceFileWriteCommand = {
                expectedRevision: workspaceFileRevisionForStat(
                    "openclaw-config",
                    ["openclaw.json"],
                    Fs.statSync(target, { bigint: true })
                ),
                fileName: "openclaw.json",
                locator: {
                    rootId: "openclaw-config",
                    segments: ["openclaw.json"],
                },
                mimeType: "application/json",
                operation: "replace",
                sha256: stageUpload(spool, spoolId, "replacement"),
                sizeBytes: 11,
                spoolId,
                ticketId: randomUUID(),
            };
            let exchangeCount = 0;
            const interruptedWriter = createDescriptorWorkspaceFileStructuralWriter({
                renameExchange(directoryFd, leftName, rightName) {
                    exchangeCount += 1;
                    if (exchangeCount === 1) {
                        Fs.unlinkSync(target);
                        Fs.symlinkSync(Path.basename(concurrent), target);
                    }
                    linuxRenameExchange(directoryFd, leftName, rightName);
                    if (exchangeCount === 2) {
                        Fs.fsyncSync(directoryFd);
                        throw Object.assign(new Error("injected post-rollback crash"), {
                            code: "EIO",
                        });
                    }
                },
                roots: [reviewedOpenClawRoot(root)],
                spoolRoot: spool,
            });
            writers.push(interruptedWriter);

            expect(
                await captureFailure(() => interruptedWriter.apply(command))
            ).toMatchObject({ reason: "unavailable" });
            expect(exchangeCount).toBe(2);
            if (removeStageBeforeRecovery) {
                const temporaryName = Fs.readdirSync(root).find((name) =>
                    name.startsWith(".mira-files-")
                );
                expect(temporaryName).toBeDefined();
                Fs.unlinkSync(Path.join(root, temporaryName!));
            }

            interruptedWriter.dispose();
            writers.splice(writers.indexOf(interruptedWriter), 1);
            const recoveredWriter = createDescriptorWorkspaceFileStructuralWriter({
                roots: [reviewedOpenClawRoot(root)],
                spoolRoot: spool,
            });
            writers.push(recoveredWriter);

            expect(
                await captureFailure(() => recoveredWriter.apply(command))
            ).toMatchObject({ reason: "access-denied" });
            expect(Fs.readlinkSync(target)).toBe(Path.basename(concurrent));
            expect(Fs.readFileSync(backup, "utf8")).toBe("earlier");
            expect(Fs.existsSync(Path.join(spool, `${spoolId}.replace-intent`))).toBe(
                false
            );
            expect(
                Fs.readdirSync(root).filter((name) => name.startsWith(".mira-files-"))
            ).toHaveLength(0);
        }
    });

    test("settles a reviewed conflict after rollback stage cleanup", async () => {
        const parent = Fs.mkdtempSync(
            Path.join(Os.tmpdir(), "mira-openclaw-rollback-cleanup-")
        );
        const root = Path.join(parent, "openclaw");
        const spool = Path.join(parent, "spool");
        Fs.mkdirSync(root, { mode: 0o700 });
        Fs.mkdirSync(spool, { mode: 0o700 });
        directories.push(parent);
        const target = Path.join(root, "openclaw.json");
        const backup = `${target}.bak`;
        Fs.writeFileSync(target, "old", { mode: 0o600 });
        Fs.writeFileSync(backup, "earlier", { mode: 0o600 });
        const spoolId = "89898989-8989-4989-8989-898989898989";
        const command: WorkerWorkspaceFileWriteCommand = {
            expectedRevision: workspaceFileRevisionForStat(
                "openclaw-config",
                ["openclaw.json"],
                Fs.statSync(target, { bigint: true })
            ),
            fileName: "openclaw.json",
            locator: {
                rootId: "openclaw-config",
                segments: ["openclaw.json"],
            },
            mimeType: "application/json",
            operation: "replace",
            sha256: stageUpload(spool, spoolId, "replacement"),
            sizeBytes: 11,
            spoolId,
            ticketId: "90909090-9090-4090-9090-909090909090",
        };
        let exchangeCount = 0;
        const interruptedWriter = createDescriptorWorkspaceFileStructuralWriter({
            renameExchange(directoryFd, leftName, rightName) {
                exchangeCount += 1;
                if (exchangeCount === 1) Fs.writeFileSync(target, "concurrent");
                linuxRenameExchange(directoryFd, leftName, rightName);
                if (exchangeCount === 2) {
                    Fs.fsyncSync(directoryFd);
                    throw Object.assign(new Error("injected post-rollback crash"), {
                        code: "EIO",
                    });
                }
            },
            roots: [reviewedOpenClawRoot(root)],
            spoolRoot: spool,
        });
        writers.push(interruptedWriter);

        expect(
            await captureFailure(() => interruptedWriter.apply(command))
        ).toMatchObject({ reason: "unavailable" });
        const temporaryName = Fs.readdirSync(root).find((name) =>
            name.startsWith(".mira-files-")
        );
        expect(temporaryName).toBeDefined();
        Fs.unlinkSync(Path.join(root, temporaryName!));

        interruptedWriter.dispose();
        writers.splice(writers.indexOf(interruptedWriter), 1);
        const recoveredWriter = createDescriptorWorkspaceFileStructuralWriter({
            roots: [reviewedOpenClawRoot(root)],
            spoolRoot: spool,
        });
        writers.push(recoveredWriter);

        expect(await captureFailure(() => recoveredWriter.apply(command))).toMatchObject({
            reason: "conflict",
        });
        expect(Fs.readFileSync(target, "utf8")).toBe("concurrent");
        expect(Fs.readFileSync(backup, "utf8")).toBe("earlier");
        expect(Fs.existsSync(Path.join(spool, `${spoolId}.replace-intent`))).toBe(false);
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

    test("rejects reviewed backup collisions only within the same directory", () => {
        const { root, spool } = fixture();
        for (const replacementManifest of [
            [
                reviewedReplacement(["openclaw.json"], true),
                reviewedReplacement(["openclaw.json.bak"]),
            ],
            [
                reviewedReplacement(["openclaw.json.bak"]),
                reviewedReplacement(["openclaw.json"], true),
            ],
            [
                reviewedReplacement(["hooks", "agentmail.ts"], true),
                reviewedReplacement(["hooks", "agentmail.ts.bak"]),
            ],
        ]) {
            expect(() =>
                createDescriptorWorkspaceFileStructuralWriter({
                    roots: [
                        {
                            id: "openclaw-config",
                            path: root,
                            replacementManifest,
                            writable: true,
                        },
                    ],
                    spoolRoot: spool,
                })
            ).toThrow("metadata");
        }

        const writer = createDescriptorWorkspaceFileStructuralWriter({
            roots: [
                {
                    id: "openclaw-config",
                    path: root,
                    replacementManifest: [
                        reviewedReplacement(["one", "openclaw.json"], true),
                        reviewedReplacement(["two", "openclaw.json.bak"]),
                    ],
                    writable: true,
                },
            ],
            spoolRoot: spool,
        });
        writers.push(writer);
    });

    test("rejects unreviewable root identifiers at composition", () => {
        const { root, spool } = fixture();
        expect(() =>
            createDescriptorWorkspaceFileStructuralWriter({
                roots: [{ id: "../workspace", path: root, writable: true }],
                spoolRoot: spool,
            })
        ).toThrow("metadata");
        expect(() =>
            createDescriptorWorkspaceFileStructuralWriter({
                roots: [
                    {
                        id: "openclaw-config",
                        path: root,
                        replacementManifest: [
                            {
                                backupPolicy: "sibling-dot-bak",
                                maximumSizeBytes:
                                    workspaceFileLimits.maximumManifestFileBytes + 1,
                                segments: ["openclaw.json"],
                            },
                        ],
                        writable: true,
                    },
                ],
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
