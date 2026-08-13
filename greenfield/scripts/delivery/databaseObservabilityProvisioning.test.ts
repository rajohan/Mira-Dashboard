import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
    chmod,
    cp,
    lstat,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    symlink,
    unlink,
    writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
    databaseObservabilityDatabaseMaximum,
    databaseObservabilityObserverClientConnectionLimit,
    databaseObservabilityObserverConnectionLimit,
    databaseObservabilityObserverPoolSize,
    databaseObservabilityObserverReservePoolSize,
    databaseObservabilityObserverRole,
    databaseObservabilityPgBouncerVirtualDatabase,
    databaseObservabilityTorrentCountDatabases,
    databaseObservabilityViewOwnerRole,
} from "../../src/shared/databaseObservabilityPolicy.ts";
import { databaseObservabilityProvisioningReleaseArtifactPaths } from "./databaseObservabilityProvisioningPolicy.ts";
import {
    type DatabaseObservabilityProvisioningProcess,
    type DatabaseObservabilityProvisioningProcessRequest,
    provisioningControlDatabase,
    provisioningDatabaseMaximum,
    provisioningDockerContainerMaximum,
    provisioningDockerInspectFormat,
    provisioningProcessEnvironment,
    provisioningSqlIncludeCountMaximum,
    provisioningSqlIncludeDepthMaximum,
    provisioningSqlInputMaximumBytes,
    runDatabaseObservabilityProvisioning,
} from "./provisioning/database-observability/runProvisioning.ts";

const provisioningRoot = path.join(
    import.meta.dir,
    "provisioning/database-observability",
);

interface ProvisioningManifest {
    readonly activationOrder: readonly string[];
    readonly formatVersion: number;
    readonly observerRole: string;
    readonly pgBouncer: unknown;
    readonly postgresql: {
        readonly catalogDiscovery: unknown;
        readonly controlPoint: unknown;
        readonly observerConnectionLimit: number;
        readonly privilegedCollectionLease: unknown;
        readonly provisioningExecution: unknown;
        readonly reviewedDatabases?: unknown;
        readonly statementStatistics: unknown;
    };
    readonly torrentViews: readonly { readonly database: string }[];
    readonly verifyOrder: readonly string[];
    readonly viewOwnerRole: string;
}

async function readProvisioningFile(fileName: string): Promise<string> {
    return readFile(path.join(provisioningRoot, fileName), "utf8");
}

function catalogJson(
    names: readonly string[],
    options: { readonly templateNames?: ReadonlySet<string> } = {},
): string {
    return JSON.stringify(
        names.map((name, index) => [
            String(index + 10),
            name,
            "1",
            options.templateNames?.has(name) ?? false,
            true,
        ]),
    );
}

function catalogDigest(catalog: string): string {
    const parsed = JSON.parse(catalog) as readonly (readonly [
        string,
        string,
        string,
        boolean,
        boolean,
    ])[];
    const normalized = parsed.map(
        ([oid, name, ownerOid, isTemplate, allowsConnections]) => ({
            allowsConnections,
            isTemplate,
            name,
            oid,
            ownerOid,
        }),
    );
    return createHash("sha256")
        .update("mira-dashboard-database-catalog-v1\0", "utf8")
        .update(JSON.stringify(normalized), "utf8")
        .digest("hex");
}

interface ProvisioningDockerFixtureRow {
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

function provisioningContainerId(index: number): string {
    return index.toString(16).padStart(64, "0");
}

function provisioningDockerRow(
    index: number,
    overrides: Partial<ProvisioningDockerFixtureRow> = {},
): ProvisioningDockerFixtureRow {
    return Object.freeze({
        capability: null,
        configFiles: "/opt/docker/compose.yaml",
        containerNumber: "1",
        dependsOn: "",
        health: "healthy",
        id: provisioningContainerId(index),
        oneOff: "False",
        project: "docker",
        service: `unrelated-${String(index)}`,
        state: "running",
        workingDirectory: "/opt/docker",
        ...overrides,
    });
}

function validProvisioningDockerRows(): readonly ProvisioningDockerFixtureRow[] {
    return Object.freeze([
        provisioningDockerRow(1, {
            capability: "pgbouncer-v1",
            dependsOn: "postgres:service_healthy:false",
            service: "pgbouncer",
        }),
        provisioningDockerRow(2, { service: "postgres" }),
        provisioningDockerRow(3),
    ]);
}

function projectedProvisioningInspectLine(row: ProvisioningDockerFixtureRow): string {
    return [
        row.id,
        row.capability,
        row.project,
        row.service,
        row.dependsOn,
        row.workingDirectory,
        row.configFiles,
        row.containerNumber,
        row.oneOff,
        row.state,
        row.health,
    ]
        .map((value) => JSON.stringify(value))
        .join("\t");
}

function successfulProvisioningProcessResult(stdout = "") {
    return Promise.resolve({ exitCode: 0, stderr: "", stdout });
}

const noop = () => {};

async function rejectionText(operation: Promise<unknown>): Promise<string> {
    try {
        await operation;
        return "";
    } catch (error) {
        return String(error);
    }
}

function provisioningProcessFixture(options: {
    readonly administrativeDatabase?: string;
    readonly catalogs: readonly string[];
    readonly databaseUser?: string;
    readonly dockerSnapshots?: readonly (readonly ProvisioningDockerFixtureRow[])[];
    readonly roleOids?: readonly string[];
    readonly psqlServices?: ReadonlySet<string>;
    readonly systemIdentifiers?: readonly string[];
}): DatabaseObservabilityProvisioningProcess & {
    readonly requests: DatabaseObservabilityProvisioningProcessRequest[];
} {
    const requests: DatabaseObservabilityProvisioningProcessRequest[] = [];
    const snapshots = options.dockerSnapshots ?? [validProvisioningDockerRows()];
    let snapshotIndex = 0;
    let catalogIndex = 0;
    let identityIndex = 0;
    const run = ((request: DatabaseObservabilityProvisioningProcessRequest) => {
        requests.push(request);
        if (request.executable === "/usr/bin/docker") {
            const snapshot = snapshots[Math.min(snapshotIndex, snapshots.length - 1)];
            if (snapshot === undefined) throw new Error("Missing Docker snapshot");
            expect(request.argv.slice(0, 2)).toEqual([
                "--host",
                "unix:///var/run/docker.sock",
            ]);
            if (request.argv[2] === "ps") {
                return successfulProvisioningProcessResult(
                    snapshot.map(({ id }) => JSON.stringify(id)).join("\n"),
                );
            }
            if (request.argv[2] !== "inspect") {
                throw new Error("Unexpected Docker request");
            }
            snapshotIndex += 1;
            return successfulProvisioningProcessResult(
                snapshot.map((row) => projectedProvisioningInspectLine(row)).join("\n"),
            );
        }
        if (request.stdin?.includes("server_version_num") === true) {
            const shellIndex = request.argv.indexOf("/bin/sh");
            const service = request.argv[shellIndex - 1];
            if (!(options.psqlServices ?? new Set(["postgres"])).has(service ?? "")) {
                return Promise.resolve({ exitCode: 127, stderr: "", stdout: "" });
            }
            const selectedIdentityIndex = identityIndex++;
            const sequenceIndex = (values: readonly string[] | undefined) =>
                Math.min(selectedIdentityIndex, (values?.length ?? 1) - 1);
            return successfulProvisioningProcessResult(
                `${JSON.stringify([
                    options.databaseUser ?? "postgres",
                    options.databaseUser ?? "postgres",
                    true,
                    options.roleOids?.[sequenceIndex(options.roleOids)] ?? "10",
                    options.administrativeDatabase ?? "template1",
                    options.systemIdentifiers?.[
                        sequenceIndex(options.systemIdentifiers)
                    ] ?? "7600974291849326629",
                    "180004",
                ])}\n`,
            );
        }
        if (request.stdin?.includes("pg_catalog.json_agg(discovered.entry") === true) {
            const catalog = options.catalogs[catalogIndex++];
            if (catalog === undefined) throw new Error("Missing catalog output");
            return successfulProvisioningProcessResult(`${catalog}\n`);
        }
        return successfulProvisioningProcessResult();
    }) as DatabaseObservabilityProvisioningProcess & {
        readonly requests: typeof requests;
    };
    Object.defineProperty(run, "requests", { value: requests });
    return run;
}

describe("database observability provisioning", () => {
    test("inventories one deterministic approval-gated artifact set", async () => {
        const sourceEntries = await readdir(provisioningRoot);
        const entries = sourceEntries.toSorted();
        expect(databaseObservabilityProvisioningReleaseArtifactPaths).toEqual(
            entries.map(
                (fileName) =>
                    `scripts/delivery/provisioning/database-observability/${fileName}`,
            ),
        );
        for (const entry of entries) {
            const status = await lstat(path.join(provisioningRoot, entry), {
                bigint: true,
            });
            expect(status.isFile()).toBe(true);
            expect(status.isSymbolicLink()).toBe(false);
            expect(status.nlink).toBe(1n);
            expect(status.mode & 0o111n).toBe(0n);
            expect(status.size).toBeGreaterThan(0n);
            expect(status.size).toBeLessThanOrEqual(64n * 1024n);
        }
    });

    test("declares bounded catalog discovery and topology-independent ceilings", async () => {
        const manifest = JSON.parse(
            await readProvisioningFile("manifest.json"),
        ) as ProvisioningManifest;
        expect(provisioningDatabaseMaximum).toBe(databaseObservabilityDatabaseMaximum);
        expect(manifest.formatVersion).toBe(8);
        expect(manifest.observerRole).toBe(databaseObservabilityObserverRole);
        expect(manifest.viewOwnerRole).toBe(databaseObservabilityViewOwnerRole);
        expect(manifest.postgresql.catalogDiscovery).toEqual({
            maximumDatabases: databaseObservabilityDatabaseMaximum,
            order: "name-ascending",
            predicate: "datistemplate=false and datallowconn=true",
        });
        expect(manifest.postgresql.reviewedDatabases).toBeUndefined();
        expect(manifest.postgresql.controlPoint).toEqual({
            pgBouncerAlias: "mira_dashboard_observability",
            physicalDatabase: "mira_dashboard_observability",
            routing: "pgbouncer-wildcard-same-name",
            source: "code-owned-single-endpoint-capability",
        });
        expect(manifest.postgresql.privilegedCollectionLease).toEqual({
            actionKey: "cache.refresh.database-observability",
            scheduleId: "cache.database-observability",
            scheduleIntervalSeconds: 3600,
            providerGate: "configured-only",
            port: "separate worker-only privileged collection-lease port",
            commands: {
                open: "runProvisioning.ts open-approved-collection --approved",
                enable: "runProvisioning.ts enable-approved-collection --approved --collection-lease-token <uuid> --catalog-digest <sha256>",
                close: "runProvisioning.ts close-approved-collection --approved",
            },
            runner: "exact immutable release Bun runtime",
            processSupervision:
                "Linux parent-death signal plus isolated process-group TERM/KILL reap before settlement",
            approval: {
                artifact: "mira_dashboard_observability_control.reconciliation_approval",
                createdOrUpdatedBy: "explicit activate-current-catalog only",
                binding: [
                    "pg_control_system.system_identifier",
                    "exact current immutable-release policy digest",
                    "exact previous immutable-release policy digest",
                ],
                policyVersion:
                    "sanitized-capabilities-v1 is descriptive and never sufficient authorization",
                leaseMutation: "forbidden",
            },
            closedStateBetweenRuns: {
                login: false,
                validUntil: "expired",
                postgresqlSessions: 0,
                collectionLeaseComment: null,
            },
            phases: [
                "privileged close leftovers: set NOLOGIN, expire VALID UNTIL, terminate observer sessions, and recheck closed state",
                "open-approved-collection: verify exact approval and identity, perform the full bounded idempotent ACL-and-capability reconcile, keep NOLOGIN, and prepare one use collection token bound to the exact catalog digest",
                "enable-approved-collection: recheck approval, policy, PostgreSQL/Docker identity, and exact catalog digest, then atomically consume the token and set LOGIN with a short VALID UNTIL",
                "collect once through the least-privilege observer",
                "shielded mandatory close: atomically invalidate every prepared token, set NOLOGIN, expire VALID UNTIL, terminate observer sessions, and recheck closed state",
                "return the fresh payload to the generic cache executor only after exact close proof",
            ],
            reconciliation: {
                frequency: "every approved prepared open before one-use enable",
                operations: [
                    "reconcile exact database ACLs through the pinned administrative boundary",
                    "strictly apply and verify cluster and control capabilities; isolate application-database apply or policy drift for collector-level unavailable details",
                    "reject catalog, approval, policy-digest, PostgreSQL identity, or Docker identity races",
                ],
                persistedFingerprintOrAgeState: false,
                reducedPath: false,
            },
            failureSemantics:
                "cluster, control, approval, identity, catalog-race, enable, collection, or close failure prevents a fresh payload and cache commit; isolated application-database drift remains visible with unavailable details while other databases collect",
            pgBouncerWaitingClientLimitation:
                "closed PostgreSQL role and zero-session proof cannot prove that PgBouncer has no already-authenticated waiting client; no exclusive admission is added, and interference fails the attempt while NOLOGIN and expired VALID UNTIL prevent a new backend",
            additionalRuntimeSurfaces: {
                jobAction: false,
                schedule: false,
                systemdUnit: false,
                postgresqlLogin: false,
                exclusiveAdmission: false,
            },
        });
        expect(manifest.postgresql.provisioningExecution).toEqual({
            composeFile: "/opt/docker/compose.yaml",
            composeProjectDirectory: "/opt/docker",
            containerPsql: "/usr/local/bin/psql over /var/run/postgresql",
            dockerHost: "unix:///var/run/docker.sock",
            identityGuard:
                "superuser-role-oid, postgresql-system-identifier, activation approval, and exact current/previous policy digests",
            target: "single healthy PostgreSQL service_healthy dependency of the opted-in PgBouncer capability",
        });
        expect(manifest.postgresql.observerConnectionLimit).toBe(
            databaseObservabilityObserverConnectionLimit,
        );
        expect(manifest.postgresql.statementStatistics).toEqual({
            database: "mira_dashboard_observability",
            extension: "pg_stat_statements",
            source: "catalog-resolved pg_stat_statements(false) behind a NOLOGIN capability owner",
            target: "mira_dashboard_observability_capabilities.statement_metrics()",
        });
        expect(manifest.pgBouncer).toEqual({
            adminUserForbidden: databaseObservabilityObserverRole,
            observerUserPolicy: {
                max_user_client_connections:
                    databaseObservabilityObserverClientConnectionLimit,
                max_user_connections: databaseObservabilityObserverConnectionLimit,
                pool_size: databaseObservabilityObserverPoolSize,
                reserve_pool_size: databaseObservabilityObserverReservePoolSize,
            },
            statsUserRequired: databaseObservabilityObserverRole,
            virtualDatabase: databaseObservabilityPgBouncerVirtualDatabase,
        });
        expect(manifest.torrentViews.map(({ database }) => database)).toEqual(
            databaseObservabilityTorrentCountDatabases,
        );
        expect(JSON.stringify(manifest)).not.toMatch(
            /aiomanager|aiometadata|aiostreams|authelia|crowdsec|metabase|speedtest_tracker/u,
        );
        expect(manifest.verifyOrder).toContain(
            "runProvisioning.ts verify-current-catalog --approved after initial activation",
        );
        expect(manifest.activationOrder[0]).toBe(
            "runProvisioning.ts activate-current-catalog --approved",
        );
        expect(JSON.stringify(manifest)).not.toContain(
            "mira_dashboard_database_access_reconciler",
        );
        expect(JSON.stringify(manifest)).not.toMatch(/15-second|reconciliation-loop/u);
    });

    test("keeps names dynamic across all provisioning artifacts except torrent views", async () => {
        const entries = await readdir(provisioningRoot);
        const fileContents = await Promise.all(
            entries.map((entry) => readProvisioningFile(entry)),
        );
        const contents = fileContents.join("\n");
        expect(contents).not.toMatch(
            /aiomanager|aiometadata|aiostreams|authelia|crowdsec|metabase|speedtest_tracker/u,
        );
        expect(contents).not.toContain(String.raw`\connect`);
        expect(contents).not.toContain("127.0.0.1");
        expect(contents).not.toContain(":6432");
        for (const name of databaseObservabilityTorrentCountDatabases) {
            expect(contents).toContain(name);
        }
    });

    test("quarantines exact roles and refuses role-GUC, membership, and default-ACL drift", async () => {
        const apply = await readProvisioningFile("apply-cluster.sql");
        const accessApply = await readProvisioningFile(
            "apply-database-access-reconciler.sql",
        );
        const accessVerify = await readProvisioningFile(
            "verify-database-access-reconciler.sql",
        );
        const cluster = await readProvisioningFile("verify-cluster.sql");
        const database = await readProvisioningFile("verify-database.sql");
        expect(apply).toContain(
            `NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${String(databaseObservabilityObserverConnectionLimit)}`,
        );
        expect(apply).toContain("ALTER ROLE mira_dashboard_observer RESET ALL;");
        expect(apply).toContain("SET default_transaction_read_only = on;");
        expect(apply).toContain("SET statement_timeout = '5s';");
        expect(apply).toContain("pg_terminate_backend(reserved_session.pid, 5000)");
        expect(apply).toContain("observer_inbound_membership_count <> 0");
        expect(apply).toContain("admin_option OR NOT inherit_option OR NOT set_option");
        expect(cluster).toContain("settings.setdatabase <> 0");
        expect(database).toContain("pg_catalog.pg_default_acl");
        expect(database).toContain("defaults.defaclrole = observer_oid");
        expect(database).toContain("grants.grantee <> 0");
        expect(database).toContain(
            "pg_catalog.pg_has_role(observer_oid, grants.grantee, 'USAGE')",
        );
        expect(database).toContain("routines.prosecdef");
        expect(database).toContain("pg_catalog.has_function_privilege(");
        expect(database).toContain("Database observability routine grants are invalid");
        expect(accessApply).toContain("REVOKE ALL PRIVILEGES ON DATABASE %I FROM PUBLIC");
        expect(accessApply).toContain(
            "GRANT CONNECT ON DATABASE %I TO mira_dashboard_observer",
        );
        expect(accessVerify).toContain("grants.grantee = 0");
        expect(accessVerify).toContain("databases.datistemplate");
        expect(apply).not.toContain("GRANT CONNECT ON DATABASE");
        expect(apply).not.toContain("REVOKE ALL PRIVILEGES ON DATABASE");
    });

    test("installs one exact bounded database-owned access reconciler", async () => {
        const apply = await readProvisioningFile("apply-database-access-reconciler.sql");
        const verify = await readProvisioningFile(
            "verify-database-access-reconciler.sql",
        );
        const activation = await readProvisioningFile("activate-observer.sql");
        const body = apply.match(/AS \$reconcile\$(?<body>[\s\S]*?)\$reconcile\$/u)
            ?.groups?.body;
        expect(body).toBeDefined();
        if (body === undefined) throw new Error("Reconciler body is absent");
        const digest = createHash("sha256").update(body).digest("hex");

        expect(verify).toContain(digest);
        expect(apply.indexOf("$administrator_boundary$")).toBeLessThan(
            apply.indexOf("CREATE SCHEMA IF NOT EXISTS"),
        );
        expect(apply).not.toContain("mira_dashboard_database_access_reconciler LOGIN");
        expect(
            body.indexOf("observed_database_count > maximum_observed_databases"),
        ).toBeLessThan(body.indexOf("FOR database_record IN"));
        expect(body).toContain(
            "pg_catalog.pg_advisory_xact_lock(1296646465, 1128351300)",
        );
        expect(body).toContain("pg_catalog.format(");
        expect(body).toContain("DATABASE %I");
        expect(body).toContain("final_owner_oids IS DISTINCT FROM initial_owner_oids");
        expect(apply).toContain("SECURITY DEFINER");
        expect(apply).toContain("SET search_path TO pg_catalog");
        expect(verify).toContain("routine.proconfig IS DISTINCT FROM");
        expect(verify).toContain(
            "pg_catalog.count(*) FROM pg_catalog.pg_proc AS routines",
        );
        expect(activation).not.toContain(
            "ALTER ROLE mira_dashboard_database_access_reconciler LOGIN;",
        );
        expect(
            activation.match(/\\ir verify-control-database-capability\.sql/gu),
        ).toHaveLength(1);
        expect(activation.match(/\\ir verify-control-database\.sql/gu)).toHaveLength(1);
        expect(activation).toContain(
            "ALTER ROLE mira_dashboard_observer NOLOGIN\n  VALID UNTIL '1970-01-01 00:00:00+00';",
        );
        expect(activation).toContain("observer.rolpassword NOT LIKE 'SCRAM-SHA-256$%'");
    });

    test("projects one stable capability from the catalog-resolved extension relation", async () => {
        const apply = await readProvisioningFile("apply-control-database.sql");
        const verify = await readProvisioningFile("verify-control-database.sql");
        expect(apply).toContain("extensions.extname = 'pg_stat_statements'");
        expect(apply).toContain("classes.relnamespace = extensions.extnamespace");
        expect(apply).toContain("pg_catalog.format(");
        expect(apply).toContain(
            "CREATE FUNCTION mira_dashboard_observability_capabilities.statement_metrics()",
        );
        expect(apply).toContain("SECURITY DEFINER");
        expect(apply).toContain("public.pg_stat_statements(false)");
        expect(apply).toContain("total_exec_time::double precision");
        expect(apply).toContain("FROM PUBLIC");
        expect(apply).toContain("FROM mira_dashboard_observer");
        expect(apply).toContain("member_count NOT BETWEEN 1 AND 64");
        expect(apply).toContain("'$libdir/pg_stat_statements'");
        expect(apply).toContain("source_routine.proallargtypes");
        expect(verify).toContain("member_count NOT BETWEEN 1 AND 64");
        expect(verify).toContain("WHERE grants.grantee = 0");
        expect(verify).toContain("source_routine.proallargtypes");
        expect(verify).toContain("dependencies.refobjid = source_routine.oid");
        expect(verify).not.toMatch(/extversion|1\.12/u);
    });

    test("creates and safely retains one exact physical control database capability", async () => {
        const applyCapability = await readProvisioningFile(
            "apply-control-database-capability.sql",
        );
        const applyControl = await readProvisioningFile("apply-control-database.sql");
        const verifyCapability = await readProvisioningFile(
            "verify-control-database-capability.sql",
        );
        const rollbackCapability = await readProvisioningFile(
            "rollback-control-database-capability.sql",
        );

        expect(provisioningControlDatabase).toBe("mira_dashboard_observability");
        expect(applyCapability).toContain(
            "CREATE DATABASE mira_dashboard_observability OWNER %I TEMPLATE template0 CONNECTION LIMIT 4 STRATEGY WAL_LOG",
        );
        expect(applyCapability).toContain(String.raw`\gexec`);
        expect(applyCapability).toContain("TO :'apply_control_database_capability';");
        expect(applyCapability).toContain(
            "pg_catalog.current_setting(\n      'mira_dashboard.apply_control_database_capability'",
        );
        expect(applyControl).toContain("TO :'apply_statement_capability';");
        expect(
            applyCapability.slice(applyCapability.indexOf("DO $approval_and_preflight$")),
        ).not.toContain(":'apply_control_database_capability'");
        expect(
            applyControl.slice(applyControl.indexOf("DO $approval_guard$")),
        ).not.toContain(":'apply_statement_capability'");
        expect(applyCapability.indexOf("$approval_and_preflight$")).toBeLessThan(
            applyCapability.indexOf("CREATE DATABASE mira_dashboard_observability"),
        );
        expect(applyCapability).toContain("catalog_database_count > 80");
        expect(applyCapability).toContain("observed_database_count > 64");
        expect(applyControl.match(/CREATE EXTENSION/gu)).toHaveLength(1);
        expect(applyControl).toContain(
            "CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA public;",
        );
        expect(verifyCapability).toContain("'pg_stat_statements:public'");
        expect(verifyCapability).toContain("'plpgsql:pg_catalog'");
        expect(verifyCapability).toContain(
            "extensions.extowner IS DISTINCT FROM database_owner_oid",
        );
        expect(rollbackCapability).toContain(
            "physical capability database is deliberately retained",
        );
        expect(rollbackCapability).not.toMatch(/^\s*DROP\s+DATABASE/imu);
    });

    test("runner discovers one PostgreSQL dependency, executes fixed psql, and rechecks activation races", async () => {
        const catalog = catalogJson(
            ["template1", "app-b", provisioningControlDatabase, "app-a"],
            {
                templateNames: new Set(["template1"]),
            },
        );
        const run = provisioningProcessFixture({ catalogs: [catalog, catalog] });
        const result = await runDatabaseObservabilityProvisioning(
            "activate-current-catalog",
            { run },
        );
        expect(result).toEqual({
            databaseCount: 3,
            mode: "activate-current-catalog",
            status: "ACTIVATED",
        });
        const composeRequests = run.requests.filter(
            ({ executable, stdin }) =>
                executable === "/opt/docker/bin/docker-compose-doppler" && stdin !== null,
        );
        const psqlRequests = composeRequests.filter(
            ({ stdin }) => !stdin?.includes("server_version_num"),
        );
        const requestSql = psqlRequests.map(({ stdin }) => stdin ?? "");
        const acceptedLaunchers = new Set([
            ': "${POSTGRES_USER:?}"; exec /usr/bin/env -i HOME=/var/lib/postgresql LANG=C LC_ALL=C PATH=/usr/local/bin:/usr/bin:/bin PGUSER="$POSTGRES_USER" /usr/bin/timeout -s TERM -k 2 45 /usr/local/bin/psql --host=/var/run/postgresql --username="$POSTGRES_USER" --no-psqlrc --set=ON_ERROR_STOP=1 "$@"',
            ': "${POSTGRES_USER:?}"; exec /usr/bin/env -i HOME=/var/lib/postgresql LANG=C LC_ALL=C PATH=/usr/local/bin:/usr/bin:/bin PGUSER="$POSTGRES_USER" /usr/bin/timeout -s TERM -k 1 3 /usr/local/bin/psql --host=/var/run/postgresql --username="$POSTGRES_USER" --no-psqlrc --set=ON_ERROR_STOP=1 "$@"',
        ]);
        expect(
            composeRequests.every(
                ({ argv, cwd, environment, executable }) =>
                    executable === "/opt/docker/bin/docker-compose-doppler" &&
                    cwd === "/opt/docker" &&
                    environment === provisioningProcessEnvironment &&
                    JSON.stringify(argv.slice(0, 15)) ===
                        JSON.stringify([
                            "--file",
                            "/opt/docker/compose.yaml",
                            "--project-directory",
                            "/opt/docker",
                            "--project-name",
                            "docker",
                            "exec",
                            "-T",
                            "--index",
                            "1",
                            "--user",
                            "postgres",
                            "postgres",
                            "/bin/sh",
                            "-ceu",
                        ]) &&
                    acceptedLaunchers.has(argv[15] ?? "") &&
                    argv[16] === "mira-dashboard-psql",
            ),
        ).toBe(true);
        expect(
            composeRequests.every(
                ({ argv }) =>
                    argv[0] === "--file" &&
                    argv[1] === "/opt/docker/compose.yaml" &&
                    argv[2] === "--project-directory" &&
                    argv[3] === "/opt/docker",
            ),
        ).toBe(true);
        expect(psqlRequests.every(({ argv }) => !argv.includes("--command"))).toBe(true);
        expect(
            psqlRequests.every(
                ({ stdin }) =>
                    stdin?.includes("controls.system_identifier::text") &&
                    stdin.includes("roles.oid = '10'::pg_catalog.oid") &&
                    stdin.includes("CURRENT_USER IS DISTINCT FROM SESSION_USER"),
            ),
        ).toBe(true);
        expect(requestSql.some((sql) => sql.includes("$approval_and_preflight$"))).toBe(
            true,
        );
        expect(requestSql.some((sql) => sql.includes("CREATE EXTENSION"))).toBe(true);
        expect(requestSql.every((sql) => !/^[ \t]*\\ir[ \t]/mu.test(sql))).toBe(true);
        const reconcileIndex = requestSql.findIndex((sql) =>
            sql.includes("mira_dashboard_database_access.reconcile()"),
        );
        const clusterVerifyIndex = requestSql.findIndex((sql) =>
            sql.includes("Database observability view owner is invalid"),
        );
        expect(reconcileIndex).toBeGreaterThan(-1);
        expect(reconcileIndex).toBeLessThan(clusterVerifyIndex);
        const capabilityApplyIndex = requestSql.findIndex((sql) =>
            sql.includes("$approval_and_preflight$"),
        );
        const initialCatalogIndex = requestSql.findIndex((sql) =>
            sql.includes("pg_catalog.json_agg(discovered.entry"),
        );
        expect(capabilityApplyIndex).toBeGreaterThan(-1);
        expect(capabilityApplyIndex).toBeLessThan(initialCatalogIndex);
        expect(
            requestSql.some((sql) => sql.includes("$verify_database_access_reconciler$")),
        ).toBe(true);
        expect(
            requestSql.some(
                (sql) =>
                    sql.includes("ALTER ROLE mira_dashboard_observer LOGIN") &&
                    sql.includes("ALTER ROLE mira_dashboard_observer NOLOGIN") &&
                    sql.includes("VALID UNTIL '1970-01-01 00:00:00+00'") &&
                    sql.includes("$verify_reconciliation_approval$"),
            ),
        ).toBe(true);
        expect(
            run.requests.filter(({ executable }) => executable === "/usr/bin/docker"),
        ).toHaveLength(6);
    });

    test("opens only after approved reconciliation and closes independently", async () => {
        const catalog = catalogJson([provisioningControlDatabase, "app"]);
        const collectionLeaseToken = "12345678-1234-4123-8123-123456789abc";
        const openRun = provisioningProcessFixture({ catalogs: [catalog, catalog] });
        expect(
            await runDatabaseObservabilityProvisioning("open-approved-collection", {
                collectionLeaseTokenFactory: () => collectionLeaseToken,
                run: openRun,
            }),
        ).toEqual({
            catalogDigest: catalogDigest(catalog),
            collectionLeaseToken,
            databaseCount: 2,
            mode: "open-approved-collection",
            status: "RECONCILED",
        });
        const openSql = openRun.requests
            .filter(({ stdin }) => stdin !== null)
            .map(({ stdin }) => stdin ?? "");
        const firstMutationIndex = openSql.findIndex((sql) =>
            sql.includes("$administrator_boundary$"),
        );
        const firstApprovalIndex = openSql.findIndex((sql) =>
            sql.includes("$verify_reconciliation_approval$"),
        );
        const finalPrepareIndex = openSql.findIndex((sql) =>
            sql.includes("$prepare_approved_collection$"),
        );
        expect(firstApprovalIndex).toBeGreaterThan(-1);
        expect(firstApprovalIndex).toBeLessThan(firstMutationIndex);
        expect(finalPrepareIndex).toBeGreaterThan(firstMutationIndex);
        expect(finalPrepareIndex).toBe(openSql.length - 1);
        expect(openSql[finalPrepareIndex]).toContain(
            "LOCK TABLE mira_dashboard_observability_control.reconciliation_approval\n  IN SHARE MODE",
        );
        expect(openSql[finalPrepareIndex]).toContain("$verify_reconciliation_approval$");
        expect(openSql[finalPrepareIndex]).toContain(
            "'mira-dashboard-collection-lease:' ||",
        );
        expect(openRun.requests.at(-1)?.argv).toContain(
            `--set=collection_lease_token=${collectionLeaseToken}`,
        );
        expect(openSql[finalPrepareIndex]).not.toContain(
            "ALTER ROLE mira_dashboard_observer LOGIN",
        );

        const enableRun = provisioningProcessFixture({ catalogs: [catalog] });
        expect(
            await runDatabaseObservabilityProvisioning("enable-approved-collection", {
                catalogDigest: catalogDigest(catalog),
                collectionLeaseToken,
                run: enableRun,
            }),
        ).toEqual({
            databaseCount: 2,
            mode: "enable-approved-collection",
            status: "OPENED",
        });
        const enableSql = enableRun.requests
            .filter(({ stdin }) => stdin !== null)
            .map(({ stdin }) => stdin ?? "");
        const finalOpenIndex = enableSql.findIndex((sql) =>
            sql.includes("$open_approved_collection$"),
        );
        expect(finalOpenIndex).toBe(enableSql.length - 1);
        expect(enableSql[finalOpenIndex]).toContain("$verify_reconciliation_approval$");
        expect(enableSql[finalOpenIndex]).toContain(
            "SELECT pg_catalog.pg_advisory_xact_lock(1835623521, 1668048243)",
        );
        expect(enableSql[finalOpenIndex]).toContain(
            "ALTER ROLE mira_dashboard_observer LOGIN VALID UNTIL %L",
        );
        expect(enableSql[finalOpenIndex]).toContain("IS DISTINCT FROM expected_comment");
        expect(enableRun.requests.at(-1)?.argv).toContain(
            `--set=collection_lease_token=${collectionLeaseToken}`,
        );
        expect(
            enableSql[finalOpenIndex]!.indexOf("$verify_reconciliation_approval$"),
        ).toBeLessThan(enableSql[finalOpenIndex]!.indexOf("$open_approved_collection$"));
        expect(
            enableSql
                .slice(finalOpenIndex + 1)
                .some((sql) => sql.includes("$administrator_boundary$")),
        ).toBeFalse();

        const closeRun = provisioningProcessFixture({ catalogs: [] });
        expect(
            await runDatabaseObservabilityProvisioning("close-approved-collection", {
                run: closeRun,
            }),
        ).toEqual({
            databaseCount: 0,
            mode: "close-approved-collection",
            status: "CLOSED",
        });
        const closeSql = closeRun.requests
            .filter(({ stdin }) => stdin !== null)
            .map(({ stdin }) => stdin ?? "");
        expect(closeSql.some((sql) => sql.includes("$close_approved_collection$"))).toBe(
            true,
        );
        expect(
            closeSql.some((sql) =>
                sql.includes("COMMENT ON ROLE mira_dashboard_observer IS NULL"),
            ),
        ).toBe(true);
        expect(closeSql.some((sql) => sql.includes("pg_advisory_xact_lock"))).toBe(true);
        expect(closeSql.every((sql) => !sql.includes("reconciliation_approval"))).toBe(
            true,
        );
        expect(closeSql.every((sql) => !sql.includes("PASSWORD"))).toBe(true);
    });

    test("isolates application-database drift during prepared open but fails control drift", async () => {
        const catalog = catalogJson([provisioningControlDatabase, "app", "healthy"]);
        const applicationBase = provisioningProcessFixture({
            catalogs: [catalog, catalog],
        });
        const applicationDrift: DatabaseObservabilityProvisioningProcess = (request) => {
            if (
                request.argv.includes("postgresql:///%61%70%70") &&
                request.stdin?.includes(
                    "Database observability routine grants are invalid",
                ) === true
            ) {
                return Promise.resolve({ exitCode: 1, stderr: "", stdout: "" });
            }
            return applicationBase(request);
        };
        const prepared = await runDatabaseObservabilityProvisioning(
            "open-approved-collection",
            {
                collectionLeaseTokenFactory: () => "12345678-1234-4123-8123-123456789abc",
                run: applicationDrift,
            },
        );
        expect(prepared.status).toBe("RECONCILED");
        const quarantineSql = applicationBase.requests
            .map(({ stdin }) => stdin ?? "")
            .filter((sql) => sql.includes("$quarantine_drifted_database$"));
        expect(quarantineSql.length).toBeGreaterThanOrEqual(1);
        expect(
            quarantineSql.every(
                (sql) =>
                    sql.includes("databases.oid = '11'::pg_catalog.oid") &&
                    sql.includes(
                        "REVOKE ALL PRIVILEGES ON DATABASE %I FROM mira_dashboard_observer",
                    ) &&
                    !sql.includes("databases.oid = '12'::pg_catalog.oid"),
            ),
        ).toBe(true);
        expect(
            applicationBase.requests.some(
                ({ argv, stdin }) =>
                    argv.includes("postgresql:///%68%65%61%6C%74%68%79") &&
                    stdin?.includes(
                        "Database observability routine grants are invalid",
                    ) === true,
            ),
        ).toBe(true);
        expect(
            applicationBase.requests.some(({ stdin }) =>
                stdin?.includes("$prepare_approved_collection$"),
            ),
        ).toBe(true);

        const controlBase = provisioningProcessFixture({ catalogs: [catalog] });
        const controlDrift: DatabaseObservabilityProvisioningProcess = (request) => {
            if (
                request.stdin?.includes(
                    "Database observability control capability is invalid",
                ) === true
            ) {
                return Promise.resolve({ exitCode: 1, stderr: "", stdout: "" });
            }
            return controlBase(request);
        };
        expect(
            runDatabaseObservabilityProvisioning("open-approved-collection", {
                collectionLeaseTokenFactory: () => "12345678-1234-4123-8123-123456789abc",
                run: controlDrift,
            }),
        ).rejects.toThrow("Database observability provisioning failed");
        expect(
            controlBase.requests.some(({ stdin }) =>
                stdin?.includes("$prepare_approved_collection$"),
            ),
        ).toBe(false);
    });

    test("a delayed enable cannot reopen after an independently completed close", async () => {
        const catalog = catalogJson([provisioningControlDatabase]);
        const collectionLeaseToken = "12345678-1234-4123-8123-123456789abc";
        const base = provisioningProcessFixture({
            catalogs: [catalog, catalog, catalog],
        });
        let storedLeaseComment: string | null = null;
        let observerCanLogin = false;
        let releaseEnable = noop;
        const enableRelease = new Promise<void>((resolve) => {
            releaseEnable = resolve;
        });
        let announceEnable = noop;
        const enableReached = new Promise<void>((resolve) => {
            announceEnable = resolve;
        });
        const statefulProcess: DatabaseObservabilityProvisioningProcess = async (
            request,
        ) => {
            if (request.stdin?.includes("$open_approved_collection$") === true) {
                announceEnable();
                await enableRelease;
                if (
                    storedLeaseComment !==
                    `mira-dashboard-collection-lease:${collectionLeaseToken}`
                ) {
                    return { exitCode: 1, stderr: "", stdout: "" };
                }
                storedLeaseComment = null;
                observerCanLogin = true;
                return successfulProvisioningProcessResult();
            }
            const result = await base(request);
            if (request.stdin?.includes("$prepare_approved_collection$") === true) {
                storedLeaseComment = `mira-dashboard-collection-lease:${collectionLeaseToken}`;
            }
            if (request.stdin?.includes("$close_approved_collection$") === true) {
                storedLeaseComment = null;
                observerCanLogin = false;
            }
            return result;
        };

        const prepared = await runDatabaseObservabilityProvisioning(
            "open-approved-collection",
            {
                collectionLeaseTokenFactory: () => collectionLeaseToken,
                run: statefulProcess,
            },
        );
        const delayedEnable = runDatabaseObservabilityProvisioning(
            "enable-approved-collection",
            {
                catalogDigest: prepared.catalogDigest,
                collectionLeaseToken,
                run: statefulProcess,
            },
        );
        await enableReached;
        await runDatabaseObservabilityProvisioning("close-approved-collection", {
            run: statefulProcess,
        });
        expect(storedLeaseComment).toBeNull();
        expect(observerCanLogin).toBe(false);
        releaseEnable();
        expect(delayedEnable).rejects.toThrow(
            "Database observability provisioning failed",
        );
        expect(observerCanLogin).toBe(false);
    });

    test("runner rejects over-limit, duplicate, malformed, and changed inventories", () => {
        const maximumNames = Array.from(
            { length: provisioningDatabaseMaximum + 1 },
            (_, index) => `db-${String(index).padStart(2, "0")}`,
        );
        for (const catalog of [
            catalogJson(maximumNames),
            JSON.stringify([
                ["10", "duplicate", "1", false, true],
                ["11", "duplicate", "1", false, true],
            ]),
            JSON.stringify([["10", "bad\0name", "1", false, true]]),
            JSON.stringify([["10", "bad\nname", "1", false, true]]),
            JSON.stringify([["10", "bad\u200Bname", "1", false, true]]),
            JSON.stringify([["10", "bad\u2028name", "1", false, true]]),
            JSON.stringify([["10", "bad\u2029name", "1", false, true]]),
            JSON.stringify([["10", "   ", "1", false, true]]),
            JSON.stringify([["0", provisioningControlDatabase, "1", false, true]]),
            JSON.stringify([
                ["11", provisioningControlDatabase, "1", false, true],
                ["10", "other", "1", false, true],
            ]),
        ]) {
            const run = provisioningProcessFixture({ catalogs: [catalog] });
            expect(
                runDatabaseObservabilityProvisioning("verify-current-catalog", {
                    run,
                }),
            ).rejects.toThrow("Database observability provisioning failed");
        }

        const firstCatalog = catalogJson([provisioningControlDatabase]);
        const secondCatalog = catalogJson([provisioningControlDatabase, "new"]);
        const run = provisioningProcessFixture({
            catalogs: [firstCatalog, secondCatalog],
        });
        expect(
            runDatabaseObservabilityProvisioning("activate-current-catalog", {
                run,
            }),
        ).rejects.toThrow("Database observability provisioning failed");
    });

    test("runner percent-encodes every database-name byte before fixed psql argv", async () => {
        const rawNames = [
            "..",
            "quote/slash",
            "host=attacker dbname=x",
            "postgresql://evil/x",
        ];
        const catalog = catalogJson([provisioningControlDatabase, ...rawNames]);
        const run = provisioningProcessFixture({ catalogs: [catalog, catalog] });
        await runDatabaseObservabilityProvisioning("verify-current-catalog", {
            run,
        });

        const databaseArguments = run.requests.flatMap(({ argv }) =>
            argv.flatMap((argument, index) =>
                argument === "--dbname" ? [argv[index + 1] ?? ""] : [],
            ),
        );
        expect(databaseArguments).toContain("postgresql:///%2E%2E");
        expect(databaseArguments).toContain(
            "postgresql:///%71%75%6F%74%65%2F%73%6C%61%73%68",
        );
        expect(databaseArguments).toContain(
            "postgresql:///%68%6F%73%74%3D%61%74%74%61%63%6B%65%72%20%64%62%6E%61%6D%65%3D%78",
        );
        expect(databaseArguments).toContain(
            "postgresql:///%70%6F%73%74%67%72%65%73%71%6C%3A%2F%2F%65%76%69%6C%2F%78",
        );
        expect(
            databaseArguments.every(
                (argument) => !rawNames.some((name) => argument.includes(name)),
            ),
        ).toBe(true);
    });

    test("bounds and projects only the Docker topology fields needed for provisioning", () => {
        expect(provisioningDockerContainerMaximum).toBe(256);
        expect(provisioningSqlIncludeDepthMaximum).toBe(8);
        expect(provisioningSqlIncludeCountMaximum).toBe(32);
        expect(provisioningSqlInputMaximumBytes).toBe(512 * 1024);
        expect(provisioningDockerInspectFormat).toContain(
            "com.docker.compose.depends_on",
        );
        expect(provisioningDockerInspectFormat).toContain(
            "com.docker.compose.container-number",
        );
        expect(provisioningDockerInspectFormat).toContain("com.docker.compose.oneoff");
        expect(provisioningDockerInspectFormat).not.toContain(".Config.Env");
        expect(provisioningDockerInspectFormat).not.toContain(".Mounts");
        expect(provisioningDockerInspectFormat).not.toContain("{{json .Config.Labels}}");
    });

    test("tolerates unrelated dependencies and resolves one psql-capable healthy dependency", async () => {
        const catalog = catalogJson([provisioningControlDatabase]);
        const rows = [
            provisioningDockerRow(1, {
                capability: "pgbouncer-v1",
                dependsOn:
                    "cache:service_healthy:false,Postgres_Primary:service_healthy:false,web:service_started:false",
                project: "Docker.Project",
                service: "Pool.Service",
            }),
            provisioningDockerRow(2, {
                project: "Docker.Project",
                service: "cache",
            }),
            provisioningDockerRow(3, {
                project: "Docker.Project",
                service: "Postgres_Primary",
            }),
            provisioningDockerRow(4, {
                project: "Docker.Project",
                service: "web",
            }),
        ];
        const run = provisioningProcessFixture({
            catalogs: [catalog, catalog],
            dockerSnapshots: [rows],
            psqlServices: new Set(["Postgres_Primary"]),
        });

        const result = await runDatabaseObservabilityProvisioning(
            "verify-current-catalog",
            { run },
        );
        expect(result).toEqual({
            databaseCount: 1,
            mode: "verify-current-catalog",
            status: "VERIFIED",
        });
        expect(
            run.requests.some(
                ({ argv }) =>
                    argv.includes("Docker.Project") && argv.includes("Postgres_Primary"),
            ),
        ).toBe(true);
    });

    test("fails closed for ambiguous or drifting Docker execution targets", async () => {
        const catalog = catalogJson([provisioningControlDatabase]);
        const ambiguousRows = [
            provisioningDockerRow(1, {
                capability: "pgbouncer-v1",
                dependsOn:
                    "postgres-a:service_healthy:false,postgres-b:service_healthy:false",
                service: "pool",
            }),
            provisioningDockerRow(2, { service: "postgres-a" }),
            provisioningDockerRow(3, { service: "postgres-b" }),
        ];
        const ambiguousRun = provisioningProcessFixture({
            catalogs: [catalog],
            dockerSnapshots: [ambiguousRows],
            psqlServices: new Set(["postgres-a", "postgres-b"]),
        });
        expect(
            await rejectionText(
                runDatabaseObservabilityProvisioning("verify-current-catalog", {
                    run: ambiguousRun,
                }),
            ),
        ).toBe("Error: Database observability provisioning failed");

        const changedRows = validProvisioningDockerRows().map((row) =>
            row.service === "postgres"
                ? { ...row, id: provisioningContainerId(20) }
                : row,
        );
        const driftRun = provisioningProcessFixture({
            catalogs: [catalog, catalog],
            dockerSnapshots: [validProvisioningDockerRows(), changedRows],
        });
        expect(
            await rejectionText(
                runDatabaseObservabilityProvisioning("activate-current-catalog", {
                    run: driftRun,
                }),
            ),
        ).toBe("Error: Database observability provisioning failed");
        expect(
            driftRun.requests.some(({ stdin }) =>
                stdin?.includes("ALTER ROLE mira_dashboard_observer LOGIN;"),
            ),
        ).toBe(false);

        const roleDriftRun = provisioningProcessFixture({
            catalogs: [catalog, catalog],
            roleOids: ["10", "11"],
        });
        expect(
            await rejectionText(
                runDatabaseObservabilityProvisioning("activate-current-catalog", {
                    run: roleDriftRun,
                }),
            ),
        ).toBe("Error: Database observability provisioning failed");
        expect(
            roleDriftRun.requests.some(({ stdin }) =>
                stdin?.includes("ALTER ROLE mira_dashboard_observer LOGIN;"),
            ),
        ).toBe(false);
    });

    test("bounds Docker inventory and redacts process failures and host secrets", async () => {
        const catalog = catalogJson([provisioningControlDatabase]);
        const overflowRows = Array.from(
            { length: provisioningDockerContainerMaximum + 1 },
            (_, index) => provisioningDockerRow(index + 1),
        );
        const overflowRun = provisioningProcessFixture({
            catalogs: [catalog],
            dockerSnapshots: [overflowRows],
        });
        expect(
            await rejectionText(
                runDatabaseObservabilityProvisioning("verify-current-catalog", {
                    run: overflowRun,
                }),
            ),
        ).toBe("Error: Database observability provisioning failed");

        const secret = "must-not-cross-provisioning-boundary";
        const originalSecret = process.env.MIRA_TEST_SENTINEL_SECRET;
        process.env.MIRA_TEST_SENTINEL_SECRET = secret;
        const baseRun = provisioningProcessFixture({ catalogs: [catalog, catalog] });
        const failingRun: DatabaseObservabilityProvisioningProcess = async (request) => {
            if (request.stdin?.includes("pg_catalog.current_database()") === true) {
                return { exitCode: 1, stderr: secret, stdout: secret };
            }
            return baseRun(request);
        };
        let failure: unknown;
        try {
            await runDatabaseObservabilityProvisioning("verify-current-catalog", {
                run: failingRun,
            });
        } catch (error) {
            failure = error;
        } finally {
            if (originalSecret === undefined) {
                delete process.env.MIRA_TEST_SENTINEL_SECRET;
            } else {
                process.env.MIRA_TEST_SENTINEL_SECRET = originalSecret;
            }
        }
        expect(String(failure)).toBe("Error: Database observability provisioning failed");
        expect(String(failure)).not.toContain(secret);
        expect(JSON.stringify(baseRun.requests)).not.toContain(secret);
        expect(
            baseRun.requests.every(
                ({ environment, stdin }) =>
                    environment === provisioningProcessEnvironment &&
                    (stdin === null ||
                        Buffer.byteLength(stdin) <= provisioningSqlInputMaximumBytes),
            ),
        ).toBe(true);
    });

    test("pins provisioning artifacts to one bounded regular-file descriptor", async () => {
        const catalog = catalogJson([provisioningControlDatabase]);
        const privateParent = await mkdtemp(
            "/tmp/mira-dashboard-provisioning-descriptor-test-",
        );
        const privateProvisioningRoot = path.join(
            privateParent,
            "database-observability",
        );
        await cp(provisioningRoot, privateProvisioningRoot, {
            preserveTimestamps: true,
            recursive: true,
        });
        const artifact = path.join(privateProvisioningRoot, "verify-cluster.sql");
        const displaced = `${artifact}.descriptor-test`;
        const original = await readFile(artifact);
        const artifactStatus = await lstat(artifact);
        const mode = artifactStatus.mode & 0o777;

        const runMutation = async (
            mutate: () => Promise<void>,
            restore: () => Promise<void>,
        ) => {
            let mutated = false;
            try {
                expect(
                    await rejectionText(
                        runDatabaseObservabilityProvisioning("verify-current-catalog", {
                            artifactRoot: privateProvisioningRoot,
                            afterSqlArtifactDescriptorStat: async (fileName) => {
                                if (fileName !== "verify-cluster.sql" || mutated) {
                                    return;
                                }
                                mutated = true;
                                await mutate();
                            },
                            run: provisioningProcessFixture({
                                catalogs: [catalog, catalog],
                            }),
                        }),
                    ),
                ).toBe("Error: Database observability provisioning failed");
            } finally {
                if (mutated) await restore();
            }
        };

        try {
            await runMutation(
                async () => {
                    await rename(artifact, displaced);
                    await symlink(displaced, artifact);
                },
                async () => {
                    await unlink(artifact);
                    await rename(displaced, artifact);
                },
            );
            await runMutation(
                async () => {
                    await rename(artifact, displaced);
                    await writeFile(artifact, original, { mode });
                },
                async () => {
                    await unlink(artifact);
                    await rename(displaced, artifact);
                },
            );
            await runMutation(
                async () => {
                    await rename(artifact, displaced);
                    const fifo = Bun.spawn(["/usr/bin/mkfifo", artifact], {
                        stderr: "pipe",
                        stdout: "pipe",
                    });
                    if ((await fifo.exited) !== 0) throw new Error("mkfifo failed");
                },
                async () => {
                    await unlink(artifact);
                    await rename(displaced, artifact);
                },
            );
            await runMutation(
                async () => {
                    await writeFile(artifact, Buffer.alloc(64 * 1024 + 1, 0x20));
                },
                async () => {
                    await writeFile(artifact, original);
                    await chmod(artifact, mode);
                },
            );
        } finally {
            await rm(privateParent, { force: true, recursive: true });
        }
    });

    test("keeps SQL non-interactive, bounded and free of secret or shell surfaces", async () => {
        const entries = await readdir(provisioningRoot);
        for (const fileName of entries.filter((name) => name.endsWith(".sql"))) {
            const sql = await readProvisioningFile(fileName);
            expect(sql.startsWith("\\set ON_ERROR_STOP 1\n")).toBe(true);
            expect(sql).not.toContain("\0");
            expect(sql).not.toMatch(
                /\\!|COPY[\s\S]*PROGRAM|ALTER SYSTEM|dblink|postgres_fdw|docker|sudo|private-password|postgresql:\/\//iu,
            );
            if (fileName === "apply-control-database.sql") {
                expect(sql.match(/CREATE EXTENSION/gu)).toHaveLength(1);
            } else {
                expect(sql).not.toMatch(/CREATE EXTENSION/iu);
            }
        }
        const runner = await readProvisioningFile("runProvisioning.ts");
        expect(runner).toContain('const dockerExecutable = "/usr/bin/docker"');
        expect(runner).toContain(
            'const composeExecutable = "/opt/docker/bin/docker-compose-doppler"',
        );
        expect(runner).toContain("/usr/local/bin/psql");
        expect(runner).toContain("provisioningProcessEnvironment");
        expect(runner).not.toContain('"/usr/bin/psql"');
        expect(runner).not.toContain("env: process.env");
        expect(runner).not.toMatch(/shell:\s*true|Bun\.\$|node:child_process/u);
    });
});
