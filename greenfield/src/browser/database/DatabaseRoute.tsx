import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
    ArchiveRestore,
    Database,
    HardDrive,
    RefreshCw,
    ScrollText,
    ShieldCheck,
} from "lucide-react";

import type { DatabaseOverview } from "../../contracts/database.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { formatByteCount, formatPercent } from "../lib/formatMeasurements.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { MetricCard } from "../ui/MetricCard.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { PageState } from "../ui/PageState.tsx";
import { Text } from "../ui/Text.tsx";
import {
    databaseOverviewQueryKey,
    databaseOverviewQueryOptions,
} from "./databaseQueries.ts";
import {
    normalizeDatabaseSearch,
    type DatabaseRouteSearch,
} from "./databaseRouteSearch.ts";
import { PostgresqlDatabaseOverview } from "./PostgresqlDatabaseOverview.tsx";

function ObservationTime({ timestampMs }: { readonly timestampMs: number }) {
    return (
        <time dateTime={new Date(timestampMs).toISOString()}>
            {formatDashboardDateTime(timestampMs)}
        </time>
    );
}

function ConnectionPolicy({ overview }: { readonly overview: DatabaseOverview }) {
    if (overview.sqlite.state === "unavailable") return null;
    const policy = overview.sqlite.connection;
    const rows = [
        ["Journal mode", policy.journalMode.toUpperCase()],
        ["Synchronous mode", policy.synchronousMode],
        ["Busy policy", policy.busyPolicy],
        ["WAL checkpoint", `${policy.walAutoCheckpointPages.toLocaleString()} pages`],
        ["Foreign keys", policy.foreignKeysEnabled ? "Enforced" : "Not enforced"],
        ["Integrity checks", policy.checksEnforced ? "Enforced" : "Not enforced"],
        ["Trusted schema", policy.trustedSchemaEnabled ? "Enabled" : "Disabled"],
    ] as const;
    return (
        <Card aria-labelledby="database-policy-heading">
            <Heading id="database-policy-heading" level={2} size="section">
                Connection policy
            </Heading>
            <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                {rows.map(([label, value]) => (
                    <div className="border-primary-700 rounded-lg border p-3" key={label}>
                        <dt className="text-primary-400 text-sm">{label}</dt>
                        <dd className="text-primary-50 mt-1 font-medium">{value}</dd>
                    </div>
                ))}
            </dl>
        </Card>
    );
}

type AvailableSqliteObservation = Extract<
    DatabaseOverview["sqlite"],
    { readonly state: "fresh" | "last-known-good" }
>;

type SqliteLifecycleObservation =
    | AvailableSqliteObservation["lifecycle"]["backupInventory"]
    | AvailableSqliteObservation["lifecycle"]["maintenance"]
    | AvailableSqliteObservation["lifecycle"]["restoreVerification"];

function SqliteLifecycleObservationStatus({
    label,
    observation,
}: {
    readonly label: string;
    readonly observation: SqliteLifecycleObservation;
}) {
    const retained = observation.state === "last-known-good";
    let badgeLabel = "Current";
    let badgeVariant: "default" | "success" | "warning" = "success";
    if (observation.state === "unavailable") {
        badgeLabel = "Unavailable";
        badgeVariant = "default";
    } else if (retained) {
        badgeLabel = "Last-known-good";
        badgeVariant = "warning";
    }
    return (
        <div className="border-primary-700 rounded-lg border p-3">
            <Text size="sm" tone="muted">
                {label}
            </Text>
            <div className="mt-1 flex flex-wrap items-center gap-2">
                <Badge variant={badgeVariant}>{badgeLabel}</Badge>
                {retained ? (
                    <Text size="sm" tone="muted">
                        Retained since{" "}
                        <ObservationTime timestampMs={observation.staleSinceMs} />
                    </Text>
                ) : null}
            </div>
        </div>
    );
}

function SqliteStorageDetails({
    sqlite,
}: {
    readonly sqlite: AvailableSqliteObservation;
}) {
    const { storage } = sqlite;
    const { permissions } = storage;
    const rows = [
        [
            "Database file",
            `${sqlite.fileName} · ${formatByteCount(storage.databaseBytes)}`,
        ],
        ["WAL", formatByteCount(storage.walBytes)],
        ["Shared memory", formatByteCount(storage.shmBytes)],
        ["Total storage", formatByteCount(storage.storageBytes)],
        [
            "Pages",
            `${storage.pageCount.toLocaleString()} × ${formatByteCount(storage.pageSizeBytes)}`,
        ],
        [
            "Reusable space",
            `${storage.freePages.toLocaleString()} pages · ${formatByteCount(storage.freeBytes)} · ${formatPercent(storage.freePercent)}`,
        ],
        [
            "Permission modes",
            `${permissions.dataDirectory} / ${permissions.database} / ${permissions.wal ?? "—"} / ${permissions.shm ?? "—"}`,
        ],
    ] as const;
    return (
        <Card aria-labelledby="sqlite-storage-heading">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <Heading id="sqlite-storage-heading" level={2} size="section">
                    SQLite storage
                </Heading>
                <Badge variant={permissions.secure ? "success" : "warning"}>
                    {permissions.secure ? "Permissions secure" : "Permission review"}
                </Badge>
            </div>
            <Text className="mt-1" tone="muted">
                Fixed-file sizes, reusable pages, and modes without host paths.
            </Text>
            <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                {rows.map(([label, value]) => (
                    <div className="border-primary-700 rounded-lg border p-3" key={label}>
                        <dt className="text-primary-400 text-sm">{label}</dt>
                        <dd className="text-primary-50 mt-1 font-medium wrap-break-word">
                            {value}
                        </dd>
                    </div>
                ))}
            </dl>
        </Card>
    );
}

function SqliteLifecycleBoundaries({
    lifecycle,
}: {
    readonly lifecycle: AvailableSqliteObservation["lifecycle"];
}) {
    const inventory = lifecycle.backupInventory;
    const verification = lifecycle.restoreVerification;
    const maintenance = lifecycle.maintenance;
    const latestBackup =
        inventory.state === "unavailable" ? undefined : inventory.backups[0];
    const latestRun =
        maintenance.state === "unavailable" ? undefined : maintenance.runs[0];
    const latestRunAtMs = latestRun?.finishedAtMs ?? latestRun?.startedAtMs;
    const backupKinds =
        inventory.state === "unavailable"
            ? "Unavailable"
            : (["scheduled", "cutover"] as const)
                  .map((kind) => ({
                      count: inventory.backups.filter((backup) => backup.kind === kind)
                          .length,
                      kind,
                  }))
                  .filter(({ count }) => count > 0)
                  .map(({ count, kind }) => `${kind}: ${count.toLocaleString()}`)
                  .join(" · ") || "None";
    let restoreVerificationSummary: string;
    if (verification.state === "unavailable") {
        restoreVerificationSummary =
            verification.reason === "no-verified-backup"
                ? "No verified backup yet"
                : "Unavailable";
    } else {
        restoreVerificationSummary = `Verified ${formatDashboardDateTime(verification.verifiedAtMs)}`;
    }
    let recurringMaintenanceSummary = "Unavailable";
    if (maintenance.state !== "unavailable") {
        recurringMaintenanceSummary = maintenance.enabled
            ? `${maintenance.schedule.timeOfDay} ${maintenance.schedule.timeZone} · ${maintenance.runs.length.toLocaleString()} retained runs`
            : "Disabled";
    }
    const rows = [
        [
            "Backup inventory",
            inventory.state === "unavailable"
                ? "Unavailable"
                : `${inventory.backups.length.toLocaleString()} verified · ${formatByteCount(inventory.totalBytes)}`,
        ],
        ["Backup kinds", backupKinds],
        [
            "Latest backup",
            latestBackup === undefined
                ? "None"
                : `${latestBackup.kind} · ${latestBackup.verificationLevel} · ${formatDashboardDateTime(latestBackup.createdAtMs)} · ${formatByteCount(latestBackup.bytes)}`,
        ],
        ["Restore verification", restoreVerificationSummary],
        [
            "Latest maintenance",
            latestRun === undefined
                ? "No run recorded"
                : `${latestRun.state}${latestRunAtMs === undefined ? "" : ` · ${formatDashboardDateTime(latestRunAtMs)}`}`,
        ],
        [
            "Latest successful maintenance",
            maintenance.state === "unavailable" ||
            maintenance.latestSuccessfulAtMs === undefined
                ? "No successful run recorded"
                : formatDashboardDateTime(maintenance.latestSuccessfulAtMs),
        ],
        ["Recurring maintenance", recurringMaintenanceSummary],
    ] as const;
    return (
        <Card aria-labelledby="sqlite-lifecycle-heading">
            <Heading id="sqlite-lifecycle-heading" level={2} size="section">
                Backup, restore &amp; maintenance
            </Heading>
            <Text className="mt-1" tone="muted">
                Bounded scheduled and cutover snapshots with explicit verification levels
                and durable maintenance history, without backup paths or raw failures.
            </Text>
            <section
                aria-label="SQLite lifecycle observation states"
                className="mt-4 grid gap-3 sm:grid-cols-3"
            >
                <SqliteLifecycleObservationStatus
                    label="Backup inventory"
                    observation={inventory}
                />
                <SqliteLifecycleObservationStatus
                    label="Restore verification"
                    observation={verification}
                />
                <SqliteLifecycleObservationStatus
                    label="Maintenance history"
                    observation={maintenance}
                />
            </section>
            <dl className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {rows.map(([label, value]) => (
                    <div className="border-primary-700 rounded-lg border p-3" key={label}>
                        <dt className="text-primary-400 text-sm">{label}</dt>
                        <dd className="text-primary-50 mt-1 font-medium">{value}</dd>
                    </div>
                ))}
            </dl>
        </Card>
    );
}

const sqliteBackupAttentionAgeMs = 48 * 60 * 60_000;
const sqliteMaintenanceAttentionAgeMs = 48 * 60 * 60_000;
const terminalMaintenanceStates = new Set([
    "cancelled",
    "failed",
    "succeeded",
    "timed-out",
]);
const unsuccessfulMaintenanceStates = new Set(["cancelled", "failed", "timed-out"]);

function sqliteLifecycleAttention(
    lifecycle: AvailableSqliteObservation["lifecycle"],
    observedAtMs: number
): readonly string[] {
    const alerts: string[] = [];
    const inventory = lifecycle.backupInventory;
    if (inventory.state === "unavailable") {
        alerts.push("SQLite backup inventory is unavailable.");
    } else {
        const latestRestoreVerified = inventory.backups.find(
            (backup) => backup.verificationLevel === "restore-copy-verified"
        );
        if (latestRestoreVerified === undefined) {
            alerts.push("No verified SQLite maintenance backup is available yet.");
        } else if (
            observedAtMs - latestRestoreVerified.createdAtMs >=
            sqliteBackupAttentionAgeMs
        ) {
            alerts.push(
                "The latest verified SQLite maintenance backup is older than expected."
            );
        }
    }

    const maintenance = lifecycle.maintenance;
    if (maintenance.state === "unavailable") {
        alerts.push("SQLite maintenance status is unavailable.");
    } else if (maintenance.enabled) {
        if (maintenance.latestSuccessfulAtMs === undefined) {
            alerts.push("Scheduled SQLite maintenance has no successful run yet.");
        } else if (
            observedAtMs - maintenance.latestSuccessfulAtMs >=
            sqliteMaintenanceAttentionAgeMs
        ) {
            alerts.push(
                "The latest successful SQLite maintenance run is older than 48 hours."
            );
        }
        const latestTerminal = maintenance.runs.find((run) =>
            terminalMaintenanceStates.has(run.state)
        );
        if (
            latestTerminal !== undefined &&
            unsuccessfulMaintenanceStates.has(latestTerminal.state)
        ) {
            alerts.push(
                `The latest terminal SQLite maintenance run ${latestTerminal.state}.`
            );
        }
    } else {
        alerts.push("Scheduled SQLite maintenance is disabled.");
    }
    return alerts;
}

function DatabaseOverviewContent({
    browserCacheRetained,
    overview,
}: {
    readonly browserCacheRetained: boolean;
    readonly overview: DatabaseOverview;
}) {
    if (overview.sqlite.state === "unavailable") {
        return (
            <PageState
                description="No previously verified SQLite observation is available. Retry after the Dashboard database is ready."
                icon={Database}
                status="empty"
                title="SQLite diagnostics unavailable"
            />
        );
    }
    const { migrations } = overview.sqlite;
    const { storage } = overview.sqlite;
    const retained = overview.sqlite.state === "last-known-good";
    let observationBadgeLabel = "Fresh observation";
    if (retained) observationBadgeLabel = "Last-known-good";
    else if (browserCacheRetained) observationBadgeLabel = "Browser cache retained";
    const lifecycleAlerts = sqliteLifecycleAttention(
        overview.sqlite.lifecycle,
        overview.sqlite.observedAtMs
    );
    return (
        <PageState status="ready">
            <div className="space-y-6">
                {retained ? (
                    <Alert
                        focusOnError={false}
                        message="The latest SQLite diagnostics check failed. Showing the most recent verified observation."
                        variant="info"
                    />
                ) : null}
                {storage.requiresVacuumReview ? (
                    <Alert
                        focusOnError={false}
                        message={`SQLite has ${formatByteCount(storage.freeBytes)} (${formatPercent(storage.freePercent)}) reusable space. Review a planned VACUUM before reclaiming it.`}
                        variant="info"
                    />
                ) : null}
                {lifecycleAlerts.map((message) => (
                    <Alert
                        focusOnError={false}
                        key={message}
                        message={message}
                        variant="info"
                    />
                ))}
                <div className="flex flex-wrap items-center gap-3">
                    <Badge
                        variant={retained || browserCacheRetained ? "warning" : "success"}
                    >
                        {observationBadgeLabel}
                    </Badge>
                    {browserCacheRetained && retained ? (
                        <Badge variant="warning">Browser cache retained</Badge>
                    ) : null}
                    <Text size="sm" tone="muted">
                        Observed{" "}
                        <ObservationTime timestampMs={overview.sqlite.observedAtMs} />
                    </Text>
                    {overview.sqlite.state === "last-known-good" ? (
                        <Text size="sm" tone="muted">
                            Retained since{" "}
                            <ObservationTime timestampMs={overview.sqlite.staleSinceMs} />
                        </Text>
                    ) : null}
                </div>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    <MetricCard
                        description={`Canonical ${overview.sqlite.fileName} without its host path.`}
                        icon={HardDrive}
                        title="Database file"
                        value={formatByteCount(storage.databaseBytes)}
                    />
                    <MetricCard
                        description={`${formatByteCount(storage.walBytes)} WAL · ${formatByteCount(storage.shmBytes)} shared memory.`}
                        icon={Database}
                        title="Total SQLite storage"
                        value={formatByteCount(storage.storageBytes)}
                    />
                    <MetricCard
                        description={`${storage.freePages.toLocaleString()} reusable pages · ${formatPercent(storage.freePercent)}.`}
                        icon={ArchiveRestore}
                        title="Reusable space"
                        value={formatByteCount(storage.freeBytes)}
                    />
                    <MetricCard
                        description="Applied versus bundled Dashboard migrations."
                        icon={ScrollText}
                        meter={{
                            label: "Applied database migrations",
                            maximum: migrations.available,
                            value: migrations.applied,
                        }}
                        title="Migrations"
                        value={`${migrations.applied} / ${migrations.available}`}
                    />
                    <MetricCard
                        description="Schema compatibility for this Dashboard release."
                        icon={ShieldCheck}
                        title="Schema state"
                        value={migrations.current ? "Current" : "Migration required"}
                    />
                    <MetricCard
                        description="The reviewed embedded database source."
                        icon={Database}
                        title="Database source"
                        value="SQLite"
                    />
                    <MetricCard
                        description="Database, WAL, SHM, and private state-directory modes."
                        icon={ShieldCheck}
                        title="Storage permissions"
                        value={storage.permissions.secure ? "Secure" : "Review"}
                    />
                </div>
                <ConnectionPolicy overview={overview} />
                <SqliteStorageDetails sqlite={overview.sqlite} />
                <SqliteLifecycleBoundaries lifecycle={overview.sqlite.lifecycle} />
            </div>
        </PageState>
    );
}

interface DatabaseSourcePickerProps {
    readonly onSelect: (source: DatabaseRouteSearch["source"]) => void;
    readonly source: DatabaseRouteSearch["source"];
}

function DatabaseSourcePicker({ onSelect, source }: DatabaseSourcePickerProps) {
    return (
        <fieldset className="border-primary-700 mt-6 grid w-full gap-1 rounded-lg border p-1 sm:inline-grid sm:w-auto sm:grid-cols-2">
            <legend className="sr-only">Database source</legend>
            <Button
                aria-pressed={source === "sqlite"}
                className="justify-center"
                onClick={() => onSelect("sqlite")}
                variant={source === "sqlite" ? "primary" : "ghost"}
            >
                Dashboard SQLite
            </Button>
            <Button
                aria-pressed={source === "postgresql"}
                className="justify-center"
                onClick={() => onSelect("postgresql")}
                variant={source === "postgresql" ? "primary" : "ghost"}
            >
                PostgreSQL &amp; PgBouncer
            </Button>
        </fieldset>
    );
}

type DatabaseRouteContentProps = DatabaseSourcePickerProps;

/** @returns Read-only database observations for the selected reviewed source. */
export function DatabaseRouteContent({ onSelect, source }: DatabaseRouteContentProps) {
    const client = useDashboardTrpcClient();
    const queryClient = useQueryClient();
    const query = useQuery(databaseOverviewQueryOptions(client));
    const refresh = () =>
        void queryClient.invalidateQueries({ queryKey: databaseOverviewQueryKey });
    const complete = query.data !== undefined;

    return (
        <div>
            <PageHeader
                actions={
                    <Button
                        busy={query.isFetching}
                        busyLabel="Refreshing database…"
                        onClick={refresh}
                        variant="secondary"
                    >
                        <Icon icon={RefreshCw} size="sm" tone="inherit" />
                        Retry
                    </Button>
                }
                description="Inspect bounded, read-only SQLite and PostgreSQL/PgBouncer diagnostics without connection identities, SQL text, or credentials."
                eyebrow="Data"
                title="Database"
            />
            <DatabaseSourcePicker onSelect={onSelect} source={source} />
            <div className="mt-8">
                {query.isPending && !complete ? (
                    <PageState
                        label="Loading database overview…"
                        size="lg"
                        status="loading"
                    />
                ) : null}
                {!query.isPending && query.error !== null && !complete ? (
                    <PageState
                        message={dashboardBrowserFailureMessage(query.error)}
                        onRetry={refresh}
                        retryBusy={query.isFetching}
                        status="error"
                        title="Database overview unavailable"
                    />
                ) : null}
                {complete ? (
                    <div className="space-y-4">
                        {query.error === null ? null : (
                            <Alert
                                focusOnError={false}
                                message="The latest refresh failed. Showing retained database data."
                                variant="info"
                            />
                        )}
                        {source === "sqlite" ? (
                            <DatabaseOverviewContent
                                browserCacheRetained={query.error !== null}
                                overview={query.data}
                            />
                        ) : (
                            <PostgresqlDatabaseOverview
                                browserCacheRetained={query.error !== null}
                                observation={query.data.postgresql}
                            />
                        )}
                        <Text size="sm" tone="muted">
                            Checked{" "}
                            <ObservationTime timestampMs={query.data.checkedAtMs} />
                        </Text>
                    </div>
                ) : null}
            </div>
        </div>
    );
}

/** @returns URL-owned source selection and read-only database observations. */
export function DatabaseRoute() {
    const navigate = useNavigate({ from: "/database" });
    const search = normalizeDatabaseSearch(useSearch({ from: "/database" }) as unknown);
    return (
        <DatabaseRouteContent
            onSelect={(source) => void navigate({ search: { source } })}
            source={search.source}
        />
    );
}
