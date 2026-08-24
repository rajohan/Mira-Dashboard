import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ArchiveRestore, Cable, Database, HardDrive, ScrollText } from "lucide-react";
import type { ReactNode } from "react";

import type { DatabaseOverview } from "../../contracts/database.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { jobRunStateBadgeVariant, jobRunStateLabel } from "../jobs/jobRunPresentation.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { formatByteCount, formatPercent } from "../lib/formatMeasurements.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { MetricCard } from "../ui/MetricCard.tsx";
import { PageState } from "../ui/PageState.tsx";
import { Tabs } from "../ui/Tabs.tsx";
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
            <div className="flex items-center gap-2">
                <Icon icon={Cable} tone="accent" />
                <Heading id="database-policy-heading" level={2} size="section">
                    Connection policy
                </Heading>
            </div>
            <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                {rows.map(([label, value]) => (
                    <div
                        className="border-primary-700 bg-primary-900/40 rounded-lg border p-3"
                        key={label}
                    >
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
        badgeLabel = "Retained";
        badgeVariant = "warning";
    }
    return (
        <div className="border-primary-700 bg-primary-900/40 rounded-lg border p-3">
            <Text size="sm" tone="muted">
                {label}
            </Text>
            <div className="mt-1 flex flex-wrap items-center gap-2">
                <Badge variant={badgeVariant}>{badgeLabel}</Badge>
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
                <div className="flex items-center gap-2">
                    <Icon icon={HardDrive} tone="accent" />
                    <Heading id="sqlite-storage-heading" level={2} size="section">
                        SQLite storage
                    </Heading>
                </div>
                <Badge variant={permissions.secure ? "success" : "warning"}>
                    {permissions.secure ? "Permissions secure" : "Permission review"}
                </Badge>
            </div>
            <Text className="mt-1" tone="muted">
                Fixed-file sizes, reusable pages, and modes without host paths.
            </Text>
            <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                {rows.map(([label, value]) => (
                    <div
                        className="border-primary-700 bg-primary-900/40 rounded-lg border p-3"
                        key={label}
                    >
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
            latestRun === undefined ? (
                "No run recorded"
            ) : (
                <span
                    className="flex flex-wrap items-center gap-2"
                    key="latest-maintenance"
                >
                    <Badge
                        className="capitalize"
                        variant={jobRunStateBadgeVariant(latestRun.state)}
                    >
                        {jobRunStateLabel(latestRun.state)}
                    </Badge>
                    {latestRunAtMs === undefined ? null : (
                        <ObservationTime timestampMs={latestRunAtMs} />
                    )}
                </span>
            ),
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
            <div className="flex items-center gap-2">
                <Icon icon={ArchiveRestore} tone="accent" />
                <Heading id="sqlite-lifecycle-heading" level={2} size="section">
                    Backup, restore &amp; maintenance
                </Heading>
            </div>
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
                    <div
                        className="border-primary-700 bg-primary-900/40 rounded-lg border p-3"
                        key={label}
                    >
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
                "The latest verified SQLite maintenance backup is older than the 48-hour policy."
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
    observationConfirmed,
    onRetry,
    overview,
    retryBusy,
}: {
    readonly observationConfirmed: boolean;
    readonly onRetry: () => void;
    readonly overview: DatabaseOverview;
    readonly retryBusy: boolean;
}) {
    if (overview.sqlite.state === "unavailable") {
        if (!observationConfirmed) {
            return (
                <PageState
                    label="Revalidating SQLite diagnostics…"
                    size="lg"
                    status="loading"
                />
            );
        }
        return (
            <PageState
                message="No previously verified SQLite observation is available. Retry after the Dashboard database is ready."
                onRetry={onRetry}
                retryBusy={retryBusy}
                status="error"
                title="SQLite diagnostics unavailable"
            />
        );
    }
    const { migrations } = overview.sqlite;
    const { storage } = overview.sqlite;
    const retained = observationConfirmed && overview.sqlite.state === "last-known-good";
    const lifecycleAlerts = sqliteLifecycleAttention(
        overview.sqlite.lifecycle,
        overview.sqlite.observedAtMs
    );
    return (
        <PageState status="ready">
            <section
                aria-labelledby="sqlite-database-details-heading"
                className="space-y-6"
            >
                <Heading
                    className="sr-only"
                    id="sqlite-database-details-heading"
                    level={2}
                >
                    SQLite database details
                </Heading>
                {retained ? (
                    <Alert
                        focusOnError={false}
                        message="The latest SQLite diagnostics check failed. Showing the most recent verified observation."
                        variant="warning"
                    />
                ) : null}
                {storage.requiresVacuumReview ? (
                    <Alert
                        focusOnError={false}
                        message={`SQLite has ${formatByteCount(storage.freeBytes)} (${formatPercent(storage.freePercent)}) reusable pages. Review a planned VACUUM to compact the database file and return that space to the host.`}
                        variant="warning"
                    />
                ) : null}
                {storage.permissions.secure ? null : (
                    <Alert
                        focusOnError={false}
                        message="SQLite database, WAL, shared-memory, or state-directory permissions are outside the private storage policy. Review ownership and file modes."
                        variant="warning"
                    />
                )}
                {lifecycleAlerts.map((message) => (
                    <Alert
                        focusOnError={false}
                        key={message}
                        message={message}
                        variant="warning"
                    />
                ))}
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
                </div>
                <ConnectionPolicy overview={overview} />
                <SqliteStorageDetails sqlite={overview.sqlite} />
                <SqliteLifecycleBoundaries lifecycle={overview.sqlite.lifecycle} />
            </section>
        </PageState>
    );
}

interface DatabaseSourcePickerProps {
    readonly children: ReactNode;
    readonly onSelect: (source: DatabaseRouteSearch["source"]) => void;
    readonly source: DatabaseRouteSearch["source"];
}

function DatabaseSourcePicker({ children, onSelect, source }: DatabaseSourcePickerProps) {
    return (
        <Tabs
            ariaLabel="Database source"
            onChange={onSelect}
            tabs={[
                {
                    label: "Dashboard SQLite",
                    panel: source === "sqlite" ? children : null,
                    value: "sqlite",
                },
                {
                    label: "PostgreSQL & PgBouncer",
                    panel: source === "postgresql" ? children : null,
                    value: "postgresql",
                },
            ]}
            value={source}
        />
    );
}

type DatabaseRouteContentProps = Omit<DatabaseSourcePickerProps, "children">;

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
            <Heading className="sr-only" level={1}>
                Database
            </Heading>
            <DatabaseSourcePicker onSelect={onSelect} source={source}>
                <div>
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
                                    action={
                                        <Button
                                            busy={query.isFetching}
                                            onClick={refresh}
                                            size="sm"
                                            variant="secondary"
                                        >
                                            Try again
                                        </Button>
                                    }
                                    focusOnError={false}
                                    message="The latest refresh failed. Showing retained database data."
                                    variant="warning"
                                />
                            )}
                            {source === "sqlite" ? (
                                <DatabaseOverviewContent
                                    observationConfirmed={query.isFetchedAfterMount}
                                    onRetry={refresh}
                                    overview={query.data}
                                    retryBusy={query.isFetching}
                                />
                            ) : (
                                <PostgresqlDatabaseOverview
                                    observation={query.data.postgresql}
                                    observationConfirmed={query.isFetchedAfterMount}
                                    onRetry={refresh}
                                    retryBusy={query.isFetching}
                                />
                            )}
                        </div>
                    ) : null}
                </div>
            </DatabaseSourcePicker>
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
