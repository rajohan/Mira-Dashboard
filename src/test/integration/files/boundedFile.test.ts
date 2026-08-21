import { expect, test } from "bun:test";
import {
    appendFile,
    mkdir,
    mkdtemp,
    open,
    rename,
    rm,
    symlink,
    truncate,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    type BoundedFileReadTestHooks,
    readBoundedRegularFile,
    readBoundedUtf8RegularFile,
} from "../../../../scripts/files/boundedFile.ts";

const invalidStateMessage = "Fixture has invalid file state";

async function rejectedError(operation: Promise<unknown>): Promise<Error> {
    const result = await operation.catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    return result as Error;
}

function createInitialStatBarrier(): {
    hooks: BoundedFileReadTestHooks;
    reached: Promise<void>;
    release: () => void;
} {
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    return {
        hooks: {
            async afterInitialStat() {
                reached.resolve();
                await release.promise;
            },
        },
        reached: reached.promise,
        release: release.resolve,
    };
}

async function rejectAfterInFlightMutation(
    target: string,
    allowedRoot: string,
    maximumBytes: number,
    mutate: () => Promise<void>
): Promise<Error> {
    const barrier = createInitialStatBarrier();
    const operation = readBoundedRegularFile(
        target,
        allowedRoot,
        maximumBytes,
        invalidStateMessage,
        barrier.hooks
    );
    await barrier.reached;
    try {
        await mutate();
    } finally {
        barrier.release();
    }
    return rejectedError(operation);
}

test("reads an exact bounded regular-file snapshot", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mira-bounded-file-"));
    try {
        const target = path.join(directory, "fixture.json");
        await writeFile(target, "reviewed fixture", "utf8");

        const bytes = await readBoundedRegularFile(
            target,
            directory,
            64,
            invalidStateMessage
        );

        expect(bytes.toString("utf8")).toBe("reviewed fixture");
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});

test("allows a descendant whose first segment begins with two dots", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mira-bounded-file-"));
    try {
        const descendantDirectory = path.join(directory, "..inside");
        const target = path.join(descendantDirectory, "fixture.json");
        await mkdir(descendantDirectory);
        await writeFile(target, "reviewed fixture", "utf8");

        const bytes = await readBoundedRegularFile(
            target,
            directory,
            64,
            invalidStateMessage
        );

        expect(bytes.toString("utf8")).toBe("reviewed fixture");
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});

test("fails closed for leaf and escaping ancestor symlinks, oversized files, and empty files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mira-bounded-file-"));
    try {
        const allowedRoot = path.join(directory, "allowed");
        const outsideRoot = path.join(directory, "outside");
        await mkdir(allowedRoot);
        await mkdir(outsideRoot);
        const target = path.join(allowedRoot, "target.json");
        const empty = path.join(allowedRoot, "empty.json");
        const leafLink = path.join(allowedRoot, "leaf-link.json");
        const ancestorLink = path.join(allowedRoot, "ancestor-link");
        const outsideTarget = path.join(outsideRoot, "outside.json");
        await writeFile(target, "oversized", "utf8");
        await writeFile(empty, "", "utf8");
        await writeFile(outsideTarget, "outside", "utf8");
        await symlink(target, leafLink);
        await symlink(outsideRoot, ancestorLink);

        for (const [filePath, maximumBytes] of [
            [leafLink, 64],
            [path.join(ancestorLink, "outside.json"), 64],
            [target, 4],
            [empty, 64],
        ] as const) {
            const error = await rejectedError(
                readBoundedRegularFile(
                    filePath,
                    allowedRoot,
                    maximumBytes,
                    invalidStateMessage
                )
            );
            expect(error.message).toBe(invalidStateMessage);
            expect(String(error)).not.toContain(filePath);
        }
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});

test("opens FIFOs nonblockingly and redacts the rejected path", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mira-bounded-file-"));
    try {
        const fifo = path.join(directory, "no-writer.fifo");
        const creation = Bun.spawnSync({
            cmd: ["mkfifo", fifo],
            stderr: "pipe",
            stdout: "ignore",
        });
        expect(creation.success).toBeTrue();

        const error = await rejectedError(
            readBoundedRegularFile(fifo, directory, 64, invalidStateMessage)
        );
        expect(error.message).toBe(invalidStateMessage);
        expect(String(error)).not.toContain(fifo);
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
}, 2000);

test("rejects malformed UTF-8 with only the selected message", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mira-bounded-file-"));
    try {
        const target = path.join(directory, "invalid-utf8.json");
        await writeFile(target, Buffer.from([195, 40]));

        const error = await rejectedError(
            readBoundedUtf8RegularFile(
                target,
                directory,
                64,
                invalidStateMessage,
                "Fixture is not valid UTF-8"
            )
        );
        expect(error.message).toBe("Fixture is not valid UTF-8");
        expect(String(error)).not.toContain(target);
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});

test("rejects an in-flight same-inode shrink after the initial stat", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mira-bounded-file-"));
    try {
        const target = path.join(directory, "shrinking.bin");
        await writeFile(target, "reviewed fixture", "utf8");

        const error = await rejectAfterInFlightMutation(target, directory, 64, () =>
            truncate(target, 4)
        );

        expect(error.message).toBe(invalidStateMessage);
        expect(String(error)).not.toContain(target);
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});

test("rejects in-flight growth after the initial stat", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mira-bounded-file-"));
    try {
        const target = path.join(directory, "growing.bin");
        await writeFile(target, "small", "utf8");

        const error = await rejectAfterInFlightMutation(target, directory, 64, () =>
            appendFile(target, " growth", "utf8")
        );

        expect(error.message).toBe(invalidStateMessage);
        expect(String(error)).not.toContain(target);
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});

test("rejects an in-flight same-size overwrite after the initial stat", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mira-bounded-file-"));
    let mutator: Awaited<ReturnType<typeof open>> | undefined;
    try {
        const target = path.join(directory, "mutating.bin");
        await writeFile(target, "before", "utf8");
        const openMutator = await open(target, "r+");
        mutator = openMutator;

        const error = await rejectAfterInFlightMutation(
            target,
            directory,
            64,
            async () => {
                await openMutator.write(Buffer.from("after!"), 0, 6, 0);
                await openMutator.utimes(new Date(0), new Date(0));
                await openMutator.sync();
            }
        );

        expect(error.message).toBe(invalidStateMessage);
        expect(String(error)).not.toContain(target);
        await openMutator.close();
        mutator = undefined;
    } finally {
        await mutator?.close();
        await rm(directory, { force: true, recursive: true });
    }
});

test("rejects requested-path replacement while the original descriptor is held", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mira-bounded-file-"));
    try {
        const target = path.join(directory, "target.bin");
        const replacement = path.join(directory, "replacement.bin");
        await writeFile(target, "original", "utf8");
        await writeFile(replacement, "replaced", "utf8");

        const error = await rejectAfterInFlightMutation(target, directory, 64, () =>
            rename(replacement, target)
        );

        expect(error.message).toBe(invalidStateMessage);
        expect(String(error)).not.toContain(target);
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});
