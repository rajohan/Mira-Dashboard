import { FileText, RotateCw, Trash2 } from "lucide-react";

import type {
    DockerContainer,
    DockerGetContainerLogsResult,
    DockerPreparePruneResult,
} from "../../contracts/docker.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { formatByteCount, formatPercent } from "../lib/formatMeasurements.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Modal } from "../ui/Modal.tsx";
import { Select } from "../ui/Select.tsx";
import { Text } from "../ui/Text.tsx";
import {
    dockerContainerHealthVariant,
    dockerContainerStateVariant,
    formatDockerMemory,
} from "./dockerPresentation.ts";

interface DockerContainerDetailsDialogProps {
    readonly container?: DockerContainer;
    readonly onClose: () => void;
}

function optionalDockerTimestamp(value: number | undefined, empty: string): string {
    return value === undefined ? empty : formatDashboardDateTime(value);
}

/** @returns Bounded lifecycle, resource, network, and container-local mount details. */
export function DockerContainerDetailsDialog({
    container,
    onClose,
}: DockerContainerDetailsDialogProps) {
    const stats = container?.stats;
    return (
        <Modal
            description="Bounded Engine details without commands, environment, raw labels, or host mount sources."
            onClose={onClose}
            open={container !== undefined}
            size="lg"
            title={
                container === undefined
                    ? "Container details"
                    : container.name + " details"
            }
        >
            {container !== undefined && (
                <div className="space-y-6">
                    <section aria-label="Container identity">
                        <Heading level={3} size="subsection">
                            Identity
                        </Heading>
                        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                            <div>
                                <dt className="text-primary-400">Image</dt>
                                <dd className="text-primary-100 mt-1 font-mono wrap-anywhere">
                                    {container.image}
                                </dd>
                            </div>
                            <div>
                                <dt className="text-primary-400">Compose identity</dt>
                                <dd className="text-primary-100 mt-1 wrap-anywhere">
                                    {container.project === undefined
                                        ? "Not Compose managed"
                                        : container.project + " / " + container.service}
                                </dd>
                            </div>
                        </dl>
                        <code className="text-primary-400 mt-3 block text-xs wrap-anywhere">
                            {container.id}
                        </code>
                    </section>

                    <section aria-label="Container lifecycle">
                        <Heading level={3} size="subsection">
                            Lifecycle and status
                        </Heading>
                        <div className="mt-3 flex flex-wrap gap-2">
                            <Badge variant={dockerContainerStateVariant(container.state)}>
                                {container.state}
                            </Badge>
                            <Badge
                                variant={dockerContainerHealthVariant(container.health)}
                            >
                                {container.health === "none"
                                    ? "No health check"
                                    : container.health}
                            </Badge>
                        </div>
                        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                            <div>
                                <dt className="text-primary-400">Created</dt>
                                <dd className="text-primary-100 mt-1">
                                    {formatDashboardDateTime(container.createdAtMs)}
                                </dd>
                            </div>
                            <div>
                                <dt className="text-primary-400">Started</dt>
                                <dd className="text-primary-100 mt-1">
                                    {optionalDockerTimestamp(
                                        container.startedAtMs,
                                        "Not started"
                                    )}
                                </dd>
                            </div>
                            <div>
                                <dt className="text-primary-400">Finished</dt>
                                <dd className="text-primary-100 mt-1">
                                    {optionalDockerTimestamp(
                                        container.finishedAtMs,
                                        "Not finished"
                                    )}
                                </dd>
                            </div>
                            <div>
                                <dt className="text-primary-400">Restarts</dt>
                                <dd className="text-primary-100 mt-1 tabular-nums">
                                    {container.restartCount}
                                </dd>
                            </div>
                        </dl>
                    </section>

                    <section aria-label="Container resources">
                        <Heading level={3} size="subsection">
                            Resources
                        </Heading>
                        {stats === undefined ? (
                            <Text className="mt-3" tone="muted">
                                Live resource statistics are unavailable.
                            </Text>
                        ) : (
                            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                                <div>
                                    <dt className="text-primary-400">CPU</dt>
                                    <dd className="text-primary-100 mt-1 tabular-nums">
                                        {formatPercent(stats.cpuPercent)}
                                    </dd>
                                </div>
                                <div>
                                    <dt className="text-primary-400">Memory</dt>
                                    <dd className="text-primary-100 mt-1 tabular-nums">
                                        {formatDockerMemory(container)}
                                    </dd>
                                </div>
                                <div>
                                    <dt className="text-primary-400">Network I/O</dt>
                                    <dd className="text-primary-100 mt-1 tabular-nums">
                                        ↓ {formatByteCount(stats.networkReceivedBytes)} ·
                                        ↑ {formatByteCount(stats.networkSentBytes)}
                                    </dd>
                                </div>
                                <div>
                                    <dt className="text-primary-400">Block I/O</dt>
                                    <dd className="text-primary-100 mt-1 tabular-nums">
                                        ↓ {formatByteCount(stats.blockReadBytes)} · ↑{" "}
                                        {formatByteCount(stats.blockWrittenBytes)}
                                    </dd>
                                </div>
                                <div>
                                    <dt className="text-primary-400">Processes</dt>
                                    <dd className="text-primary-100 mt-1 tabular-nums">
                                        {stats.pids}
                                    </dd>
                                </div>
                            </dl>
                        )}
                    </section>

                    <section aria-label="Container networks">
                        <Heading level={3} size="subsection">
                            Networks
                        </Heading>
                        {container.networks.length === 0 ? (
                            <Text className="mt-3" tone="muted">
                                No attached networks were projected.
                            </Text>
                        ) : (
                            <ul className="mt-3 space-y-3">
                                {container.networks.map((network) => (
                                    <li
                                        className="border-primary-700 bg-primary-900/35 rounded-lg border p-3"
                                        key={network.name}
                                    >
                                        <div className="text-primary-100 font-medium wrap-anywhere">
                                            {network.name}
                                        </div>
                                        <code className="text-primary-400 mt-1 block text-xs wrap-anywhere">
                                            {network.addresses.length === 0
                                                ? "No assigned addresses"
                                                : network.addresses.join(", ")}
                                        </code>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>

                    <section aria-label="Container mounts">
                        <Heading level={3} size="subsection">
                            Mounts
                        </Heading>
                        {container.mounts.length === 0 ? (
                            <Text className="mt-3" tone="muted">
                                No container mounts were projected.
                            </Text>
                        ) : (
                            <ul className="mt-3 space-y-3">
                                {container.mounts.map((mount) => (
                                    <li
                                        className="border-primary-700 bg-primary-900/35 rounded-lg border p-3"
                                        key={`${mount.destination}\0${mount.name ?? ""}\0${mount.type}`}
                                    >
                                        <div className="flex flex-wrap items-center gap-2">
                                            <Badge variant="default">{mount.type}</Badge>
                                            <Badge
                                                variant={
                                                    mount.readOnly ? "warning" : "info"
                                                }
                                            >
                                                {mount.readOnly
                                                    ? "Read-only"
                                                    : "Read/write"}
                                            </Badge>
                                        </div>
                                        {mount.name !== undefined && (
                                            <div className="text-primary-200 mt-2 text-sm wrap-anywhere">
                                                {mount.name}
                                            </div>
                                        )}
                                        <code className="text-primary-400 mt-1 block text-xs wrap-anywhere">
                                            Destination {mount.destination}
                                        </code>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>
                </div>
            )}
        </Modal>
    );
}

export interface DockerLogsSelection {
    readonly containerId: string;
    readonly containerName: string;
    readonly sourceRevision: string;
}

interface DockerLogsDialogProps {
    readonly error?: string;
    readonly loading: boolean;
    readonly logs?: DockerGetContainerLogsResult;
    readonly onClose: () => void;
    readonly onRefresh: () => void;
    readonly onTailChange: (tail: 100 | 200 | 500) => void;
    readonly refreshing: boolean;
    readonly selection?: DockerLogsSelection;
    readonly tail: 100 | 200 | 500;
}

/** @returns Bounded, redacted exact-container log tail. */
export function DockerLogsDialog({
    error,
    loading,
    logs,
    onClose,
    onRefresh,
    onTailChange,
    refreshing,
    selection,
    tail,
}: DockerLogsDialogProps) {
    return (
        <Modal
            description="A bounded server-redacted tail from this exact container."
            onClose={onClose}
            open={selection !== undefined}
            size="lg"
            title={
                selection === undefined
                    ? "Container logs"
                    : selection.containerName + " logs"
            }
        >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <Select
                    ariaLabel="Docker log line count"
                    className="sm:w-40"
                    onChange={(value) => onTailChange(Number(value) as 100 | 200 | 500)}
                    options={[
                        { label: "100 lines", value: "100" },
                        { label: "200 lines", value: "200" },
                        { label: "500 lines", value: "500" },
                    ]}
                    value={String(tail) as "100" | "200" | "500"}
                />
                <Button
                    busy={refreshing}
                    busyLabel="Refreshing logs…"
                    disabled={loading}
                    onClick={onRefresh}
                    size="sm"
                    variant="secondary"
                >
                    <Icon icon={RotateCw} size="sm" />
                    Refresh
                </Button>
            </div>
            <Alert className="mt-4" message={error} />
            {loading && logs === undefined ? (
                <div className="text-primary-400 mt-5 flex items-center gap-2 text-sm">
                    <Icon icon={FileText} size="sm" /> Loading logs…
                </div>
            ) : (
                <>
                    {logs !== undefined && (
                        <div className="mt-4 flex flex-wrap items-center gap-2">
                            <Badge variant="success">Redacted</Badge>
                            {logs.truncated && <Badge variant="warning">Truncated</Badge>}
                            <Text size="sm" tone="muted">
                                Observed {formatDashboardDateTime(logs.observedAtMs)}
                            </Text>
                        </div>
                    )}
                    <pre
                        aria-label="Docker container log output"
                        className="bg-primary-950 border-primary-700 text-primary-100 mt-4 max-h-[65vh] min-h-52 overflow-auto rounded-lg border p-4 text-xs wrap-anywhere whitespace-pre-wrap"
                    >
                        {logs === undefined || logs.lines.length === 0
                            ? "No log lines returned."
                            : logs.lines.join("\n")}
                    </pre>
                </>
            )}
        </Modal>
    );
}

export interface DockerPrunePreview {
    readonly idempotencyKey: string;
    readonly result: DockerPreparePruneResult;
}

interface DockerPrunePreviewDialogProps {
    readonly busy: boolean;
    readonly error?: string;
    readonly onClose: () => void;
    readonly onConfirm: () => void;
    readonly preview?: DockerPrunePreview;
    readonly sourceCurrent: boolean;
}

/** @returns Exact ticket candidate review before one-time prune admission. */
export function DockerPrunePreviewDialog({
    busy,
    error,
    onClose,
    onConfirm,
    preview,
    sourceCurrent,
}: DockerPrunePreviewDialogProps) {
    const result = preview?.result;
    const empty = result === undefined || result.items.length === 0;
    return (
        <Modal
            description="Only the exact candidates listed below can be queued with this one-time ticket."
            dismissible={!busy}
            onClose={onClose}
            open={preview !== undefined}
            size="lg"
            title={
                result === undefined
                    ? "Prune preview"
                    : "Prune unused Docker " + result.target + "?"
            }
        >
            {result !== undefined && (
                <>
                    <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={empty ? "default" : "warning"}>
                            {result.items.length} exact candidates
                        </Badge>
                        <Badge variant="info">
                            {formatByteCount(result.estimatedReclaimableBytes)} estimated
                        </Badge>
                    </div>
                    <Text className="mt-3" size="sm" tone="muted">
                        Ticket expires {formatDashboardDateTime(result.expiresAtMs)}
                    </Text>
                    <code className="text-primary-400 mt-1 block text-xs wrap-anywhere">
                        {result.ticketId}
                    </code>
                    {empty ? (
                        <Text className="mt-5" tone="muted">
                            Docker found no unused {result.target} to prune.
                        </Text>
                    ) : (
                        <section
                            aria-label={"Exact " + result.target + " prune candidates"}
                            className="border-primary-700 bg-primary-950 mt-5 max-h-80 overflow-auto rounded-lg border p-3"
                        >
                            <ul className="space-y-3">
                                {result.target === "images"
                                    ? result.items.map((item) => (
                                          <li
                                              className="border-primary-700 border-b pb-3 last:border-0 last:pb-0"
                                              key={item.id}
                                          >
                                              <code className="text-primary-100 block text-xs wrap-anywhere">
                                                  {item.id}
                                              </code>
                                              <Text
                                                  as="span"
                                                  className="mt-1 block wrap-anywhere"
                                                  size="sm"
                                                  tone="muted"
                                              >
                                                  {item.references.join(", ") ||
                                                      "Untagged"}{" "}
                                                  · {formatByteCount(item.sizeBytes)}
                                              </Text>
                                          </li>
                                      ))
                                    : result.items.map((item) => (
                                          <li
                                              className="border-primary-700 border-b pb-3 last:border-0 last:pb-0"
                                              key={item.name}
                                          >
                                              <code className="text-primary-100 block text-xs wrap-anywhere">
                                                  {item.name}
                                              </code>
                                              <Text
                                                  as="span"
                                                  className="mt-1 block"
                                                  size="sm"
                                                  tone="muted"
                                              >
                                                  {item.sizeBytes === undefined
                                                      ? "Size unknown"
                                                      : formatByteCount(item.sizeBytes)}
                                              </Text>
                                          </li>
                                      ))}
                            </ul>
                        </section>
                    )}
                    <Alert className="mt-4" message={error} />
                    {!sourceCurrent && (
                        <Alert
                            className="mt-4"
                            focusOnError={false}
                            message="The Docker source changed. Close this preview and prepare a new one."
                            variant="warning"
                        />
                    )}
                    <div className="mt-5 flex flex-wrap justify-end gap-2">
                        <Button disabled={busy} onClick={onClose} variant="secondary">
                            Close
                        </Button>
                        <Button
                            busy={busy}
                            busyLabel="Queueing exact prune…"
                            disabled={empty || !sourceCurrent}
                            onClick={onConfirm}
                            variant="danger"
                        >
                            <Icon icon={Trash2} size="sm" />
                            Queue exact prune
                        </Button>
                    </div>
                </>
            )}
        </Modal>
    );
}
