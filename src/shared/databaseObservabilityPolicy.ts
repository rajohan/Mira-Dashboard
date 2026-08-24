/** Maximum live PostgreSQL database inventory admitted by one bounded observation. */
export const databaseObservabilityDatabaseMaximum = 64;

/** Topology-independent PostgreSQL/PgBouncer backend ceiling for discovered pools. */
export const databaseObservabilityObserverConnectionLimit =
    databaseObservabilityDatabaseMaximum;

/** One retained backend is sufficient for each sequential observer database pool. */
export const databaseObservabilityObserverPoolSize = 1;

/** The observer never receives PgBouncer reserve-pool capacity. */
export const databaseObservabilityObserverReservePoolSize = 0;

/** At most the active collector and one closing/retrying client may authenticate. */
export const databaseObservabilityObserverClientConnectionLimit = 2;

/** Exact login used by worker-owned database-observability connections. */
export const databaseObservabilityObserverRole = "mira_dashboard_observer" as const;

/** NOLOGIN owner for the two optional count-only observability views. */
export const databaseObservabilityViewOwnerRole =
    "mira_dashboard_observability_owner" as const;

/** Isolated NOLOGIN owner for the exact sanitized statistics capabilities. */
export const databaseObservabilityCapabilityOwnerRole =
    "mira_dashboard_observability_capability_owner" as const;

/** Dedicated schema containing only the fixed sanitized statistics functions. */
export const databaseObservabilityCapabilitySchema =
    "mira_dashboard_observability_capabilities" as const;

/** Sole named application exception: optional reviewed count-only torrent views. */
export const databaseObservabilityTorrentCountDatabases = Object.freeze([
    "bitmagnet",
    "comet",
] as const);

export type DatabaseObservabilityTorrentCountDatabase =
    (typeof databaseObservabilityTorrentCountDatabases)[number];

/** PgBouncer protocol virtual database admitted only for SHOW POOLS/STATS reads. */
export const databaseObservabilityPgBouncerVirtualDatabase = "pgbouncer" as const;

/** Capability-owned alias and same-named physical control database routed by PgBouncer. */
export const databaseObservabilityPgBouncerControlAlias =
    "mira_dashboard_observability" as const;

/**
 * @param hostname Docker-observed published-binding hostname to classify.
 * @returns Whether a canonical URL hostname stays on the local host boundary.
 */
export function databaseObservabilityHostnameIsLoopback(hostname: string): boolean {
    if (hostname === "localhost" || hostname === "::1") {
        return true;
    }
    const octets = hostname.split(".");
    return (
        octets.length === 4 &&
        octets[0] === "127" &&
        octets.every(
            (octet) =>
                /^\d{1,3}$/u.test(octet) &&
                String(Number(octet)) === octet &&
                Number(octet) <= 255
        )
    );
}
