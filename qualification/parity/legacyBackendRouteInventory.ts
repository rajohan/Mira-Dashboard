import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as v from "valibot";

const maximumServerSourceBytes = 256 * 1024;
const maximumProbeOutputBytes = 64 * 1024;
const importedRepositoryRoot = path.resolve(import.meta.dir, "../..");
const probeEntrypoint = path.join(
    importedRepositoryRoot,
    "scripts/qualification/legacyBackendRouteProbe.ts"
);
const httpMethodSchema = v.picklist(["DELETE", "GET", "HEAD", "PATCH", "POST", "PUT"]);
const httpRouteIdentitySchema = v.strictObject({
    id: v.pipe(v.string(), v.minLength(6), v.maxLength(256)),
    method: httpMethodSchema,
    path: v.pipe(v.string(), v.startsWith("/api/"), v.maxLength(192)),
});
const httpRouteIdentitiesSchema = v.pipe(
    v.array(httpRouteIdentitySchema),
    v.minLength(1),
    v.maxLength(256)
);

export interface LegacyBackendRouteIdentity {
    readonly id: string;
    readonly method: "DELETE" | "GET" | "HEAD" | "PATCH" | "POST" | "PUT" | "WebSocket";
    readonly path: string;
}

function compareStrings(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

function assertSingleSourceMatch(
    source: string,
    pattern: RegExp,
    description: string
): void {
    const matches = [...source.matchAll(pattern)];
    if (matches.length !== 1) {
        throw new Error(
            `Legacy server must contain exactly one reviewed ${description}; found ${matches.length}`
        );
    }
}

async function assertWebSocketRouteSource(repositoryRoot: string): Promise<void> {
    const sourcePath = path.join(repositoryRoot, "backend/src/server/app.ts");
    const sourceStat = await stat(sourcePath);
    if (
        !sourceStat.isFile() ||
        sourceStat.size <= 0 ||
        sourceStat.size > maximumServerSourceBytes
    ) {
        throw new Error("Legacy WebSocket server source has an invalid size");
    }
    const source = await readFile(sourcePath, "utf8");
    assertSingleSourceMatch(
        source,
        /if \(url\.pathname === "\/ws"\) \{/gu,
        "WebSocket route branch"
    );
    assertSingleSourceMatch(
        source,
        /server\.upgrade\(request, \{/gu,
        "WebSocket upgrade call"
    );
}

async function httpRouteIdentities(): Promise<LegacyBackendRouteIdentity[]> {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "mira-route-probe-"));
    try {
        const environment = {
            CI: "1",
            HOME: temporaryDirectory,
            LANG: "C.UTF-8",
            MIRA_DASHBOARD_DB_PATH: path.join(temporaryDirectory, "route-probe.sqlite"),
            MIRA_DASHBOARD_PROJECT_ROOT: path.join(
                temporaryDirectory,
                "dashboard-project"
            ),
            NODE_ENV: "test",
            OPENCLAW_HOME: path.join(temporaryDirectory, "openclaw"),
            PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
            TMPDIR: temporaryDirectory,
            XDG_CACHE_HOME: path.join(temporaryDirectory, "cache"),
            XDG_CONFIG_HOME: path.join(temporaryDirectory, "config"),
            XDG_DATA_HOME: path.join(temporaryDirectory, "data"),
            XDG_STATE_HOME: path.join(temporaryDirectory, "state"),
        };
        const result = Bun.spawnSync({
            cmd: [process.execPath, probeEntrypoint],
            cwd: temporaryDirectory,
            env: environment,
            killSignal: "SIGKILL",
            maxBuffer: maximumProbeOutputBytes,
            stderr: "pipe",
            stdin: "ignore",
            stdout: "pipe",
            timeout: 5000,
        });
        if (!result.success) {
            throw new Error("Legacy route registry probe failed");
        }
        let candidate: unknown;
        try {
            candidate = JSON.parse(new TextDecoder().decode(result.stdout)) as unknown;
        } catch {
            throw new Error("Legacy route registry probe returned invalid JSON");
        }
        const identities = v.parse(httpRouteIdentitiesSchema, candidate);
        for (const identity of identities) {
            if (identity.id !== `${identity.method} ${identity.path}`) {
                throw new Error(
                    `Legacy route probe returned an invalid id ${identity.id}`
                );
            }
        }
        return identities;
    } finally {
        await rm(temporaryDirectory, { force: true, recursive: true });
    }
}

/**
 * Reads the executable legacy HTTP registry and verifies the source-owned WebSocket route.
 * Documentation supplies descriptions, but these identities are the parity authority.
 * @param repositoryRoot Absolute repository root containing the imported registry.
 * @returns Sorted, unique current-production route identities.
 */
export async function loadLegacyBackendRouteIdentities(
    repositoryRoot: string
): Promise<LegacyBackendRouteIdentity[]> {
    const resolvedRepositoryRoot = path.resolve(repositoryRoot);
    if (resolvedRepositoryRoot !== importedRepositoryRoot) {
        throw new Error(
            "Legacy route inventory must inspect its imported repository root"
        );
    }
    await assertWebSocketRouteSource(resolvedRepositoryRoot);
    const identities = [
        ...(await httpRouteIdentities()),
        {
            id: "WebSocket /ws",
            method: "WebSocket" as const,
            path: "/ws",
        },
    ].toSorted((left, right) => compareStrings(left.id, right.id));
    for (const [index, identity] of identities.entries()) {
        if (index > 0 && identities[index - 1]!.id === identity.id) {
            throw new Error(`Duplicate legacy route identity ${identity.id}`);
        }
    }
    return identities;
}
