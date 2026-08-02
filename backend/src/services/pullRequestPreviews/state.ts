import { existsSync, readdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";

import { resolvePullRequestPreviewConfig } from "./config.ts";
import {
    isPathStrictlyWithin,
    isRealDirectory,
    isRealRegularFile,
} from "./fileSystem.ts";
import type { PullRequestPreviewConfig } from "./types.ts";

const MANAGED_STATE_DIRECTORY_PATTERN = /^pr-([1-9]\d*)$/u;

export function managedStateRoot(
    config: PullRequestPreviewConfig,
    number: number
): string {
    const stateRoot = path.join(config.previewRoot, "states", `pr-${number}`);
    if (!isPathStrictlyWithin(stateRoot, config.previewRoot)) {
        throw new Error("Preview state escaped the configured preview root");
    }
    return stateRoot;
}

/** Lists isolated PR state directories without following directory symlinks. */
export function listManagedPullRequestPreviewStateNumbers(
    config: PullRequestPreviewConfig = resolvePullRequestPreviewConfig()
): number[] {
    const statesRoot = path.join(config.previewRoot, "states");
    if (!existsSync(statesRoot)) return [];
    if (!isRealDirectory(config.previewRoot) || !isRealDirectory(statesRoot)) {
        throw new Error("PR dev state roots must be real directories");
    }
    const resolvedPreviewRoot = realpathSync(config.previewRoot);
    const resolvedStatesRoot = realpathSync(statesRoot);
    if (!isPathStrictlyWithin(resolvedStatesRoot, resolvedPreviewRoot)) {
        throw new Error("PR dev states escaped the configured preview root");
    }
    const numbers: number[] = [];
    const stateEntries = readdirSync(statesRoot, { withFileTypes: true });
    for (const entry of stateEntries) {
        const match = MANAGED_STATE_DIRECTORY_PATTERN.exec(entry.name);
        if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
        const number = Number(match[1]);
        if (!Number.isSafeInteger(number) || number <= 0 || number > 2_147_483_647) {
            continue;
        }
        const stateRoot = path.join(statesRoot, entry.name);
        if (
            !isRealDirectory(stateRoot) ||
            !isPathStrictlyWithin(realpathSync(stateRoot), resolvedStatesRoot)
        ) {
            throw new Error("PR dev state directory escaped the managed states root");
        }
        numbers.push(number);
    }
    return numbers.toSorted((left, right) => left - right);
}

export function didRemoveManagedPreviewState(
    config: PullRequestPreviewConfig,
    number: number
): boolean {
    const stateRoot = managedStateRoot(config, number);
    if (!existsSync(stateRoot)) return false;
    const statesRoot = path.dirname(stateRoot);
    if (
        !isRealDirectory(config.previewRoot) ||
        !isRealDirectory(statesRoot) ||
        !isRealDirectory(stateRoot) ||
        !isPathStrictlyWithin(
            realpathSync(statesRoot),
            realpathSync(config.previewRoot)
        ) ||
        !isPathStrictlyWithin(realpathSync(stateRoot), realpathSync(statesRoot))
    ) {
        throw new Error("PR dev state path must be a real directory");
    }
    rmSync(stateRoot, { force: true, recursive: true });
    return true;
}

export function didRemovePreviewRecord(config: PullRequestPreviewConfig): boolean {
    if (!existsSync(config.stateFile)) return false;
    if (!isRealRegularFile(config.stateFile)) {
        throw new Error("PR dev record path must be a real regular file");
    }
    rmSync(config.stateFile, { force: true });
    return true;
}
