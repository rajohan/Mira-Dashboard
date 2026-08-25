import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

const failureMessage = "Database observability provisioning failed";
const usage =
    "Usage: bun runProvisioning.ts <verify-current-catalog|activate-current-catalog|open-approved-collection|enable-approved-collection|close-approved-collection> --approved [--collection-lease-token <uuid> --catalog-digest <sha256>]";
const dockerExecutable = "/usr/bin/docker";
const dockerHost = "unix:///var/run/docker.sock";
const composeExecutable = "/opt/docker/bin/docker-compose-doppler";
const composeRoot = "/opt/docker";
const composeRootConfig = "/opt/docker/compose.yaml";
const containerShellExecutable = "/bin/sh";
const containerOperatingSystemUser = "postgres";
const containerPsqlProbeLauncher =
    ': "${POSTGRES_USER:?}"; exec /usr/bin/env -i HOME=/var/lib/postgresql LANG=C LC_ALL=C PATH=/usr/local/bin:/usr/bin:/bin PGUSER="$POSTGRES_USER" /usr/bin/timeout -s TERM -k 1 3 /usr/local/bin/psql --host=/var/run/postgresql --username="$POSTGRES_USER" --no-psqlrc --set=ON_ERROR_STOP=1 "$@"';
const containerPsqlLauncher =
    ': "${POSTGRES_USER:?}"; exec /usr/bin/env -i HOME=/var/lib/postgresql LANG=C LC_ALL=C PATH=/usr/local/bin:/usr/bin:/bin PGUSER="$POSTGRES_USER" /usr/bin/timeout -s TERM -k 2 45 /usr/local/bin/psql --host=/var/run/postgresql --username="$POSTGRES_USER" --no-psqlrc --set=ON_ERROR_STOP=1 "$@"';
const capabilityLabel = "mira.dashboard.database-observability";
const capabilityValue = "pgbouncer-v1";
const processDeadlineMs = 60_000;
const discoveryDeadlineMs = 5000;
const provisioningOperationDeadlineMs = 5 * 60_000;
const closeOperationDeadlineMs = 25_000;
const processStderrMaximumBytes = 64 * 1024;
const dockerPsOutputMaximumBytes = 256 * 1024;
const dockerInspectOutputMaximumBytes = 2 * 1024 * 1024;
const psqlOutputMaximumBytes = 64 * 1024;
const catalogOutputMaximumBytes = 16 * 1024;
const sqlArtifactMaximumBytes = 64 * 1024;
const composeIdentityMaximumBytes = 128;
const composeDependsOnMaximumBytes = 4096;
const containerIdPattern = /^[0-9a-f]{64}$/u;
const composeIdentityPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const unsafeTextPattern = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const collectionLeaseTokenPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const catalogDigestPattern = /^[0-9a-f]{64}$/u;

export const provisioningDockerInspectFormat = [
    "{{json .Id}}",
    `{{with .Config.Labels}}{{json (index . "${capabilityLabel}")}}{{else}}null{{end}}`,
    '{{with .Config.Labels}}{{json (index . "com.docker.compose.project")}}{{else}}null{{end}}',
    '{{with .Config.Labels}}{{json (index . "com.docker.compose.service")}}{{else}}null{{end}}',
    '{{with .Config.Labels}}{{json (index . "com.docker.compose.depends_on")}}{{else}}null{{end}}',
    '{{with .Config.Labels}}{{json (index . "com.docker.compose.project.working_dir")}}{{else}}null{{end}}',
    '{{with .Config.Labels}}{{json (index . "com.docker.compose.project.config_files")}}{{else}}null{{end}}',
    '{{with .Config.Labels}}{{json (index . "com.docker.compose.container-number")}}{{else}}null{{end}}',
    '{{with .Config.Labels}}{{json (index . "com.docker.compose.oneoff")}}{{else}}null{{end}}',
    "{{json .State.Status}}",
    '{{with (index .State "Health")}}{{json (index . "Status")}}{{else}}null{{end}}',
].join("\t");

export const provisioningDockerContainerMaximum = 256;
export const provisioningSqlIncludeDepthMaximum = 8;
export const provisioningSqlIncludeCountMaximum = 32;
export const provisioningSqlInputMaximumBytes = 512 * 1024;
/** Must remain equal to databaseObservabilityDatabaseMaximum in shared policy. */
export const provisioningDatabaseMaximum = 64;
/** Includes templates and disabled databases in the race-detection fingerprint. */
export const provisioningCatalogDatabaseMaximum = 80;
/** The PgBouncer alias and physical PostgreSQL control database are identical. */
export const provisioningControlDatabase = "mira_dashboard_observability" as const;

export const provisioningProcessEnvironment = Object.freeze({
    HOME: "/home/ubuntu",
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/local/bin:/usr/bin:/bin",
});

const provisioningSqlArtifactNames = Object.freeze([
    "activate-observer.sql",
    "apply-cluster.sql",
    "apply-control-database-capability.sql",
    "apply-control-database.sql",
    "apply-database-access-reconciler.sql",
    "apply-database-capabilities.sql",
    "apply-reconciliation-approval.sql",
    "apply-torrent-view.sql",
    "disable-observer.sql",
    "enable-approved-collection.sql",
    "prepare-approved-collection.sql",
    "reconcile-database-access.sql",
    "rollback-cluster.sql",
    "rollback-control-database-capability.sql",
    "rollback-control-database.sql",
    "rollback-database-access-reconciler.sql",
    "rollback-database-capabilities.sql",
    "rollback-reconciliation-approval.sql",
    "rollback-torrent-view.sql",
    "verify-cluster.sql",
    "verify-control-database-capability.sql",
    "verify-control-database.sql",
    "verify-database-access-reconciler.sql",
    "verify-database-capabilities.sql",
    "verify-reconciliation-approval.sql",
    "verify-database.sql",
    "verify-torrent-view.sql",
] as const);
type ProvisioningSqlArtifactName = (typeof provisioningSqlArtifactNames)[number];
const provisioningSqlArtifactNameSet = new Set<string>(provisioningSqlArtifactNames);
const provisioningPolicyArtifactNames = Object.freeze(
    [...provisioningSqlArtifactNames, "runProvisioning.ts" as const].toSorted()
);
type ProvisioningPolicyArtifactName = (typeof provisioningPolicyArtifactNames)[number];
const provisioningPolicyArtifactNameSet = new Set<string>(
    provisioningPolicyArtifactNames
);

interface ProvisioningDatabaseCatalogEntry {
    readonly allowsConnections: boolean;
    readonly isTemplate: boolean;
    readonly name: string;
    readonly oid: string;
    readonly ownerOid: string;
}

interface ProvisioningDockerRow {
    readonly capability: string | null;
    readonly configFiles: string | null;
    readonly containerNumber: string | null;
    readonly dependsOn: string | null;
    readonly health: string | null;
    readonly id: string;
    readonly project: string | null;
    readonly service: string | null;
    readonly state: string;
    readonly oneOff: string | null;
    readonly workingDirectory: string | null;
}

interface ProvisioningComposeTarget {
    readonly administrativeDatabase?: string;
    readonly administrativeRoleOid?: string;
    readonly capabilityContainerId: string;
    readonly containerId: string;
    readonly project: string;
    readonly service: string;
    readonly systemIdentifier?: string;
}

interface ProvisioningDeadline {
    readonly expiresAt: number;
}

interface SqlExpansionState {
    readonly activeFiles: Set<ProvisioningSqlArtifactName>;
    readonly afterDescriptorStat?: (
        fileName: ProvisioningSqlArtifactName
    ) => Promise<void> | void;
    readonly artifactDevice: bigint;
    readonly artifactMode: bigint;
    readonly artifactOwner: bigint;
    fileCount: number;
    sourceBytes: number;
}

const serverIdentitySql = `SELECT pg_catalog.json_build_array(
  CURRENT_USER::text,
  SESSION_USER::text,
  (SELECT roles.rolsuper FROM pg_catalog.pg_roles AS roles WHERE roles.rolname = CURRENT_USER),
  (SELECT roles.oid::text FROM pg_catalog.pg_roles AS roles WHERE roles.rolname = CURRENT_USER),
  pg_catalog.current_database()::text,
  (SELECT controls.system_identifier::text FROM pg_catalog.pg_control_system() AS controls),
  pg_catalog.current_setting('server_version_num')
);
`;

function containerPsqlPrefix(
    service: string,
    launcher: typeof containerPsqlLauncher | typeof containerPsqlProbeLauncher
): readonly string[] {
    return Object.freeze([
        service,
        containerShellExecutable,
        "-ceu",
        launcher,
        "mira-dashboard-psql",
    ]);
}

export type DatabaseObservabilityProvisioningMode =
    | "activate-current-catalog"
    | "close-approved-collection"
    | "enable-approved-collection"
    | "open-approved-collection"
    | "verify-current-catalog";

export interface DatabaseObservabilityProvisioningProcessRequest {
    readonly argv: readonly string[];
    readonly cwd: typeof composeRoot;
    readonly deadlineMs: number;
    readonly environment: typeof provisioningProcessEnvironment;
    readonly executable: typeof composeExecutable | typeof dockerExecutable;
    readonly stdin: string | null;
    readonly stdoutMaximumBytes: number;
}

export interface DatabaseObservabilityProvisioningProcessResult {
    readonly exitCode: number;
    readonly stderr: string;
    readonly stdout: string;
}

export type DatabaseObservabilityProvisioningProcess = (
    request: DatabaseObservabilityProvisioningProcessRequest
) => Promise<DatabaseObservabilityProvisioningProcessResult>;

/** Injectable process boundary for focused, non-production orchestration tests. */
export interface DatabaseObservabilityProvisioningDependencies {
    /** Private copied artifact root used only by adversarial descriptor tests. */
    readonly artifactRoot?: string;
    /** Deterministic file-mutation boundary used only by adversarial tests. */
    readonly afterSqlArtifactDescriptorStat?: (
        fileName: ProvisioningSqlArtifactName
    ) => Promise<void> | void;
    /** Exact catalog digest returned by the immediately preceding prepared open. */
    readonly catalogDigest?: string;
    /** One-use token returned by the immediately preceding prepared open. */
    readonly collectionLeaseToken?: string;
    /** Injectable entropy boundary used only by focused orchestration tests. */
    readonly collectionLeaseTokenFactory?: () => string;
    readonly run?: DatabaseObservabilityProvisioningProcess;
}

/** Redacted result for one approval-gated bounded catalog pass. */
export interface DatabaseObservabilityProvisioningResult {
    readonly catalogDigest?: string;
    readonly collectionLeaseToken?: string;
    readonly databaseCount: number;
    readonly mode: DatabaseObservabilityProvisioningMode;
    readonly status:
        | "ACTIVATED"
        | "CLOSED"
        | "OPENED"
        | "RECONCILED"
        | "UNCHANGED"
        | "VERIFIED";
}

function fail(): never {
    throw new Error(failureMessage);
}

function utf8Bytes(value: string): number {
    return Buffer.byteLength(value, "utf8");
}

async function readBounded(
    stream: ReadableStream<Uint8Array>,
    maximumBytes: number
): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            total += next.value.byteLength;
            if (total > maximumBytes) fail();
            chunks.push(next.value);
        }
    } finally {
        reader.releaseLock();
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
}

function decodeUtf8(value: Uint8Array): string {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(value);
    } catch {
        fail();
    }
}

const defaultProcess: DatabaseObservabilityProvisioningProcess = async (request) => {
    const signal = AbortSignal.timeout(request.deadlineMs);
    const child = Bun.spawn([request.executable, ...request.argv], {
        cwd: request.cwd,
        env: request.environment,
        signal,
        stderr: "pipe",
        stdin: "pipe",
        stdout: "pipe",
    });
    try {
        await child.stdin.write(request.stdin ?? "");
        await child.stdin.end();
        const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            readBounded(child.stdout, request.stdoutMaximumBytes),
            readBounded(child.stderr, processStderrMaximumBytes),
        ]);
        return {
            exitCode,
            stderr: decodeUtf8(stderr),
            stdout: decodeUtf8(stdout),
        };
    } catch {
        child.kill();
        await child.exited.catch(() => {});
        fail();
    }
};

async function executeProcess(
    run: DatabaseObservabilityProvisioningProcess,
    request: DatabaseObservabilityProvisioningProcessRequest,
    deadline?: ProvisioningDeadline
): Promise<string> {
    if (
        request.stdin !== null &&
        utf8Bytes(request.stdin) > provisioningSqlInputMaximumBytes
    ) {
        fail();
    }
    try {
        const expiresAt = deadline?.expiresAt ?? 0;
        if (
            deadline !== undefined &&
            (!Number.isSafeInteger(expiresAt) ||
                expiresAt - Date.now() < request.deadlineMs)
        ) {
            fail();
        }
        const result = await run(request);
        if (
            !Number.isSafeInteger(result.exitCode) ||
            result.exitCode !== 0 ||
            typeof result.stdout !== "string" ||
            typeof result.stderr !== "string" ||
            utf8Bytes(result.stdout) > request.stdoutMaximumBytes ||
            utf8Bytes(result.stderr) > processStderrMaximumBytes
        ) {
            fail();
        }
        return result.stdout;
    } catch {
        fail();
    }
}

function dockerRequest(
    argv: readonly string[],
    stdoutMaximumBytes: number
): DatabaseObservabilityProvisioningProcessRequest {
    return Object.freeze({
        argv: Object.freeze(["--host", dockerHost, ...argv]),
        cwd: composeRoot,
        deadlineMs: discoveryDeadlineMs,
        environment: provisioningProcessEnvironment,
        executable: dockerExecutable,
        stdin: null,
        stdoutMaximumBytes,
    });
}

function validDatabaseName(name: string): boolean {
    return (
        name.trim().length > 0 &&
        !name.includes("\0") &&
        !unsafeTextPattern.test(name) &&
        utf8Bytes(name) <= 63
    );
}

function databaseUri(database: string): string {
    const encodedName = Array.from(Buffer.from(database, "utf8"), (byte) =>
        byte.toString(16).toUpperCase().padStart(2, "0")
    )
        .map((byte) => `%${byte}`)
        .join("");
    return `postgresql:///${encodedName}`;
}

function validComposeIdentity(value: unknown): value is string {
    return (
        typeof value === "string" &&
        utf8Bytes(value) <= composeIdentityMaximumBytes &&
        composeIdentityPattern.test(value)
    );
}

function parseContainerIds(output: string): readonly string[] {
    if (utf8Bytes(output) > dockerPsOutputMaximumBytes) fail();
    const trimmed = output.trim();
    if (trimmed === "") fail();
    const lines = trimmed.split("\n");
    if (lines.length > provisioningDockerContainerMaximum) fail();
    const ids = lines.map((line) => {
        let value: unknown;
        try {
            value = JSON.parse(line) as unknown;
        } catch {
            fail();
        }
        if (typeof value !== "string" || !containerIdPattern.test(value)) fail();
        return value;
    });
    if (new Set(ids).size !== ids.length) fail();
    return Object.freeze(ids);
}

function nullableString(value: unknown): string | null {
    if (value === null || typeof value === "string") return value;
    fail();
}

function parseInspectRows(
    output: string,
    containerIds: readonly string[]
): readonly ProvisioningDockerRow[] {
    if (utf8Bytes(output) > dockerInspectOutputMaximumBytes) fail();
    const trimmed = output.trim();
    if (trimmed === "") fail();
    const lines = trimmed.split("\n");
    if (lines.length !== containerIds.length) fail();
    const expectedIds = new Set(containerIds);
    const observedIds = new Set<string>();
    const rows = lines.map((line) => {
        const fields = line.split("\t");
        if (fields.length !== 11) fail();
        let values: unknown[];
        try {
            values = fields.map((field) => JSON.parse(field) as unknown);
        } catch {
            fail();
        }
        const [
            id,
            capability,
            project,
            service,
            dependsOn,
            workingDirectory,
            configFiles,
            containerNumber,
            oneOff,
            state,
            health,
        ] = values;
        if (
            typeof id !== "string" ||
            !expectedIds.has(id) ||
            observedIds.has(id) ||
            typeof state !== "string" ||
            (health !== null && typeof health !== "string")
        ) {
            fail();
        }
        observedIds.add(id);
        return Object.freeze({
            capability: nullableString(capability),
            configFiles: nullableString(configFiles),
            containerNumber: nullableString(containerNumber),
            dependsOn: nullableString(dependsOn),
            health: nullableString(health),
            id,
            project: nullableString(project),
            service: nullableString(service),
            state,
            oneOff: nullableString(oneOff),
            workingDirectory: nullableString(workingDirectory),
        });
    });
    if (observedIds.size !== expectedIds.size) fail();
    return Object.freeze(rows);
}

function healthy(row: ProvisioningDockerRow): boolean {
    return row.state === "running" && row.health === "healthy";
}

function rootedComposeRow(row: ProvisioningDockerRow): boolean {
    return (
        validComposeIdentity(row.project) &&
        validComposeIdentity(row.service) &&
        row.workingDirectory === composeRoot &&
        row.configFiles === composeRootConfig &&
        row.containerNumber === "1" &&
        row.oneOff === "False"
    );
}

function serviceHealthyDependencies(value: string | null): readonly string[] {
    if (
        value === null ||
        value === "" ||
        utf8Bytes(value) > composeDependsOnMaximumBytes ||
        unsafeTextPattern.test(value)
    ) {
        fail();
    }
    const entries = value.split(",");
    if (entries.length > 32) fail();
    const dependencies = entries.flatMap((entry) => {
        const fields = entry.split(":");
        if (fields.length !== 3) fail();
        const [service, condition, restart] = fields;
        if (
            !validComposeIdentity(service) ||
            ![
                "service_healthy",
                "service_started",
                "service_completed_successfully",
            ].includes(condition ?? "") ||
            !["true", "false"].includes(restart ?? "")
        ) {
            fail();
        }
        return condition === "service_healthy" ? [service] : [];
    });
    if (dependencies.length === 0 || new Set(dependencies).size !== dependencies.length) {
        fail();
    }
    return Object.freeze(dependencies);
}

function composePsqlProbeRequest(
    target: ProvisioningComposeTarget
): DatabaseObservabilityProvisioningProcessRequest {
    return Object.freeze({
        argv: Object.freeze([
            "--file",
            composeRootConfig,
            "--project-directory",
            composeRoot,
            "--project-name",
            target.project,
            "exec",
            "-T",
            "--index",
            "1",
            "--user",
            containerOperatingSystemUser,
            ...containerPsqlPrefix(target.service, containerPsqlProbeLauncher),
            "--dbname=template1",
            "--quiet",
            "--tuples-only",
            "--no-align",
        ]),
        cwd: composeRoot,
        deadlineMs: discoveryDeadlineMs,
        environment: provisioningProcessEnvironment,
        executable: composeExecutable,
        stdin: `${String.raw`\set ON_ERROR_STOP 1`}
SET statement_timeout = '5s';
SET lock_timeout = '1s';
${serverIdentitySql}`,
        stdoutMaximumBytes: 1024,
    });
}

function validServerIdentity(
    value: unknown
): value is readonly [string, string, true, string, "template1", string, string] {
    return (
        Array.isArray(value) &&
        value.length === 7 &&
        typeof value[0] === "string" &&
        validDatabaseName(value[0]) &&
        typeof value[1] === "string" &&
        value[1] === value[0] &&
        value[2] === true &&
        typeof value[3] === "string" &&
        /^[1-9][0-9]{0,9}$/u.test(value[3]) &&
        BigInt(value[3]) <= 4_294_967_295n &&
        value[4] === "template1" &&
        typeof value[5] === "string" &&
        /^[1-9][0-9]{0,19}$/u.test(value[5]) &&
        typeof value[6] === "string" &&
        /^[1-9][0-9]{4,8}$/u.test(value[6])
    );
}

async function discoverComposeTarget(
    run: DatabaseObservabilityProvisioningProcess,
    deadline: ProvisioningDeadline
): Promise<ProvisioningComposeTarget> {
    const containerIds = parseContainerIds(
        await executeProcess(
            run,
            dockerRequest(
                ["ps", "-a", "--no-trunc", "--format", "{{json .ID}}"],
                dockerPsOutputMaximumBytes
            ),
            deadline
        )
    );
    const rows = parseInspectRows(
        await executeProcess(
            run,
            dockerRequest(
                ["inspect", "--format", provisioningDockerInspectFormat, ...containerIds],
                dockerInspectOutputMaximumBytes
            ),
            deadline
        ),
        containerIds
    );
    const candidates = rows.filter(
        (row) => row.capability === capabilityValue && healthy(row)
    );
    if (candidates.length !== 1) fail();
    const candidate = candidates[0]!;
    if (!rootedComposeRow(candidate)) fail();
    const dependencyServices = serviceHealthyDependencies(candidate.dependsOn);
    const potentialTargets: ProvisioningComposeTarget[] = [];
    for (const dependencyService of dependencyServices) {
        if (dependencyService === candidate.service) fail();
        const dependencies = rows.filter(
            (row) =>
                row.project === candidate.project &&
                row.service === dependencyService &&
                healthy(row)
        );
        if (dependencies.length === 0) continue;
        if (dependencies.length !== 1 || !rootedComposeRow(dependencies[0]!)) fail();
        potentialTargets.push(
            Object.freeze({
                capabilityContainerId: candidate.id,
                containerId: dependencies[0]!.id,
                project: candidate.project!,
                service: dependencyService,
            })
        );
    }
    const psqlTargets: ProvisioningComposeTarget[] = [];
    for (const potentialTarget of potentialTargets) {
        try {
            const identityOutput = await executeProcess(
                run,
                composePsqlProbeRequest(potentialTarget),
                deadline
            );
            let identity: unknown;
            try {
                identity = JSON.parse(identityOutput.trim()) as unknown;
            } catch {
                continue;
            }
            if (!validServerIdentity(identity)) continue;
            psqlTargets.push(
                Object.freeze({
                    ...potentialTarget,
                    administrativeDatabase: identity[4],
                    administrativeRoleOid: identity[3],
                    systemIdentifier: identity[5],
                })
            );
        } catch {
            // A non-psql healthy dependency is not the PostgreSQL execution target.
        }
    }
    if (psqlTargets.length !== 1) fail();
    return psqlTargets[0]!;
}

function validCatalogTuple(
    value: unknown
): value is readonly [string, string, string, boolean, boolean] {
    return (
        Array.isArray(value) &&
        value.length === 5 &&
        typeof value[0] === "string" &&
        typeof value[1] === "string" &&
        typeof value[2] === "string" &&
        typeof value[3] === "boolean" &&
        typeof value[4] === "boolean"
    );
}

function parseDatabaseCatalog(
    stdout: string
): readonly ProvisioningDatabaseCatalogEntry[] {
    if (stdout.includes("\0") || utf8Bytes(stdout) > catalogOutputMaximumBytes) fail();
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout.trim()) as unknown;
    } catch {
        fail();
    }
    if (!Array.isArray(parsed) || !parsed.every((value) => validCatalogTuple(value))) {
        fail();
    }
    const catalog = parsed.map(([oid, name, ownerOid, isTemplate, allowsConnections]) =>
        Object.freeze({ allowsConnections, isTemplate, name, oid, ownerOid })
    );
    const observedNames = catalog
        .filter(({ allowsConnections, isTemplate }) => allowsConnections && !isTemplate)
        .map(({ name }) => name);
    if (
        catalog.length === 0 ||
        catalog.length > provisioningCatalogDatabaseMaximum ||
        observedNames.length === 0 ||
        observedNames.length > provisioningDatabaseMaximum ||
        catalog.some(
            ({ name, oid, ownerOid }) =>
                !validDatabaseName(name) ||
                !/^[1-9][0-9]{0,9}$/u.test(oid) ||
                BigInt(oid) > 4_294_967_295n ||
                !/^[1-9][0-9]{0,9}$/u.test(ownerOid) ||
                BigInt(ownerOid) > 4_294_967_295n
        ) ||
        new Set(catalog.map(({ oid }) => oid)).size !== catalog.length ||
        new Set(catalog.map(({ name }) => name)).size !== catalog.length ||
        catalog.some(({ oid }, index) => {
            const previous = catalog[index - 1];
            return previous !== undefined && BigInt(previous.oid) >= BigInt(oid);
        })
    ) {
        fail();
    }
    return Object.freeze(catalog);
}

const catalogSql = `SELECT COALESCE(
  pg_catalog.json_agg(discovered.entry ORDER BY discovered.oid),
  '[]'::json
)
FROM (
  SELECT
    databases.oid,
    pg_catalog.json_build_array(
      databases.oid::text,
      databases.datname::text,
      databases.datdba::text,
      databases.datistemplate,
      databases.datallowconn
    ) AS entry
  FROM pg_catalog.pg_database AS databases
  ORDER BY databases.oid
  LIMIT ${String(provisioningCatalogDatabaseMaximum + 1)}
) AS discovered;
`;

const closeApprovedCollectionSql = `SET statement_timeout = '8s';
SET lock_timeout = '2s';
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(1835623521, 1668048243);
ALTER ROLE mira_dashboard_observer NOLOGIN
  VALID UNTIL '1970-01-01 00:00:00+00';
COMMENT ON ROLE mira_dashboard_observer IS NULL;
COMMIT;
DO $close_approved_collection$
DECLARE
  observer pg_catalog.pg_authid%ROWTYPE;
  observer_session record;
BEGIN
  FOR observer_session IN
    SELECT activity.pid
    FROM pg_catalog.pg_stat_activity AS activity
    WHERE activity.usename = 'mira_dashboard_observer'
      AND activity.pid <> pg_catalog.pg_backend_pid()
  LOOP
    IF NOT pg_catalog.pg_terminate_backend(observer_session.pid, 5000) THEN
      RAISE EXCEPTION 'Database observability collection session could not be terminated';
    END IF;
  END LOOP;
  PERFORM pg_catalog.pg_stat_clear_snapshot();
  SELECT * INTO observer
  FROM pg_catalog.pg_authid
  WHERE rolname = 'mira_dashboard_observer';
  IF observer.oid IS NULL
    OR observer.rolcanlogin
    OR observer.rolvaliduntil IS DISTINCT FROM
      '1970-01-01 00:00:00+00'::timestamp with time zone
    OR pg_catalog.shobj_description(observer.oid, 'pg_authid') IS NOT NULL
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_stat_activity AS activity
      WHERE activity.usename = 'mira_dashboard_observer'
        AND activity.pid <> pg_catalog.pg_backend_pid()
    )
  THEN
    RAISE EXCEPTION 'Database observability collection role did not close';
  END IF;
END
$close_approved_collection$;
`;

function asSqlArtifactName(value: string): ProvisioningSqlArtifactName {
    if (!provisioningSqlArtifactNameSet.has(value)) fail();
    return value as ProvisioningSqlArtifactName;
}

async function readContainedProvisioningArtifact(
    artifactRoot: string,
    fileName: ProvisioningPolicyArtifactName,
    state: SqlExpansionState
): Promise<string> {
    if (!provisioningPolicyArtifactNameSet.has(fileName)) fail();
    const candidate = path.join(artifactRoot, fileName);
    let file: Awaited<ReturnType<typeof open>> | undefined;
    let bytes: Buffer | undefined;
    let pathBefore: BigIntStats | undefined;
    try {
        file = await open(
            candidate,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
        const descriptorPath = await realpath(`/proc/self/fd/${String(file.fd)}`);
        if (descriptorPath !== candidate) fail();
        const descriptorBefore = await file.stat({ bigint: true });
        pathBefore = await lstat(candidate, { bigint: true });
        if (
            !validProvisioningArtifact(descriptorBefore, state) ||
            descriptorBefore.size <= 0n ||
            descriptorBefore.size > BigInt(sqlArtifactMaximumBytes) ||
            !validProvisioningArtifact(pathBefore, state) ||
            !sameProvisioningArtifactSnapshot(descriptorBefore, pathBefore)
        ) {
            fail();
        }
        if (fileName !== "runProvisioning.ts") {
            await state.afterDescriptorStat?.(fileName);
        }
        const expectedBytes = Number(descriptorBefore.size);
        const buffer = Buffer.alloc(expectedBytes + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.byteLength) {
            const read = await file.read(
                buffer,
                bytesRead,
                buffer.byteLength - bytesRead,
                null
            );
            if (read.bytesRead === 0) break;
            bytesRead += read.bytesRead;
        }
        const descriptorAfter = await file.stat({ bigint: true });
        if (
            bytesRead !== expectedBytes ||
            !validProvisioningArtifact(descriptorAfter, state) ||
            !sameProvisioningArtifactSnapshot(descriptorBefore, descriptorAfter)
        ) {
            fail();
        }
        bytes = buffer.subarray(0, bytesRead);
    } catch {
        fail();
    } finally {
        try {
            await file?.close();
        } catch {
            fail();
        }
    }
    const pathAfter = await lstat(candidate, { bigint: true });
    if (
        !bytes ||
        !pathBefore ||
        !validProvisioningArtifact(pathAfter, state) ||
        !sameProvisioningArtifactSnapshot(pathBefore, pathAfter) ||
        bytes.byteLength !== Number(pathBefore.size)
    ) {
        fail();
    }
    return decodeUtf8(bytes);
}

async function readContainedSqlArtifact(
    artifactRoot: string,
    fileName: ProvisioningSqlArtifactName,
    state: SqlExpansionState
): Promise<string> {
    return readContainedProvisioningArtifact(artifactRoot, fileName, state);
}

function validProvisioningArtifact(
    status: BigIntStats,
    state: SqlExpansionState
): boolean {
    return (
        status.isFile() &&
        !status.isSymbolicLink() &&
        status.nlink === 1n &&
        status.dev === state.artifactDevice &&
        status.uid === state.artifactOwner &&
        (status.mode & 0o7777n) === state.artifactMode
    );
}

function sameProvisioningArtifactSnapshot(
    before: BigIntStats,
    after: BigIntStats
): boolean {
    return (
        after.dev === before.dev &&
        after.ino === before.ino &&
        after.size === before.size &&
        after.ctimeNs === before.ctimeNs &&
        after.mtimeNs === before.mtimeNs
    );
}

async function expandSqlArtifactFile(
    artifactRoot: string,
    fileName: ProvisioningSqlArtifactName,
    depth: number,
    state: SqlExpansionState
): Promise<string> {
    if (
        depth > provisioningSqlIncludeDepthMaximum ||
        state.activeFiles.has(fileName) ||
        ++state.fileCount > provisioningSqlIncludeCountMaximum
    ) {
        fail();
    }
    state.activeFiles.add(fileName);
    try {
        const source = await readContainedSqlArtifact(artifactRoot, fileName, state);
        state.sourceBytes += utf8Bytes(source);
        if (state.sourceBytes > provisioningSqlInputMaximumBytes) fail();
        const lines = source.match(/[^\n]*(?:\n|$)/gu) ?? [];
        const expanded: string[] = [];
        for (const line of lines) {
            if (line === "") continue;
            const directive = line.replace(/\r?\n$/u, "");
            const include = /^[ \t]*\\ir[ \t]+([a-z0-9][a-z0-9-]*\.sql)[ \t]*$/u.exec(
                directive
            );
            if (include !== null) {
                expanded.push(
                    await expandSqlArtifactFile(
                        artifactRoot,
                        asSqlArtifactName(include[1]!),
                        depth + 1,
                        state
                    )
                );
                continue;
            }
            if (
                /^[ \t]*\\ir(?:[ \t]|$)/u.test(directive) ||
                /^[ \t]*\\(?:i|include|include_relative)(?:[ \t]|$)/u.test(directive)
            ) {
                fail();
            }
            expanded.push(line);
        }
        return expanded.join("");
    } finally {
        state.activeFiles.delete(fileName);
    }
}

async function expandSqlArtifact(
    fileName: ProvisioningSqlArtifactName,
    afterDescriptorStat?: SqlExpansionState["afterDescriptorStat"],
    sourceRoot = import.meta.dir
): Promise<string> {
    const artifactRoot = await realpath(sourceRoot);
    const [rootStatus, runnerStatus] = await Promise.all([
        lstat(artifactRoot, { bigint: true }),
        lstat(path.join(artifactRoot, "runProvisioning.ts"), { bigint: true }),
    ]);
    const runnerMode = runnerStatus.mode & 0o7777n;
    if (
        typeof process.getuid !== "function" ||
        !rootStatus.isDirectory() ||
        rootStatus.isSymbolicLink() ||
        rootStatus.dev !== runnerStatus.dev ||
        rootStatus.uid !== runnerStatus.uid ||
        rootStatus.uid !== BigInt(process.getuid()) ||
        (rootStatus.mode & 0o022n) !== 0n ||
        !runnerStatus.isFile() ||
        runnerStatus.isSymbolicLink() ||
        runnerStatus.nlink !== 1n ||
        (runnerMode !== 0o400n && runnerMode !== 0o600n && runnerMode !== 0o644n)
    ) {
        fail();
    }
    const sql = await expandSqlArtifactFile(artifactRoot, fileName, 0, {
        activeFiles: new Set<ProvisioningSqlArtifactName>(),
        afterDescriptorStat,
        artifactDevice: runnerStatus.dev,
        artifactMode: runnerMode,
        artifactOwner: runnerStatus.uid,
        fileCount: 0,
        sourceBytes: 0,
    });
    if (sql === "" || utf8Bytes(sql) > provisioningSqlInputMaximumBytes) fail();
    return sql;
}

async function calculateProvisioningPolicyDigest(
    sourceRoot = import.meta.dir
): Promise<string> {
    const artifactRoot = await realpath(sourceRoot);
    const [rootStatus, runnerStatus] = await Promise.all([
        lstat(artifactRoot, { bigint: true }),
        lstat(path.join(artifactRoot, "runProvisioning.ts"), { bigint: true }),
    ]);
    const runnerMode = runnerStatus.mode & 0o7777n;
    if (
        typeof process.getuid !== "function" ||
        !rootStatus.isDirectory() ||
        rootStatus.isSymbolicLink() ||
        rootStatus.dev !== runnerStatus.dev ||
        rootStatus.uid !== runnerStatus.uid ||
        rootStatus.uid !== BigInt(process.getuid()) ||
        (rootStatus.mode & 0o022n) !== 0n ||
        !runnerStatus.isFile() ||
        runnerStatus.isSymbolicLink() ||
        runnerStatus.nlink !== 1n ||
        (runnerMode !== 0o400n && runnerMode !== 0o600n && runnerMode !== 0o644n)
    ) {
        fail();
    }
    const state: SqlExpansionState = {
        activeFiles: new Set<ProvisioningSqlArtifactName>(),
        artifactDevice: runnerStatus.dev,
        artifactMode: runnerMode,
        artifactOwner: runnerStatus.uid,
        fileCount: 0,
        sourceBytes: 0,
    };
    const hash = new Bun.CryptoHasher("sha256");
    hash.update("mira-dashboard-database-observability-policy-v1\0", "utf8");
    for (const fileName of provisioningPolicyArtifactNames) {
        const source = await readContainedProvisioningArtifact(
            artifactRoot,
            fileName,
            state
        );
        const nameBytes = utf8Bytes(fileName);
        const sourceBytes = utf8Bytes(source);
        state.sourceBytes += sourceBytes;
        if (
            ++state.fileCount > provisioningSqlIncludeCountMaximum ||
            state.sourceBytes > provisioningSqlInputMaximumBytes
        ) {
            fail();
        }
        hash.update(`${String(nameBytes)}:`, "utf8");
        hash.update(fileName, "utf8");
        hash.update(`${String(sourceBytes)}:`, "utf8");
        hash.update(source, "utf8");
    }
    return hash.digest("hex");
}

function composePsqlRequest(
    target: ProvisioningComposeTarget,
    database: string | null,
    sql: string,
    options: {
        readonly deadlineMs?: number;
        readonly output?: "catalog" | "scalar";
        readonly variables?: readonly string[];
    } = {}
): DatabaseObservabilityProvisioningProcessRequest {
    if (
        (database !== null && !validDatabaseName(database)) ||
        !target.administrativeRoleOid ||
        !/^[1-9][0-9]{0,9}$/u.test(target.administrativeRoleOid) ||
        BigInt(target.administrativeRoleOid) > 4_294_967_295n ||
        !target.systemIdentifier ||
        !/^[1-9][0-9]{0,19}$/u.test(target.systemIdentifier)
    ) {
        fail();
    }
    const argv = [
        "--file",
        composeRootConfig,
        "--project-directory",
        composeRoot,
        "--project-name",
        target.project,
        "exec",
        "-T",
        "--index",
        "1",
        "--user",
        containerOperatingSystemUser,
        ...containerPsqlPrefix(target.service, containerPsqlLauncher),
        ...(options.variables ?? []).map((variable) => `--set=${variable}`),
        ...(database === null ? [] : ["--dbname", databaseUri(database)]),
        "--quiet",
        ...(options.output === undefined ? [] : ["--tuples-only", "--no-align"]),
    ];
    return Object.freeze({
        argv: Object.freeze(argv),
        cwd: composeRoot,
        deadlineMs: options.deadlineMs ?? processDeadlineMs,
        environment: provisioningProcessEnvironment,
        executable: composeExecutable,
        stdin: `${String.raw`\set ON_ERROR_STOP 1`}
SET statement_timeout = '30s';
SET lock_timeout = '5s';
DO $mira_dashboard_cluster_identity$
BEGIN
  IF CURRENT_USER IS DISTINCT FROM SESSION_USER
    OR NOT COALESCE((
      SELECT roles.rolsuper
      FROM pg_catalog.pg_roles AS roles
      WHERE roles.oid = '${target.administrativeRoleOid}'::pg_catalog.oid
        AND roles.rolname = CURRENT_USER
    ), false)
    OR (
    SELECT controls.system_identifier::text
    FROM pg_catalog.pg_control_system() AS controls
    ) IS DISTINCT FROM '${target.systemIdentifier}'
  THEN
    RAISE EXCEPTION USING MESSAGE = 'Database observability execution identity changed';
  END IF;
END
$mira_dashboard_cluster_identity$;
${sql.endsWith("\n") ? sql : `${sql}\n`}`,
        stdoutMaximumBytes:
            options.output === "catalog"
                ? catalogOutputMaximumBytes
                : psqlOutputMaximumBytes,
    });
}

async function runSql(
    run: DatabaseObservabilityProvisioningProcess,
    target: ProvisioningComposeTarget,
    database: string | null,
    sql: string,
    options: {
        readonly deadlineMs?: number;
        readonly output?: "catalog" | "scalar";
        readonly variables?: readonly string[];
    } = {},
    deadline?: ProvisioningDeadline
): Promise<string> {
    return executeProcess(
        run,
        composePsqlRequest(target, database, sql, options),
        deadline
    );
}

async function runSqlArtifact(
    run: DatabaseObservabilityProvisioningProcess,
    target: ProvisioningComposeTarget,
    database: string,
    fileName: ProvisioningSqlArtifactName,
    variables: readonly string[] = [],
    deadline?: ProvisioningDeadline,
    afterDescriptorStat?: SqlExpansionState["afterDescriptorStat"],
    artifactRoot = import.meta.dir
): Promise<void> {
    await runSql(
        run,
        target,
        database,
        await expandSqlArtifact(fileName, afterDescriptorStat, artifactRoot),
        {
            variables,
        },
        deadline
    );
}

function sameComposeTarget(
    left: ProvisioningComposeTarget,
    right: ProvisioningComposeTarget
): boolean {
    return (
        left.capabilityContainerId === right.capabilityContainerId &&
        left.containerId === right.containerId &&
        left.project === right.project &&
        left.service === right.service &&
        left.systemIdentifier === right.systemIdentifier &&
        left.administrativeRoleOid === right.administrativeRoleOid &&
        left.administrativeDatabase === right.administrativeDatabase
    );
}

function observedDatabaseNames(
    catalog: readonly ProvisioningDatabaseCatalogEntry[]
): readonly string[] {
    const names = catalog
        .filter(({ allowsConnections, isTemplate }) => allowsConnections && !isTemplate)
        .map(({ name }) => name)
        .toSorted();
    if (!names.includes(provisioningControlDatabase)) fail();
    return Object.freeze(names);
}

function databaseCatalogDigest(
    catalog: readonly ProvisioningDatabaseCatalogEntry[]
): string {
    return new Bun.CryptoHasher("sha256")
        .update("mira-dashboard-database-catalog-v1\0", "utf8")
        .update(JSON.stringify(catalog), "utf8")
        .digest("hex");
}

async function quarantineApplicationDatabase(
    run: DatabaseObservabilityProvisioningProcess,
    target: ProvisioningComposeTarget,
    entry: ProvisioningDatabaseCatalogEntry,
    deadline: ProvisioningDeadline
): Promise<void> {
    if (
        entry.name === provisioningControlDatabase ||
        entry.isTemplate ||
        !entry.allowsConnections ||
        !/^[1-9][0-9]{0,9}$/u.test(entry.oid) ||
        BigInt(entry.oid) > 4_294_967_295n
    ) {
        fail();
    }
    await runSql(
        run,
        target,
        provisioningControlDatabase,
        `DO $quarantine_drifted_database$
DECLARE
  database_name name;
  observer_oid oid;
BEGIN
  SELECT databases.datname INTO database_name
  FROM pg_catalog.pg_database AS databases
  WHERE databases.oid = '${entry.oid}'::pg_catalog.oid
    AND NOT databases.datistemplate
    AND databases.datallowconn;
  SELECT roles.oid INTO observer_oid
  FROM pg_catalog.pg_roles AS roles
  WHERE roles.rolname = 'mira_dashboard_observer';
  IF database_name IS NULL
    OR database_name = '${provisioningControlDatabase}'::name
    OR observer_oid IS NULL
  THEN
    RAISE EXCEPTION 'Database observability application quarantine target changed';
  END IF;
  EXECUTE pg_catalog.format(
    'REVOKE ALL PRIVILEGES ON DATABASE %I FROM mira_dashboard_observer',
    database_name
  );
  IF pg_catalog.has_database_privilege(observer_oid, database_name, 'CONNECT') THEN
    RAISE EXCEPTION 'Database observability application quarantine failed';
  END IF;
END
$quarantine_drifted_database$;
`,
        { deadlineMs: 10_000 },
        deadline
    );
}

async function closeApprovedCollection(
    run: DatabaseObservabilityProvisioningProcess,
    target: ProvisioningComposeTarget,
    deadline: ProvisioningDeadline
): Promise<void> {
    if (!target.administrativeDatabase) fail();
    await runSql(
        run,
        target,
        target.administrativeDatabase,
        closeApprovedCollectionSql,
        { deadlineMs: 10_000 },
        deadline
    );
}

async function verifyReconciliationApproval(
    run: DatabaseObservabilityProvisioningProcess,
    target: ProvisioningComposeTarget,
    policyDigest: string,
    deadline: ProvisioningDeadline,
    afterDescriptorStat?: SqlExpansionState["afterDescriptorStat"],
    artifactRoot = import.meta.dir
): Promise<void> {
    if (!/^[0-9a-f]{64}$/u.test(policyDigest)) fail();
    await runSqlArtifact(
        run,
        target,
        provisioningControlDatabase,
        "verify-reconciliation-approval.sql",
        [`approved_policy_digest=${policyDigest}`],
        deadline,
        afterDescriptorStat,
        artifactRoot
    );
}

async function enableApprovedCollection(
    run: DatabaseObservabilityProvisioningProcess,
    target: ProvisioningComposeTarget,
    policyDigest: string,
    collectionLeaseToken: string,
    deadline: ProvisioningDeadline,
    afterDescriptorStat?: SqlExpansionState["afterDescriptorStat"],
    artifactRoot = import.meta.dir
): Promise<void> {
    if (
        !catalogDigestPattern.test(policyDigest) ||
        !collectionLeaseTokenPattern.test(collectionLeaseToken)
    ) {
        fail();
    }
    const approvalVerification = await expandSqlArtifact(
        "verify-reconciliation-approval.sql",
        afterDescriptorStat,
        artifactRoot
    );
    const enableSql = await expandSqlArtifact(
        "enable-approved-collection.sql",
        afterDescriptorStat,
        artifactRoot
    );
    await runSql(
        run,
        target,
        provisioningControlDatabase,
        `BEGIN;
LOCK TABLE mira_dashboard_observability_control.reconciliation_approval
  IN SHARE MODE;
${approvalVerification}
${enableSql}
COMMIT;
`,
        {
            deadlineMs: 10_000,
            variables: [
                `approved_policy_digest=${policyDigest}`,
                `collection_lease_token=${collectionLeaseToken}`,
            ],
        },
        deadline
    );
}

async function prepareApprovedCollection(
    run: DatabaseObservabilityProvisioningProcess,
    target: ProvisioningComposeTarget,
    policyDigest: string,
    collectionLeaseToken: string,
    deadline: ProvisioningDeadline,
    afterDescriptorStat?: SqlExpansionState["afterDescriptorStat"],
    artifactRoot = import.meta.dir
): Promise<void> {
    if (
        !catalogDigestPattern.test(policyDigest) ||
        !collectionLeaseTokenPattern.test(collectionLeaseToken)
    ) {
        fail();
    }
    const approvalVerification = await expandSqlArtifact(
        "verify-reconciliation-approval.sql",
        afterDescriptorStat,
        artifactRoot
    );
    const prepareSql = await expandSqlArtifact(
        "prepare-approved-collection.sql",
        afterDescriptorStat,
        artifactRoot
    );
    await runSql(
        run,
        target,
        provisioningControlDatabase,
        `BEGIN;
LOCK TABLE mira_dashboard_observability_control.reconciliation_approval
  IN SHARE MODE;
${approvalVerification}
${prepareSql}
COMMIT;
`,
        {
            deadlineMs: 10_000,
            variables: [
                `approved_policy_digest=${policyDigest}`,
                `collection_lease_token=${collectionLeaseToken}`,
            ],
        },
        deadline
    );
}

/**
 * Discovers the one opted-in PgBouncer capability and its one healthy PostgreSQL
 * Compose dependency, then verifies the current catalog through container-local psql.
 * @param mode Approval-gated verification or activation mode.
 * @param dependencies Injectable fixed process boundary.
 * @returns Redacted status and bounded catalog count.
 */
export async function runDatabaseObservabilityProvisioning(
    mode: DatabaseObservabilityProvisioningMode,
    dependencies: DatabaseObservabilityProvisioningDependencies = {}
): Promise<DatabaseObservabilityProvisioningResult> {
    try {
        const run = dependencies.run ?? defaultProcess;
        const artifactRoot = dependencies.artifactRoot ?? import.meta.dir;
        const deadline = Object.freeze({
            expiresAt:
                Date.now() +
                (mode === "close-approved-collection"
                    ? closeOperationDeadlineMs
                    : provisioningOperationDeadlineMs),
        });
        const target = await discoverComposeTarget(run, deadline);
        if (
            !target.administrativeDatabase ||
            !validDatabaseName(target.administrativeDatabase) ||
            !target.systemIdentifier
        ) {
            fail();
        }
        const administrativeDatabase = target.administrativeDatabase;

        if (mode === "enable-approved-collection") {
            const collectionLeaseToken = dependencies.collectionLeaseToken;
            const expectedCatalogDigest = dependencies.catalogDigest;
            if (
                typeof collectionLeaseToken !== "string" ||
                !collectionLeaseTokenPattern.test(collectionLeaseToken) ||
                typeof expectedCatalogDigest !== "string" ||
                !catalogDigestPattern.test(expectedCatalogDigest)
            ) {
                fail();
            }
            const policyDigest = await calculateProvisioningPolicyDigest(artifactRoot);
            await verifyReconciliationApproval(
                run,
                target,
                policyDigest,
                deadline,
                dependencies.afterSqlArtifactDescriptorStat,
                artifactRoot
            );
            const catalog = parseDatabaseCatalog(
                await runSql(
                    run,
                    target,
                    provisioningControlDatabase,
                    catalogSql,
                    { output: "catalog" },
                    deadline
                )
            );
            const databaseNames = observedDatabaseNames(catalog);
            if (databaseCatalogDigest(catalog) !== expectedCatalogDigest) fail();
            if (!sameComposeTarget(target, await discoverComposeTarget(run, deadline))) {
                fail();
            }
            if ((await calculateProvisioningPolicyDigest(artifactRoot)) !== policyDigest)
                fail();
            await enableApprovedCollection(
                run,
                target,
                policyDigest,
                collectionLeaseToken,
                deadline,
                dependencies.afterSqlArtifactDescriptorStat,
                artifactRoot
            );
            return Object.freeze({
                databaseCount: databaseNames.length,
                mode,
                status: "OPENED",
            });
        }

        if (
            mode === "activate-current-catalog" ||
            mode === "close-approved-collection" ||
            mode === "open-approved-collection"
        ) {
            await closeApprovedCollection(run, target, deadline);
        }
        if (mode === "close-approved-collection") {
            if (!sameComposeTarget(target, await discoverComposeTarget(run, deadline))) {
                fail();
            }
            return Object.freeze({
                databaseCount: 0,
                mode,
                status: "CLOSED",
            });
        }

        const policyDigest = await calculateProvisioningPolicyDigest(artifactRoot);
        if (mode === "open-approved-collection") {
            await verifyReconciliationApproval(
                run,
                target,
                policyDigest,
                deadline,
                dependencies.afterSqlArtifactDescriptorStat,
                artifactRoot
            );
        }

        if (mode === "activate-current-catalog") {
            await runSqlArtifact(
                run,
                target,
                administrativeDatabase,
                "apply-control-database-capability.sql",
                ["apply_control_database_capability=approved"],
                deadline,
                dependencies.afterSqlArtifactDescriptorStat,
                artifactRoot
            );
        }

        const initialCatalog = parseDatabaseCatalog(
            await runSql(
                run,
                target,
                provisioningControlDatabase,
                catalogSql,
                {
                    output: "catalog",
                },
                deadline
            )
        );
        const databaseNames = observedDatabaseNames(initialCatalog);
        const catalogByName = new Map(
            initialCatalog.map((entry) => [entry.name, entry] as const)
        );
        const quarantinedApplicationDatabases = new Set<string>();
        const quarantineDriftedApplication = async (database: string) => {
            const entry = catalogByName.get(database);
            if (
                mode !== "open-approved-collection" ||
                database === provisioningControlDatabase ||
                entry === undefined
            ) {
                fail();
            }
            await verifyReconciliationApproval(
                run,
                target,
                policyDigest,
                deadline,
                dependencies.afterSqlArtifactDescriptorStat,
                artifactRoot
            );
            await quarantineApplicationDatabase(run, target, entry, deadline);
            quarantinedApplicationDatabases.add(database);
        };

        if (mode === "activate-current-catalog" || mode === "open-approved-collection") {
            if (mode === "open-approved-collection") {
                await verifyReconciliationApproval(
                    run,
                    target,
                    policyDigest,
                    deadline,
                    dependencies.afterSqlArtifactDescriptorStat,
                    artifactRoot
                );
            }
            await runSqlArtifact(
                run,
                target,
                provisioningControlDatabase,
                "apply-database-access-reconciler.sql",
                [],
                deadline,
                dependencies.afterSqlArtifactDescriptorStat,
                artifactRoot
            );
        }
        await runSqlArtifact(
            run,
            target,
            provisioningControlDatabase,
            "verify-database-access-reconciler.sql",
            [],
            deadline,
            dependencies.afterSqlArtifactDescriptorStat,
            artifactRoot
        );
        await runSqlArtifact(
            run,
            target,
            provisioningControlDatabase,
            "verify-cluster.sql",
            [],
            deadline,
            dependencies.afterSqlArtifactDescriptorStat,
            artifactRoot
        );
        const databaseCapabilitiesSql =
            mode === "activate-current-catalog" || mode === "open-approved-collection"
                ? await expandSqlArtifact(
                      "apply-database-capabilities.sql",
                      dependencies.afterSqlArtifactDescriptorStat,
                      artifactRoot
                  )
                : null;
        for (const database of databaseNames) {
            if (databaseCapabilitiesSql !== null) {
                if (mode === "open-approved-collection") {
                    await verifyReconciliationApproval(
                        run,
                        target,
                        policyDigest,
                        deadline,
                        dependencies.afterSqlArtifactDescriptorStat,
                        artifactRoot
                    );
                }
                try {
                    await runSql(
                        run,
                        target,
                        database,
                        databaseCapabilitiesSql,
                        {},
                        deadline
                    );
                } catch (error) {
                    if (
                        mode !== "open-approved-collection" ||
                        database === provisioningControlDatabase
                    ) {
                        throw error;
                    }
                    await quarantineDriftedApplication(database);
                }
            }
        }
        if (mode === "activate-current-catalog" || mode === "open-approved-collection") {
            if (mode === "open-approved-collection") {
                await verifyReconciliationApproval(
                    run,
                    target,
                    policyDigest,
                    deadline,
                    dependencies.afterSqlArtifactDescriptorStat,
                    artifactRoot
                );
            }
            await runSqlArtifact(
                run,
                target,
                provisioningControlDatabase,
                "apply-control-database.sql",
                ["apply_statement_capability=approved"],
                deadline,
                dependencies.afterSqlArtifactDescriptorStat,
                artifactRoot
            );
        }
        const [verifyControlDatabaseSql, verifyApplicationDatabaseSql] =
            await Promise.all([
                expandSqlArtifact(
                    "verify-control-database.sql",
                    dependencies.afterSqlArtifactDescriptorStat,
                    artifactRoot
                ),
                expandSqlArtifact(
                    "verify-database.sql",
                    dependencies.afterSqlArtifactDescriptorStat,
                    artifactRoot
                ),
            ]);
        for (const database of databaseNames) {
            if (quarantinedApplicationDatabases.has(database)) continue;
            try {
                await runSql(
                    run,
                    target,
                    database,
                    database === provisioningControlDatabase
                        ? verifyControlDatabaseSql
                        : verifyApplicationDatabaseSql,
                    {},
                    deadline
                );
            } catch (error) {
                if (
                    mode !== "open-approved-collection" ||
                    database === provisioningControlDatabase
                ) {
                    throw error;
                }
                await quarantineDriftedApplication(database);
            }
        }
        await runSqlArtifact(
            run,
            target,
            provisioningControlDatabase,
            "verify-control-database-capability.sql",
            [],
            deadline,
            dependencies.afterSqlArtifactDescriptorStat,
            artifactRoot
        );

        const confirmedCatalog = parseDatabaseCatalog(
            await runSql(
                run,
                target,
                provisioningControlDatabase,
                catalogSql,
                {
                    output: "catalog",
                },
                deadline
            )
        );
        if (JSON.stringify(confirmedCatalog) !== JSON.stringify(initialCatalog)) fail();

        const confirmedTarget = await discoverComposeTarget(run, deadline);
        if (!sameComposeTarget(target, confirmedTarget)) {
            fail();
        }

        if ((await calculateProvisioningPolicyDigest(artifactRoot)) !== policyDigest)
            fail();
        if (mode === "activate-current-catalog") {
            await runSqlArtifact(
                run,
                target,
                provisioningControlDatabase,
                "activate-observer.sql",
                [
                    `current_policy_digest=${policyDigest}`,
                    `approved_policy_digest=${policyDigest}`,
                ],
                deadline,
                dependencies.afterSqlArtifactDescriptorStat,
                artifactRoot
            );
            if (!sameComposeTarget(target, await discoverComposeTarget(run, deadline))) {
                fail();
            }
        } else if (mode === "open-approved-collection") {
            await verifyReconciliationApproval(
                run,
                target,
                policyDigest,
                deadline,
                dependencies.afterSqlArtifactDescriptorStat,
                artifactRoot
            );
            if (!sameComposeTarget(target, await discoverComposeTarget(run, deadline))) {
                fail();
            }
            const collectionLeaseToken = (
                dependencies.collectionLeaseTokenFactory ?? (() => crypto.randomUUID())
            )();
            if (!collectionLeaseTokenPattern.test(collectionLeaseToken)) fail();
            await prepareApprovedCollection(
                run,
                target,
                policyDigest,
                collectionLeaseToken,
                deadline,
                dependencies.afterSqlArtifactDescriptorStat,
                artifactRoot
            );
            return Object.freeze({
                catalogDigest: databaseCatalogDigest(confirmedCatalog),
                collectionLeaseToken,
                databaseCount: databaseNames.length,
                mode,
                status: "RECONCILED",
            });
        }
        let status: DatabaseObservabilityProvisioningResult["status"] = "VERIFIED";
        if (mode === "activate-current-catalog") status = "ACTIVATED";
        return Object.freeze({
            databaseCount: databaseNames.length,
            mode,
            status,
        });
    } catch {
        fail();
    }
}

if (import.meta.main) {
    try {
        const mode = process.argv[2];
        const standardMode =
            mode === "verify-current-catalog" ||
            mode === "activate-current-catalog" ||
            mode === "open-approved-collection" ||
            mode === "close-approved-collection";
        const validStandardInvocation =
            standardMode && process.argv.length === 4 && process.argv[3] === "--approved";
        const validEnableInvocation =
            mode === "enable-approved-collection" &&
            process.argv.length === 8 &&
            process.argv[3] === "--approved" &&
            process.argv[4] === "--collection-lease-token" &&
            collectionLeaseTokenPattern.test(process.argv[5] ?? "") &&
            process.argv[6] === "--catalog-digest" &&
            catalogDigestPattern.test(process.argv[7] ?? "");
        if (!validStandardInvocation && !validEnableInvocation) {
            process.stderr.write(`${usage}\n`);
            process.exitCode = 2;
        } else {
            const dependencies: DatabaseObservabilityProvisioningDependencies =
                mode === "enable-approved-collection"
                    ? {
                          catalogDigest: process.argv[7],
                          collectionLeaseToken: process.argv[5],
                      }
                    : {};
            const result = await runDatabaseObservabilityProvisioning(mode, dependencies);
            process.stdout.write(`${JSON.stringify(result)}\n`);
        }
    } catch {
        process.stderr.write(`${failureMessage}\n`);
        process.exitCode = 1;
    }
}
