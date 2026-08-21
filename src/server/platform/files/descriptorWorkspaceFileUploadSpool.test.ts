import { afterEach, describe, expect, test } from "bun:test";
import Fs from "node:fs";
import Os from "node:os";
import Path from "node:path";

import { WorkspaceFileError } from "../../domains/files/errors.ts";
import type { WorkspaceFileUploadSpool } from "../../domains/files/ports.ts";
import { createDescriptorWorkspaceFileUploadSpool } from "./descriptorWorkspaceFileUploadSpool.ts";

const directories: string[] = [];
const spools: WorkspaceFileUploadSpool[] = [];

function fixture(nowMs: () => number = Date.now) {
    const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "mira-files-spool-"));
    directories.push(root);
    const spool = createDescriptorWorkspaceFileUploadSpool(root, { nowMs });
    spools.push(spool);
    return { root, spool };
}

function body(...chunks: string[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks)
                controller.enqueue(new TextEncoder().encode(chunk));
            controller.close();
        },
    });
}

afterEach(async () => {
    for (const spool of spools.splice(0)) {
        const disposal = spool.dispose();
        if (disposal !== undefined) await disposal;
    }
    for (const directory of directories.splice(0)) {
        Fs.rmSync(directory, { force: true, recursive: true });
    }
});

describe("descriptor workspace file upload spool", () => {
    test("streams exact bytes to a server-named private file", async () => {
        const { root, spool } = fixture();
        const spoolId = "11111111-1111-4111-8111-111111111111";
        const receipt = await spool.receive({
            body: body("hello", " world"),
            expectedBytes: 11,
            spoolId,
        });

        expect(receipt).toEqual({
            sha256: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
            sizeBytes: 11,
            spoolId,
        });
        const target = Path.join(root, `${spoolId}.upload`);
        expect(Fs.readFileSync(target, "utf8")).toBe("hello world");
        expect(Fs.statSync(target).mode & 0o777).toBe(0o600);
    });

    test("removes partial bytes when the declared length is not satisfied", async () => {
        const { root, spool } = fixture();
        const spoolId = "22222222-2222-4222-8222-222222222222";
        const caught = await spool
            .receive({ body: body("short"), expectedBytes: 9, spoolId })
            .catch((error: unknown) => error);
        expect(caught).toBeInstanceOf(WorkspaceFileError);
        expect((caught as WorkspaceFileError).reason).toBe("invalid-input");
        expect(Fs.existsSync(Path.join(root, `${spoolId}.upload`))).toBe(false);
    });

    test("rejects duplicate and path-shaped spool identities", async () => {
        const { spool } = fixture();
        const spoolId = "33333333-3333-4333-8333-333333333333";
        await spool.receive({ body: body("x"), expectedBytes: 1, spoolId });
        const duplicate = await spool
            .receive({ body: body("x"), expectedBytes: 1, spoolId })
            .catch((error: unknown) => error);
        expect((duplicate as WorkspaceFileError).reason).toBe("conflict");
        expect(() => spool.discard("../escape")).toThrow();
    });

    test("deletes only the exact server-named spool file", async () => {
        const { root, spool } = fixture();
        const spoolId = "44444444-4444-4444-8444-444444444444";
        await spool.receive({ body: body("x"), expectedBytes: 1, spoolId });
        await spool.discard(spoolId);
        expect(Fs.existsSync(Path.join(root, `${spoolId}.upload`))).toBe(false);
    });

    test("requires a runtime-owned private spool directory", () => {
        const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "mira-files-spool-mode-"));
        directories.push(root);
        Fs.chmodSync(root, 0o755);
        expect(() => createDescriptorWorkspaceFileUploadSpool(root)).toThrow("private");
    });

    test("removes only bounded expired private spool files and reports truncation", async () => {
        const now = 1_800_000_000_000;
        const { root, spool } = fixture(() => now);
        const first = "55555555-5555-4555-8555-555555555555";
        const second = "66666666-6666-4666-8666-666666666666";
        await spool.receive({ body: body("a"), expectedBytes: 1, spoolId: first });
        await spool.receive({ body: body("b"), expectedBytes: 1, spoolId: second });
        const old = new Date(now - 3 * 5 * 60 * 1000);
        Fs.utimesSync(Path.join(root, `${first}.upload`), old, old);
        Fs.utimesSync(Path.join(root, `${second}.upload`), old, old);
        Fs.writeFileSync(Path.join(root, "unrelated"), "keep", { mode: 0o600 });

        const firstSweep = await spool.cleanupOrphans({
            maximumEntries: 1,
            olderThanMs: 5 * 60 * 1000,
        });
        expect(firstSweep).toEqual({ inspected: 1, removed: 1, truncated: true });
        const secondSweep = await spool.cleanupOrphans({
            maximumEntries: 10,
            olderThanMs: 5 * 60 * 1000,
        });
        expect(secondSweep.removed).toBe(1);
        expect(Fs.readFileSync(Path.join(root, "unrelated"), "utf8")).toBe("keep");
    });

    test("preserves exact active spool identities and validates the full set before deletion", async () => {
        const now = 1_800_000_000_000;
        const { root, spool } = fixture(() => now);
        const active = "77777777-7777-4777-8777-777777777777";
        const orphan = "88888888-8888-4888-8888-888888888888";
        for (const spoolId of [active, orphan]) {
            await spool.receive({ body: body("x"), expectedBytes: 1, spoolId });
            const old = new Date(now - 3 * 5 * 60 * 1000);
            Fs.utimesSync(Path.join(root, `${spoolId}.upload`), old, old);
        }

        expect(
            await spool.cleanupOrphans({
                olderThanMs: 5 * 60 * 1000,
                preserveSpoolIds: [active],
            })
        ).toMatchObject({ removed: 1 });
        expect(Fs.existsSync(Path.join(root, `${active}.upload`))).toBe(true);

        expect(
            spool.cleanupOrphans({
                olderThanMs: 5 * 60 * 1000,
                preserveSpoolIds: ["../not-an-id"],
            })
        ).rejects.toMatchObject({ reason: "invalid-input" });
        expect(Fs.existsSync(Path.join(root, `${active}.upload`))).toBe(true);
    });

    test("reclaims bounded replace intents while preserving every active spool id", async () => {
        const now = 1_800_000_000_000;
        const { root, spool } = fixture(() => now);
        const active = "90909090-9090-4090-8090-909090909090";
        const orphan = "91919191-9191-4191-8191-919191919191";
        const temporarySuffix = "92929292-9292-4292-8292-929292929292";
        const activeIntent = Path.join(root, `${active}.replace-settled`);
        const activeTemporary = Path.join(
            root,
            `${active}.replace-intent-${temporarySuffix}.tmp`
        );
        const orphanIntent = Path.join(root, `${orphan}.replace-settled`);
        const pendingIntent = Path.join(root, `${orphan}.replace-intent`);
        for (const path of [activeIntent, activeTemporary, orphanIntent, pendingIntent]) {
            Fs.writeFileSync(path, "{}", { mode: 0o600 });
            const old = new Date(now - 3 * 5 * 60 * 1000);
            Fs.utimesSync(path, old, old);
        }

        expect(
            await spool.cleanupOrphans({
                maximumEntries: 10,
                olderThanMs: 5 * 60 * 1000,
                preserveSpoolIds: [active],
            })
        ).toMatchObject({ removed: 1, truncated: false });
        expect(Fs.existsSync(activeIntent)).toBe(true);
        expect(Fs.existsSync(activeTemporary)).toBe(true);
        expect(Fs.existsSync(orphanIntent)).toBe(false);
        expect(Fs.existsSync(pendingIntent)).toBe(true);
    });

    test("bounds total directory inspection even when entries are not spool files", async () => {
        const { root, spool } = fixture(() => 1_800_000_000_000);
        Fs.writeFileSync(Path.join(root, "unrelated-1"), "keep", { mode: 0o600 });
        Fs.writeFileSync(Path.join(root, "unrelated-2"), "keep", { mode: 0o600 });

        expect(
            await spool.cleanupOrphans({
                maximumEntries: 1,
                olderThanMs: 5 * 60 * 1000,
            })
        ).toEqual({ inspected: 1, removed: 0, truncated: true });
    });

    test("reserves the exact physical entry quota across concurrent receives", async () => {
        const { root, spool } = fixture();
        const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
        const receives = Array.from({ length: 64 }, (_, index) => {
            const spoolId = `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
            return spool.receive({
                body: new ReadableStream<Uint8Array>({
                    start(controller) {
                        controllers.push(controller);
                        controller.enqueue(new Uint8Array([index]));
                    },
                }),
                expectedBytes: 1,
                spoolId,
            });
        });
        for (let attempt = 0; attempt < 100; attempt += 1) {
            if (Fs.readdirSync(root).length === 64) break;
            await Bun.sleep(1);
        }
        expect(Fs.readdirSync(root)).toHaveLength(64);

        expect(
            spool.receive({
                body: body(),
                expectedBytes: 0,
                spoolId: "20000000-0000-4000-8000-000000000000",
            })
        ).rejects.toMatchObject({ reason: "capacity" });

        for (const controller of controllers) controller.close();
        await Promise.all(receives);
    });

    test("reconciles worker deletion and restart accounting", async () => {
        const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "mira-files-spool-restart-"));
        directories.push(root);
        const spoolId = "30000000-0000-4000-8000-000000000000";
        const first = createDescriptorWorkspaceFileUploadSpool(root);
        await first.receive({ body: body("x"), expectedBytes: 1, spoolId });
        await first.dispose();

        const restarted = createDescriptorWorkspaceFileUploadSpool(root);
        spools.push(restarted);
        expect(
            await restarted
                .receive({ body: body("x"), expectedBytes: 1, spoolId })
                .catch((error: unknown) => error)
        ).toMatchObject({ reason: "conflict" });
        Fs.unlinkSync(Path.join(root, `${spoolId}.upload`));
        expect(
            await restarted.receive({ body: body("y"), expectedBytes: 1, spoolId })
        ).toMatchObject({ spoolId });
    });

    test("refuses to start above the exact physical entry quota", () => {
        const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "mira-files-spool-full-"));
        directories.push(root);
        for (let index = 0; index < 65; index += 1) {
            const spoolId = `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
            Fs.writeFileSync(Path.join(root, `${spoolId}.upload`), "", {
                mode: 0o600,
            });
        }
        expect(() => createDescriptorWorkspaceFileUploadSpool(root)).toThrow(
            "entry capacity"
        );
    });

    test("refuses to start above the durable replace-intent entry quota", () => {
        const root = Fs.mkdtempSync(
            Path.join(Os.tmpdir(), "mira-files-spool-intents-full-")
        );
        directories.push(root);
        for (let index = 0; index < 257; index += 1) {
            const spoolId = `50000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
            Fs.writeFileSync(Path.join(root, `${spoolId}.replace-intent`), "{}", {
                mode: 0o600,
            });
        }
        expect(() => createDescriptorWorkspaceFileUploadSpool(root)).toThrow(
            "intent capacity"
        );
    });
});
