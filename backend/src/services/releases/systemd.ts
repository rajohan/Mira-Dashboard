import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { guardedPath } from "../../lib/guardedOps/core.ts";
import { writeTextNoFollowAnchoredGuarded } from "../../lib/guardedOps/write.ts";
import { runProcess } from "../../lib/processes.ts";
import { resolveAbsoluteNonRootPath } from "../../lib/safePath.ts";
import { parseSystemdProperties } from "../../lib/systemdProperties.ts";
import type { ManagedDashboardRelease } from "./managerModel.ts";
import {
    MANAGED_DASHBOARD_UNIT_ARTIFACTS,
    MANAGED_DASHBOARD_UNIT_NAMES,
    type ManagedDashboardUnitName,
} from "./systemdPolicy.ts";

const MAX_UNIT_FILE_BYTES = 256 * 1024;
const SYSTEMCTL_EXECUTABLE = "/usr/bin/systemctl";
const SYSTEMCTL_TIMEOUT_MS = 30_000;

interface ManagedDashboardSystemdCommandResult {
    stderr: string;
    stdout: string;
}

interface ManagedDashboardUnitFile {
    content: string;
    mode: number;
}

export type ManagedDashboardSystemdCommandRunner = (
    command: string,
    arguments_: readonly string[]
) => Promise<ManagedDashboardSystemdCommandResult>;

export interface ManagedDashboardSystemdOptions {
    commandRunner?: ManagedDashboardSystemdCommandRunner;
    unitRoot?: string;
}

export interface PreparedManagedDashboardUnits {
    changed: ManagedDashboardUnitName[];
    rollback: () => Promise<void>;
}

function releaseHasManagedUnitBundle(release: ManagedDashboardRelease): boolean {
    const artifacts = new Set(
        release.manifest.artifacts.map((artifact) => artifact.path)
    );
    return MANAGED_DASHBOARD_UNIT_ARTIFACTS.every((artifact) => artifacts.has(artifact));
}

async function ensureRealDirectory(directoryPath: string, mode: number): Promise<void> {
    await fsp.mkdir(directoryPath, { mode, recursive: true });
    const stat = await fsp.lstat(directoryPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new TypeError(
            `Managed Dashboard systemd path must be a real directory: ${directoryPath}`
        );
    }
    if ((await fsp.realpath(directoryPath)) !== path.resolve(directoryPath)) {
        throw new TypeError(
            `Managed Dashboard systemd path must not traverse symlinks: ${directoryPath}`
        );
    }
}

async function readBoundedUnitFile(filePath: string): Promise<ManagedDashboardUnitFile> {
    const file = await fsp.open(
        filePath,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    );
    try {
        const stat = await file.stat();
        if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            stat.size === 0 ||
            stat.size > MAX_UNIT_FILE_BYTES
        ) {
            throw new TypeError(
                "Managed Dashboard systemd units must be bounded single-link files"
            );
        }
        return {
            content: await file.readFile("utf8"),
            mode: stat.mode & 0o777,
        };
    } finally {
        await file.close();
    }
}

async function readOptionalUnitFile(
    filePath: string
): Promise<ManagedDashboardUnitFile | undefined> {
    try {
        return await readBoundedUnitFile(filePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
}

async function defaultCommandRunner(
    command: string,
    arguments_: readonly string[]
): Promise<ManagedDashboardSystemdCommandResult> {
    const result = await runProcess(command, arguments_, {
        maxBuffer: 1024 * 1024,
        timeoutMs: SYSTEMCTL_TIMEOUT_MS,
    });
    if (result.code !== 0) {
        throw new Error(
            `${command} ${arguments_.join(" ")} failed with exit code ${
                result.code
            }: ${result.stderr.trim() || result.stdout.trim()}`
        );
    }
    return { stderr: result.stderr, stdout: result.stdout };
}

async function reloadAndVerifyUnits(
    unitRoot: string,
    commandRunner: ManagedDashboardSystemdCommandRunner
): Promise<void> {
    await commandRunner(SYSTEMCTL_EXECUTABLE, ["--user", "daemon-reload"]);
    for (const unit of MANAGED_DASHBOARD_UNIT_NAMES) {
        const result = await commandRunner(SYSTEMCTL_EXECUTABLE, [
            "--user",
            "show",
            unit,
            "--property=DropInPaths",
            "--property=FragmentPath",
            "--property=LoadState",
            "--no-pager",
        ]);
        const properties = parseSystemdProperties(result.stdout);
        if (
            (properties.get("DropInPaths") ?? "") !== "" ||
            properties.get("LoadState") !== "loaded" ||
            properties.get("FragmentPath") !== path.join(unitRoot, unit)
        ) {
            throw new Error(
                `${unit} did not load exclusively from its managed unit path`
            );
        }
    }
}

async function removeInstalledUnit(filePath: string): Promise<void> {
    try {
        const stat = await fsp.lstat(filePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
            throw new TypeError(
                "Managed Dashboard systemd rollback target changed identity"
            );
        }
        await fsp.unlink(filePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
        }
    }
}

async function restoreInstalledUnits(
    changed: readonly ManagedDashboardUnitName[],
    previous: ReadonlyMap<ManagedDashboardUnitName, ManagedDashboardUnitFile | undefined>,
    unitRoot: string,
    commandRunner: ManagedDashboardSystemdCommandRunner
): Promise<void> {
    for (const unit of changed) {
        const installed = previous.get(unit);
        await (installed === undefined
            ? removeInstalledUnit(path.join(unitRoot, unit))
            : writeTextNoFollowAnchoredGuarded(
                  guardedPath(unitRoot),
                  unit,
                  installed.content,
                  { mode: installed.mode }
              ));
    }
    await commandRunner(SYSTEMCTL_EXECUTABLE, ["--user", "daemon-reload"]);
}

/**
 * Installs and verifies the target release's managed units, returning a
 * compensating operation for a release transition that does not commit.
 * @param release Verified target release.
 * @param options Unit root and command dependency overrides.
 * @returns Prepared unit state and its compensating rollback.
 */
export async function prepareManagedDashboardUnits(
    release: ManagedDashboardRelease,
    options: ManagedDashboardSystemdOptions = {}
): Promise<PreparedManagedDashboardUnits> {
    if (!releaseHasManagedUnitBundle(release)) {
        throw new Error(
            `Release ${release.commitSha} does not contain managed systemd units`
        );
    }
    const unitRoot = resolveAbsoluteNonRootPath(
        options.unitRoot ?? path.join(os.homedir(), ".config", "systemd", "user"),
        "Managed Dashboard user unit root"
    );
    await ensureRealDirectory(unitRoot, 0o755);
    const desired = new Map(
        await Promise.all(
            MANAGED_DASHBOARD_UNIT_NAMES.map(async (unit) => {
                const releaseUnit = await readBoundedUnitFile(
                    path.join(release.path, "systemd", unit)
                );
                return [unit, releaseUnit.content] as const;
            })
        )
    );
    const previous = new Map<
        ManagedDashboardUnitName,
        ManagedDashboardUnitFile | undefined
    >();
    const changed: ManagedDashboardUnitName[] = [];
    for (const unit of MANAGED_DASHBOARD_UNIT_NAMES) {
        const installed = await readOptionalUnitFile(path.join(unitRoot, unit));
        previous.set(unit, installed);
        if (
            !installed ||
            installed.content !== desired.get(unit) ||
            installed.mode !== 0o644
        ) {
            changed.push(unit);
        }
    }
    if (changed.length === 0) {
        await reloadAndVerifyUnits(
            unitRoot,
            options.commandRunner ?? defaultCommandRunner
        );
        return {
            changed,
            rollback: () => Promise.resolve(),
        };
    }

    const commandRunner = options.commandRunner ?? defaultCommandRunner;
    try {
        for (const unit of changed) {
            await writeTextNoFollowAnchoredGuarded(
                guardedPath(unitRoot),
                unit,
                desired.get(unit) as string,
                { mode: 0o644 }
            );
        }
        await reloadAndVerifyUnits(unitRoot, commandRunner);
    } catch (reconcileError) {
        let rollbackError: unknown;
        try {
            await restoreInstalledUnits(changed, previous, unitRoot, commandRunner);
        } catch (error) {
            rollbackError = error;
        }
        if (rollbackError !== undefined) {
            const reconcileFailure = new AggregateError(
                [reconcileError, rollbackError],
                "Managed Dashboard systemd reconciliation and rollback failed",
                { cause: reconcileError }
            );
            throw reconcileFailure;
        }
        throw reconcileError;
    }
    return {
        changed,
        rollback: () => restoreInstalledUnits(changed, previous, unitRoot, commandRunner),
    };
}
