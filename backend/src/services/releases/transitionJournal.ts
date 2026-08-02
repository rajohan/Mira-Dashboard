import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { isPlainRecord } from "../../../../contracts/runtime.ts";
import { guardedPath, writeTextNoFollowGuarded } from "../../lib/guardedOps.ts";
import {
    compareStrings,
    type DashboardReleaseLayout,
    MAX_RELEASE_TRANSITION_FILE_BYTES,
    RELEASE_COMMIT_SHA_PATTERN,
    RELEASE_TRANSITION_FORMAT_VERSION,
    RELEASE_TRANSITION_JOURNAL_FILE_NAME,
    type ReleaseLinkState,
    type ReleaseTransitionJournal,
    type ReleaseTransitionJournalSnapshot,
} from "./managerModel.ts";

export async function syncDirectory(directoryPath: string): Promise<void> {
    const directory = await fsp.open(
        directoryPath,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY
    );
    try {
        await directory.sync();
    } finally {
        await directory.close();
    }
}

export async function syncFile(filePath: string): Promise<void> {
    const file = await fsp.open(filePath, fs.constants.O_RDONLY);
    try {
        await file.sync();
    } finally {
        await file.close();
    }
}

function hasExactKeys(record: Record<string, unknown>, expected: string[]): boolean {
    const actual = Object.keys(record).toSorted(compareStrings);
    const sortedExpected = expected.toSorted(compareStrings);
    return (
        actual.length === sortedExpected.length &&
        actual.every((key, index) => key === sortedExpected[index])
    );
}

function parseOptionalCommitSha(value: unknown): false | string {
    if (value === false) {
        return false;
    }
    if (typeof value !== "string" || !RELEASE_COMMIT_SHA_PATTERN.test(value)) {
        throw new TypeError("Release transition contains an invalid commit SHA");
    }
    return value;
}

function parseReleaseLinkState(value: unknown): ReleaseLinkState {
    if (!isPlainRecord(value) || !hasExactKeys(value, ["current", "previous"])) {
        throw new TypeError("Release transition contains an invalid link state");
    }
    const state = {
        current: parseOptionalCommitSha(value.current),
        previous: parseOptionalCommitSha(value.previous),
    };
    if (!state.current && state.previous) {
        throw new TypeError("Release transition cannot have previous without current");
    }
    if (state.current && state.current === state.previous) {
        throw new TypeError("Release transition requires distinct release slots");
    }
    return state;
}

function parseReleaseTransitionJournal(value: unknown): ReleaseTransitionJournal {
    if (
        !isPlainRecord(value) ||
        !hasExactKeys(value, ["after", "before", "formatVersion", "operation"]) ||
        value.formatVersion !== RELEASE_TRANSITION_FORMAT_VERSION ||
        (value.operation !== "activate" &&
            value.operation !== "restore" &&
            value.operation !== "rollback")
    ) {
        throw new TypeError("Release transition journal is invalid");
    }
    const before = parseReleaseLinkState(value.before);
    const after = parseReleaseLinkState(value.after);
    if (!after.current || after.current === before.current) {
        throw new TypeError("Release transition journal does not change current");
    }
    if (value.operation === "activate") {
        if (after.previous !== before.current) {
            throw new TypeError("Activation journal has an invalid rollback slot");
        }
    } else if (value.operation === "rollback") {
        if (
            !before.current ||
            !before.previous ||
            after.current !== before.previous ||
            after.previous !== before.current
        ) {
            throw new TypeError("Rollback journal has an invalid release swap");
        }
    } else if (!before.current || !before.previous || after.current !== before.previous) {
        throw new TypeError(
            "Failed activation restore journal has an invalid release state"
        );
    }
    return {
        after,
        before,
        formatVersion: RELEASE_TRANSITION_FORMAT_VERSION,
        operation: value.operation,
    };
}

async function readBoundedControlFile(filePath: string): Promise<
    | {
          device: number;
          inode: number;
          serialized: string;
      }
    | undefined
> {
    let file: fs.promises.FileHandle;
    try {
        file = await fsp.open(
            filePath,
            fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
        );
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
    try {
        const stat = await file.stat();
        if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            stat.size === 0 ||
            stat.size > MAX_RELEASE_TRANSITION_FILE_BYTES
        ) {
            throw new TypeError(
                "Release transition control file must be a bounded regular file"
            );
        }
        return {
            device: stat.dev,
            inode: stat.ino,
            serialized: await file.readFile("utf8"),
        };
    } finally {
        await file.close();
    }
}

export async function readReleaseTransitionJournal(
    layout: DashboardReleaseLayout
): Promise<ReleaseTransitionJournalSnapshot | undefined> {
    const file = await readBoundedControlFile(
        path.join(layout.root, RELEASE_TRANSITION_JOURNAL_FILE_NAME)
    );
    return file
        ? {
              device: file.device,
              inode: file.inode,
              journal: parseReleaseTransitionJournal(
                  JSON.parse(file.serialized) as unknown
              ),
          }
        : undefined;
}

export async function removeReleaseTransitionControlFile(
    layout: DashboardReleaseLayout,
    fileName: string,
    expected?: { device: number; inode: number }
): Promise<void> {
    const filePath = path.join(layout.root, fileName);
    let stat: fs.Stats;
    try {
        stat = await fsp.lstat(filePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return;
        }
        throw error;
    }
    if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        (expected !== undefined &&
            (stat.dev !== expected.device || stat.ino !== expected.inode))
    ) {
        throw new TypeError("Release transition control file identity changed");
    }
    await fsp.unlink(filePath);
    await syncDirectory(layout.root);
}

export async function writeReleaseTransitionJournal(
    layout: DashboardReleaseLayout,
    journal: ReleaseTransitionJournal
): Promise<ReleaseTransitionJournalSnapshot> {
    const journalPath = path.join(layout.root, RELEASE_TRANSITION_JOURNAL_FILE_NAME);
    try {
        await fsp.lstat(journalPath);
        throw new Error("Release transition journal already exists");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
        }
    }
    await writeTextNoFollowGuarded(
        guardedPath(journalPath),
        `${JSON.stringify(journal)}\n`,
        0o600
    );
    const snapshot = await readReleaseTransitionJournal(layout);
    if (!snapshot) {
        throw new Error("Release transition journal disappeared after creation");
    }
    return snapshot;
}
