import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import {
    logSourceMaximum,
    type ListLogSourcesOutput,
    type LogSource,
} from "../../../contracts/logs.ts";

export interface LogSourceReference {
    readonly fileName: string;
    readonly group: LogSource["group"];
    readonly id: string;
    readonly label: string;
    readonly root: string;
    readonly trustedOwnerIds: readonly number[];
}

export interface LogSourceCatalog {
    readonly list: () => Promise<ListLogSourcesOutput>;
    readonly resolve: (sourceId: string) => Promise<LogSourceReference | undefined>;
}

export interface LogSourceCatalogOptions {
    readonly dashboardLogsRoot: string;
    readonly hostLogsRoot?: string;
    /** Exact host-log owner ids; defaults to root plus the root-owned passwd syslog id. */
    readonly hostOwnerIds?: readonly number[];
    readonly now?: () => number;
    readonly openClawLogsRoot?: string;
}

const dashboardSources = [
    ["dashboard.web", "web.ndjson", "Dashboard web"],
    ["dashboard.worker", "worker.ndjson", "Dashboard worker"],
    ["dashboard.web.stdout", "web-stdout.log", "Dashboard web output"],
    ["dashboard.web.stderr", "web-stderr.log", "Dashboard web startup errors"],
    ["dashboard.worker.stdout", "worker-stdout.log", "Dashboard worker output"],
    ["dashboard.worker.stderr", "worker-stderr.log", "Dashboard worker startup errors"],
] as const;

/** Exact host text-log read manifest; no recursive discovery is performed. */
export const hostTextLogManifest = [
    ["host.alternatives", "alternatives.log", "Alternatives changes"],
    ["host.apport", "apport.log", "Apport"],
    ["host.auth", "auth.log", "System authentication"],
    ["host.dpkg", "dpkg.log", "Package changes"],
    ["host.kern", "kern.log", "Kernel"],
    ["host.syslog", "syslog", "System"],
] as const;

const openClawLogNamePattern = /^openclaw-(\d{4})-(\d{2})-(\d{2})\.log$/u;
const passwdMaximumBytes = 128 * 1024;

function runtimeOwnerIds(): readonly number[] {
    const runtimeOwnerId = typeof process.getuid === "function" ? process.getuid() : 0;
    return Object.freeze(runtimeOwnerId === 0 ? [0] : [0, runtimeOwnerId]);
}

function normalizedOwnerIds(ownerIds: readonly number[]): readonly number[] {
    const normalized = [...new Set([0, ...ownerIds])];
    if (
        normalized.length > 16 ||
        normalized.some((ownerId) => !Number.isSafeInteger(ownerId) || ownerId < 0)
    ) {
        throw new TypeError("Log source owner policy is invalid");
    }
    return Object.freeze(normalized);
}

async function readHandleBounded(
    handle: Awaited<ReturnType<typeof open>>,
    size: number
): Promise<Buffer> {
    const output = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
        const result = await handle.read(output, offset, size - offset, offset);
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
    }
    return output.subarray(0, offset);
}

/**
 * Resolves only the exact `syslog` account from a bounded root-owned passwd descriptor.
 * @returns Root and, when safely resolved, the Ubuntu syslog owner id.
 */
async function systemHostOwnerIds(): Promise<readonly number[]> {
    let handle;
    try {
        handle = await open(
            "/etc/passwd",
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
        const status = await handle.stat();
        if (
            !status.isFile() ||
            status.nlink !== 1 ||
            status.uid !== 0 ||
            (status.mode & 0o022) !== 0 ||
            status.size > passwdMaximumBytes
        ) {
            return Object.freeze([0]);
        }
        const passwdBytes = await readHandleBounded(handle, status.size);
        const passwd = passwdBytes.toString("utf8");
        const syslog = passwd
            .split("\n")
            .map((line) => /^syslog:[^:]*:(\d+):/u.exec(line)?.[1])
            .find((value) => value !== undefined);
        if (syslog === undefined) return Object.freeze([0]);
        return normalizedOwnerIds([Number(syslog)]);
    } catch {
        return Object.freeze([0]);
    } finally {
        await handle?.close().catch(() => {});
    }
}

function normalizedRoot(root: string): string {
    if (
        root.includes("\0") ||
        !path.isAbsolute(root) ||
        path.resolve(root) !== root ||
        root === path.parse(root).root
    ) {
        throw new TypeError("Log source root is invalid");
    }
    return root;
}

function staticReferences(
    root: string,
    group: "dashboard" | "host",
    trustedOwnerIds: readonly number[]
) {
    const definitions = group === "dashboard" ? dashboardSources : hostTextLogManifest;
    return definitions.map(([id, fileName, label]) =>
        Object.freeze({ fileName, group, id, label, root, trustedOwnerIds })
    );
}

async function rootIsExactDirectory(root: string): Promise<boolean> {
    try {
        const status = await lstat(root);
        return (
            status.isDirectory() &&
            !status.isSymbolicLink() &&
            (await realpath(root)) === root
        );
    } catch {
        return false;
    }
}

async function openClawReferences(
    root: string | undefined,
    trustedOwnerIds: readonly number[]
) {
    if (root === undefined || !(await rootIsExactDirectory(root))) return [];
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries
        .filter((entry) => entry.isFile() && openClawLogNamePattern.test(entry.name))
        .map((entry) => {
            const match = openClawLogNamePattern.exec(entry.name);
            if (match === null) throw new TypeError("OpenClaw log name is invalid");
            const date = `${match[1]}${match[2]}${match[3]}`;
            return Object.freeze({
                fileName: entry.name,
                group: "openclaw" as const,
                id: `openclaw.${date}`,
                label: `OpenClaw ${match[1]}-${match[2]}-${match[3]}`,
                root,
                trustedOwnerIds,
            });
        })
        .toSorted((left, right) => right.id.localeCompare(left.id))
        .slice(
            0,
            Math.max(
                0,
                logSourceMaximum - dashboardSources.length - hostTextLogManifest.length
            )
        );
}

async function sourceProjection(reference: LogSourceReference): Promise<LogSource> {
    try {
        const status = await lstat(path.join(reference.root, reference.fileName));
        if (
            status.isSymbolicLink() ||
            !status.isFile() ||
            status.nlink !== 1 ||
            !reference.trustedOwnerIds.includes(status.uid) ||
            (status.mode & 0o022) !== 0
        ) {
            return {
                availability: "unreadable",
                group: reference.group,
                id: reference.id,
                label: reference.label,
            };
        }
        return {
            availability: "available",
            group: reference.group,
            id: reference.id,
            label: reference.label,
            modifiedAtMs: Math.max(0, Math.trunc(status.mtimeMs)),
            sizeBytes: status.size,
        };
    } catch (error) {
        return {
            availability:
                (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
                    ? "missing"
                    : "unreadable",
            group: reference.group,
            id: reference.id,
            label: reference.label,
        };
    }
}

/**
 * Builds the only path-to-source translation boundary used by browser log reads.
 * @param options Fixed source roots, owner policy, and replaceable clock.
 * @returns A path-free named source catalog.
 */
export function createLogSourceCatalog({
    dashboardLogsRoot,
    hostLogsRoot = "/var/log",
    hostOwnerIds,
    now = Date.now,
    openClawLogsRoot = "/tmp/openclaw",
}: LogSourceCatalogOptions): LogSourceCatalog {
    const dashboardRoot = normalizedRoot(dashboardLogsRoot);
    const hostRoot = normalizedRoot(hostLogsRoot);
    const openClawRoot = normalizedRoot(openClawLogsRoot);
    const applicationOwnerIds = runtimeOwnerIds();
    const resolvedHostOwnerIds =
        hostOwnerIds === undefined
            ? systemHostOwnerIds()
            : Promise.resolve(normalizedOwnerIds(hostOwnerIds));

    async function references(): Promise<readonly LogSourceReference[]> {
        const openClaw = await openClawReferences(openClawRoot, applicationOwnerIds);
        return [
            ...staticReferences(dashboardRoot, "dashboard", applicationOwnerIds),
            ...staticReferences(hostRoot, "host", await resolvedHostOwnerIds),
            ...openClaw,
        ];
    }

    return Object.freeze({
        async list() {
            const sourceReferences = await references();
            const rows = await Promise.all(
                sourceReferences.map((reference) => sourceProjection(reference))
            );
            return {
                observedAtMs: now(),
                sources: rows.toSorted((left, right) => left.id.localeCompare(right.id)),
            };
        },
        async resolve(sourceId: string) {
            const sourceReferences = await references();
            return sourceReferences.find(({ id }) => id === sourceId);
        },
    });
}
