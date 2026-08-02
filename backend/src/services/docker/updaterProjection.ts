import { database } from "../../database/connection.ts";
import { nullableString, objectFallback } from "../../lib/values.ts";
import { type DockerUpdaterStepResult } from "../dockerUpdater/types.ts";
import { isNonblockingRegistrationFailure } from "../dockerUpdater/updatePolicy.ts";
import { type JobExecutionRecord } from "../jobExecutionQueue/repository.ts";
import { successfulJobExecutionOutput } from "../queuedJobExecution.ts";

interface DockerUpdaterServiceRow {
    app_slug: string;
    compose_image_ref: string;
    current_digest: string;
    current_tag: string;
    enabled: string;
    id: string;
    image_repo: string;
    last_checked_at: string;
    last_status: string;
    last_updated_at: string;
    latest_digest: string;
    latest_tag: string;
    metadata: string;
    pin_mode: string;
    policy: string;
    service_name: string;
}

const dockerUpdaterProjection = `
    CAST(id AS TEXT) AS id,
    app_slug,
    service_name,
    COALESCE(compose_image_ref, '') AS compose_image_ref,
    image_repo,
    COALESCE(current_tag, '') AS current_tag,
    COALESCE(current_digest, '') AS current_digest,
    COALESCE(latest_tag, '') AS latest_tag,
    COALESCE(latest_digest, '') AS latest_digest,
    policy,
    pin_mode,
    CASE WHEN enabled = 1 THEN 'true' ELSE 'false' END AS enabled,
    COALESCE(last_checked_at, '') AS last_checked_at,
    COALESCE(last_updated_at, '') AS last_updated_at,
    COALESCE(last_status, '') AS last_status,
    metadata_json AS metadata
`;

function parseJsonField<T>(value: string | undefined): T | undefined {
    if (!value) return undefined;
    try {
        return JSON.parse(value) as T;
    } catch {
        return undefined;
    }
}

function hasUpdaterCandidate(service: DockerUpdaterServiceRow): boolean {
    const hasDigestDrift = Boolean(
        service.latest_digest &&
        (!service.current_digest || service.current_digest !== service.latest_digest)
    );
    if (service.pin_mode === "digest") return hasDigestDrift;
    return Boolean(
        hasDigestDrift ||
        (service.current_tag &&
            service.latest_tag &&
            service.current_tag !== service.latest_tag)
    );
}

function mapDockerUpdaterRow(row: DockerUpdaterServiceRow) {
    return {
        appSlug: row.app_slug,
        composeImageRef: nullableString(row.compose_image_ref),
        currentDigest: nullableString(row.current_digest),
        currentTag: nullableString(row.current_tag),
        enabled: row.enabled === "true",
        id: Number(row.id),
        imageRepo: row.image_repo,
        lastCheckedAt: nullableString(row.last_checked_at),
        lastStatus: nullableString(row.last_status),
        lastUpdatedAt: nullableString(row.last_updated_at),
        latestDigest: nullableString(row.latest_digest),
        latestTag: nullableString(row.latest_tag),
        metadata: objectFallback(parseJsonField<Record<string, unknown>>(row.metadata)),
        pinMode: row.pin_mode,
        policy: row.policy,
        serviceName: row.service_name,
        updateAvailable: hasUpdaterCandidate(row),
    };
}

export function getDockerUpdaterServices() {
    const rows = database
        .prepare(
            `SELECT ${dockerUpdaterProjection}
             FROM docker_managed_services
             ORDER BY app_slug, service_name`
        )
        .all() as unknown as DockerUpdaterServiceRow[];
    return rows.map((row) => mapDockerUpdaterRow(row));
}

export function getDockerUpdaterServiceById(serviceId: number) {
    const rows = database
        .prepare(
            `SELECT ${dockerUpdaterProjection}
             FROM docker_managed_services
             WHERE id = ?
             LIMIT 1`
        )
        .all(Math.floor(serviceId)) as unknown as DockerUpdaterServiceRow[];
    return rows[0] ? mapDockerUpdaterRow(rows[0]) : undefined;
}

export function blockingDockerUpdaterFailures(steps: DockerUpdaterStepResult[]) {
    return steps.filter(
        (step) =>
            !step.isOk &&
            !isNonblockingRegistrationFailure(step) &&
            step.step !== "git-sync:docker"
    );
}

export function dockerUpdaterSteps(
    execution: JobExecutionRecord
): DockerUpdaterStepResult[] {
    const steps = execution.output.steps;
    if (!Array.isArray(steps)) {
        successfulJobExecutionOutput(execution);
        throw new Error("Docker updater result was missing");
    }
    return steps as DockerUpdaterStepResult[];
}

export function getDockerUpdaterEvents(limit: number) {
    const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const rows = database
        .prepare(
            `SELECT
                CAST(e.id AS TEXT) AS id,
                CAST(e.managed_service_id AS TEXT) AS managed_service_id,
                COALESCE(NULLIF(e.app_slug, ''), s.app_slug, '') AS app_slug,
                COALESCE(NULLIF(e.service_name, ''), s.service_name, '') AS service_name,
                e.event_type,
                COALESCE(e.from_tag, '') AS from_tag,
                COALESCE(e.to_tag, '') AS to_tag,
                COALESCE(e.from_digest, '') AS from_digest,
                COALESCE(e.to_digest, '') AS to_digest,
                e.created_at
             FROM docker_update_events e
             LEFT JOIN docker_managed_services s ON s.id = e.managed_service_id
             ORDER BY e.created_at DESC
             LIMIT ?`
        )
        .all(boundedLimit) as Array<
        Record<string, string | null | undefined> & { managed_service_id: string | null }
    >;

    return rows.map((row) => ({
        appSlug: row.app_slug,
        createdAt: row.created_at,
        eventType: row.event_type,
        fromDigest: nullableString(row.from_digest),
        fromTag: nullableString(row.from_tag),
        id: Number(row.id),
        managedServiceId:
            row.managed_service_id === null ? undefined : Number(row.managed_service_id),
        message: undefined,
        serviceName: row.service_name,
        toDigest: nullableString(row.to_digest),
        toTag: nullableString(row.to_tag),
    }));
}

export function getDockerUpdaterSummary(
    services: ReturnType<typeof getDockerUpdaterServices>
) {
    return {
        autoPolicy: services.filter((service) => service.policy === "auto").length,
        enabled: services.filter((service) => service.enabled).length,
        failed: services.filter((service) => service.lastStatus === "auto_update_failed")
            .length,
        notifyPolicy: services.filter((service) => service.policy === "notify").length,
        total: services.length,
        updateAvailable: services.filter((service) => service.updateAvailable).length,
    };
}

export function updaterResultCode(steps: DockerUpdaterStepResult[]): string {
    return steps.find((step) => !step.isOk)?.code ?? "OK";
}
