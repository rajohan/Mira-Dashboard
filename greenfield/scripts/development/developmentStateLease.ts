import { randomBytes } from "node:crypto";
import { link, lstat, open, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { readDevelopmentPrivateFile } from "./developmentPrivateFile.ts";
import type { DevelopmentStackConfig } from "./developmentStackConfig.ts";

const leaseFilePattern =
    /^\.mira-dashboard-development-lease-(\d+)-([0-9a-f]{32})\.json$/u;
const stateMarkerFileName = ".mira-dashboard-development-state.json";
const privateFileMode = 0o600;

interface DevelopmentStateLeaseMarker {
    readonly formatVersion: 1;
    readonly owner: string;
    readonly processId: number;
    readonly processIdentity: string | null;
    readonly startedAtMs: number;
    readonly token: string;
}

export interface DevelopmentStateLease {
    readonly stateRoot: string;
    consumeAfterStateRootRemoval(): void;
    release(): Promise<void>;
}

interface StateRootIdentity {
    readonly device: bigint;
    readonly inode: bigint;
}

function errorCode(error: unknown): unknown {
    return typeof error === "object" && error !== null
        ? Object.getOwnPropertyDescriptor(error, "code")?.value
        : undefined;
}

async function linuxProcessIdentity(processId: number): Promise<string | null> {
    if (process.platform !== "linux") return null;
    try {
        const [bootIdentityContents, processStat] = await Promise.all([
            readFile("/proc/sys/kernel/random/boot_id", "utf8"),
            readFile(`/proc/${processId}/stat`, "utf8"),
        ]);
        const bootIdentity = bootIdentityContents.trim().toLowerCase();
        const commandEnd = processStat.lastIndexOf(")");
        const processFields =
            commandEnd === -1
                ? []
                : processStat
                      .slice(commandEnd + 1)
                      .trim()
                      .split(/\s+/u);
        const startTicks = processFields.at(19);
        if (
            !/^[0-9a-f-]{36}$/u.test(bootIdentity) ||
            startTicks === undefined ||
            !/^\d+$/u.test(startTicks)
        ) {
            throw new Error("Development state process identity is invalid");
        }
        return `${bootIdentity}:${startTicks}`;
    } catch (error) {
        if (errorCode(error) === "ENOENT") return null;
        throw error;
    }
}

function processExists(processId: number): boolean {
    try {
        process.kill(processId, 0);
        return true;
    } catch (error) {
        if (errorCode(error) === "ESRCH") return false;
        if (errorCode(error) === "EPERM") return true;
        throw error;
    }
}

function expectedLeaseMarker(
    config: DevelopmentStackConfig,
    token: string,
    processIdentity: string | null
): DevelopmentStateLeaseMarker {
    return {
        formatVersion: 1,
        owner: config.stateOwner,
        processId: process.pid,
        processIdentity,
        startedAtMs: Date.now(),
        token,
    };
}

async function writePrivateFile(filePath: string, contents: string): Promise<void> {
    const file = await open(filePath, "wx", privateFileMode);
    try {
        await file.writeFile(contents, "utf8");
        await file.sync();
    } finally {
        await file.close();
    }
}

async function publishLeaseFile(
    config: DevelopmentStackConfig,
    marker: DevelopmentStateLeaseMarker
): Promise<string> {
    const leasePath = path.join(
        config.stateRoot,
        `.mira-dashboard-development-lease-${marker.processId}-${marker.token}.json`
    );
    const stagingPath = path.join(
        config.stateRoot,
        `.mira-dashboard-development-lease-staging-${marker.processId}-${marker.token}.json`
    );
    try {
        await writePrivateFile(stagingPath, `${JSON.stringify(marker, undefined, 2)}\n`);
        await link(stagingPath, leasePath);
    } finally {
        await rm(stagingPath, { force: true });
    }
    return leasePath;
}

async function readLeaseMarker(
    config: DevelopmentStackConfig,
    fileName: string
): Promise<DevelopmentStateLeaseMarker> {
    const match = fileName.match(leaseFilePattern);
    if (match === null) throw new Error("Development state lease name is invalid");
    const processId = Number(match[1]);
    const token = match[2]!;
    const leasePath = path.join(config.stateRoot, fileName);
    const invalidLeaseMessage = `Development state lease is invalid: ${fileName}`;
    let parsed: unknown;
    try {
        parsed = JSON.parse(
            await readDevelopmentPrivateFile(leasePath, {
                exactMode: privateFileMode,
                maximumBytes: 4096,
                minimumBytes: 2,
            })
        ) as unknown;
    } catch (error) {
        throw new Error(invalidLeaseMessage, { cause: error });
    }
    const marker = parsed as Partial<DevelopmentStateLeaseMarker>;
    if (
        marker.formatVersion !== 1 ||
        marker.owner !== config.stateOwner ||
        marker.processId !== processId ||
        marker.token !== token ||
        !Number.isSafeInteger(marker.processId) ||
        marker.processId < 1 ||
        (marker.processIdentity !== null &&
            (typeof marker.processIdentity !== "string" ||
                !/^[0-9a-f-]{36}:\d+$/u.test(marker.processIdentity))) ||
        typeof marker.startedAtMs !== "number" ||
        !Number.isSafeInteger(marker.startedAtMs) ||
        marker.startedAtMs < 0
    ) {
        throw new Error(invalidLeaseMessage);
    }
    return marker as DevelopmentStateLeaseMarker;
}

async function leaseProcessIsActive(
    marker: DevelopmentStateLeaseMarker
): Promise<boolean> {
    const identity = await linuxProcessIdentity(marker.processId);
    if (marker.processIdentity !== null && identity !== null) {
        return marker.processIdentity === identity;
    }
    return processExists(marker.processId);
}

async function activeLeaseFiles(
    config: DevelopmentStackConfig,
    ownLeasePath?: string
): Promise<readonly string[]> {
    const active: string[] = [];
    for (const fileName of await readdir(config.stateRoot)) {
        if (!leaseFilePattern.test(fileName)) continue;
        const leasePath = path.join(config.stateRoot, fileName);
        if (leasePath === ownLeasePath) continue;
        const marker = await readLeaseMarker(config, fileName);
        if (await leaseProcessIsActive(marker)) {
            active.push(leasePath);
        } else {
            await rm(leasePath);
        }
    }
    return active;
}

async function stateRootIdentity(stateRoot: string): Promise<StateRootIdentity | null> {
    try {
        const status = await lstat(stateRoot, { bigint: true });
        if (
            !status.isDirectory() ||
            status.isSymbolicLink() ||
            status.uid !== BigInt(process.getuid?.() ?? -1)
        ) {
            throw new Error("Development state root identity is invalid");
        }
        return Object.freeze({ device: status.dev, inode: status.ino });
    } catch (error) {
        if (errorCode(error) === "ENOENT") return null;
        throw error;
    }
}

async function validateStateOwnerMarker(config: DevelopmentStackConfig): Promise<void> {
    const markerPath = path.join(config.stateRoot, stateMarkerFileName);
    let parsed: unknown;
    try {
        parsed = JSON.parse(
            await readDevelopmentPrivateFile(markerPath, {
                exactMode: privateFileMode,
                maximumBytes: 4096,
            })
        ) as unknown;
    } catch (error) {
        throw new Error("Development state marker is invalid", { cause: error });
    }
    const marker = parsed as { formatVersion?: unknown; owner?: unknown };
    if (marker.formatVersion !== 1 || marker.owner !== config.stateOwner) {
        throw new Error("Development state belongs to another owner");
    }
}

function stateRootIdentityMatches(
    left: StateRootIdentity,
    right: StateRootIdentity
): boolean {
    return left.device === right.device && left.inode === right.inode;
}

/**
 * Acquires one process-scoped lease for an already claimed development state root.
 * Unique lease names make stale cleanup exact and prevent removing a concurrent owner.
 * @param config Validated development stack configuration with a claimed state root.
 * @returns A lease held until its idempotent release method completes.
 */
export async function acquireDevelopmentStateLease(
    config: DevelopmentStackConfig
): Promise<DevelopmentStateLease> {
    const acquiredStateRootIdentity = await stateRootIdentity(config.stateRoot);
    if (acquiredStateRootIdentity === null) {
        throw new Error("Development state root is missing");
    }
    await validateStateOwnerMarker(config);
    const initialActiveLeaseFiles = await activeLeaseFiles(config);
    if (initialActiveLeaseFiles.length > 0) {
        throw new Error("Development state is already in use");
    }
    const token = randomBytes(16).toString("hex");
    const processIdentity = await linuxProcessIdentity(process.pid);
    const marker = expectedLeaseMarker(config, token, processIdentity);
    const leasePath = await publishLeaseFile(config, marker);
    try {
        const concurrentActiveLeaseFiles = await activeLeaseFiles(config, leasePath);
        if (concurrentActiveLeaseFiles.length > 0) {
            throw new Error("Development state is already in use");
        }
        const publishedStateRootIdentity = await stateRootIdentity(config.stateRoot);
        if (
            publishedStateRootIdentity === null ||
            !stateRootIdentityMatches(
                acquiredStateRootIdentity,
                publishedStateRootIdentity
            )
        ) {
            throw new Error(
                "Development state root identity changed during lease acquisition"
            );
        }
        await validateStateOwnerMarker(config);
    } catch (error) {
        await rm(leasePath, { force: true });
        throw error;
    }

    let released = false;
    let releasePromise: Promise<void> | undefined;
    const releaseLease = async (): Promise<void> => {
        if (released) return;
        const currentIdentity = await stateRootIdentity(config.stateRoot);
        if (currentIdentity === null) {
            released = true;
            return;
        }
        if (!stateRootIdentityMatches(acquiredStateRootIdentity, currentIdentity)) {
            throw new Error("Development state root identity changed while leased");
        }
        try {
            const observed = await readLeaseMarker(config, path.basename(leasePath));
            if (
                observed.processId !== marker.processId ||
                observed.token !== marker.token ||
                observed.processIdentity !== marker.processIdentity
            ) {
                throw new Error("Development state lease ownership changed");
            }
            await rm(leasePath);
        } catch (error) {
            const afterFailureIdentity = await stateRootIdentity(config.stateRoot);
            if (afterFailureIdentity !== null) throw error;
        }
        released = true;
    };
    return Object.freeze({
        consumeAfterStateRootRemoval(): void {
            released = true;
        },
        release(): Promise<void> {
            releasePromise ??= releaseLease();
            return releasePromise;
        },
        stateRoot: config.stateRoot,
    });
}
