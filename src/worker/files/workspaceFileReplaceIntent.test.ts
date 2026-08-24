import { afterEach, describe, expect, test } from "bun:test";
import Fs from "node:fs";
import Os from "node:os";
import Path from "node:path";

import { linuxRenameNoReplace } from "./linuxRenameExchange.ts";
import {
    createWorkspaceFileReplaceIntent,
    readWorkspaceFileReplaceIntent,
    removeWorkspaceFileReplaceIntent,
    settleWorkspaceFileReplaceIntent,
    type WorkspaceFileReplaceIntent,
    type WorkspaceFileReplaceIntentStore,
} from "./workspaceFileReplaceIntent.ts";

const directories: string[] = [];
const descriptors: number[] = [];

function fixture(): {
    readonly root: string;
    readonly store: WorkspaceFileReplaceIntentStore;
} {
    const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "mira-files-intent-"));
    Fs.chmodSync(root, 0o700);
    directories.push(root);
    const spoolFd = Fs.openSync(
        root,
        Fs.constants.O_RDONLY | Fs.constants.O_DIRECTORY | Fs.constants.O_NOFOLLOW
    );
    descriptors.push(spoolFd);
    const stat = Fs.fstatSync(spoolFd, { bigint: true });
    return {
        root,
        store: Object.freeze({
            ownerId: BigInt(process.getuid!()),
            renameNoReplace: linuxRenameNoReplace,
            spoolDevice: stat.dev,
            spoolFd,
        }),
    };
}

function intent(spoolId: string): WorkspaceFileReplaceIntent {
    return Object.freeze({
        commandSha256: "a".repeat(64),
        newSha256: "b".repeat(64),
        newSizeBytes: 3,
        old: Object.freeze({
            ctimeNs: "1",
            dev: "2",
            gid: "3",
            ino: "4",
            mode: "33152",
            mtimeNs: "5",
            nlink: "1",
            sha256: "c".repeat(64),
            size: "3",
            uid: "6",
        }),
        stage: Object.freeze({
            dev: "2",
            gid: "3",
            ino: "7",
            mode: "33152",
            nlink: "1",
            uid: "6",
        }),
        stageName: `.mira-files-${spoolId}.stage`,
        target: Object.freeze({
            expectedRevision: "d".repeat(64),
            fileName: "note.txt",
            rootId: "workspace",
            segments: Object.freeze(["note.txt"]),
            ticketId: "11111111-1111-4111-8111-111111111111",
        }),
        version: 1,
    });
}

afterEach(() => {
    for (const fd of descriptors.splice(0)) Fs.closeSync(fd);
    for (const directory of directories.splice(0)) {
        Fs.rmSync(directory, { force: true, recursive: true });
    }
});

describe("workspace file replace intent", () => {
    test("publishes, reads, and quarantines one exact durable intent", async () => {
        const { root, store } = fixture();
        const spoolId = "22222222-2222-4222-8222-222222222222";

        const published = await createWorkspaceFileReplaceIntent(
            store,
            spoolId,
            intent(spoolId)
        );
        const reread = await readWorkspaceFileReplaceIntent(store, spoolId);
        expect(reread?.intent).toEqual(intent(spoolId));
        const settled = await settleWorkspaceFileReplaceIntent(store, spoolId, published);
        expect(settled.state).toBe("settled");
        expect(Fs.existsSync(Path.join(root, `${spoolId}.replace-settled`))).toBe(true);
        await removeWorkspaceFileReplaceIntent(store, spoolId, settled);

        expect(await readWorkspaceFileReplaceIntent(store, spoolId)).toBeUndefined();
        expect(Fs.readdirSync(root)).toEqual([]);
    });

    test("rejects path-shaped ids before touching the private directory", async () => {
        const { root, store } = fixture();
        expect(
            await readWorkspaceFileReplaceIntent(store, "../escape").catch(
                (error: unknown) => error
            )
        ).toBeInstanceOf(TypeError);
        expect(Fs.readdirSync(root)).toEqual([]);
    });

    test("refuses publication above the exact durable intent capacity", async () => {
        const { root, store } = fixture();
        for (let index = 0; index < 256; index += 1) {
            const spoolId = `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
            Fs.writeFileSync(Path.join(root, `${spoolId}.replace-intent`), "{}", {
                mode: 0o600,
            });
        }
        const spoolId = "40000000-0000-4000-8000-000000000000";

        expect(
            await createWorkspaceFileReplaceIntent(store, spoolId, intent(spoolId)).catch(
                (error: unknown) => error
            )
        ).toBeInstanceOf(TypeError);
        expect(Fs.readdirSync(root)).toHaveLength(256);
    });
});
