/** Fixed PostgreSQL database names admitted by the worker observability collector. */
export const databaseObservabilityReviewedPostgreSqlDatabases = Object.freeze([
    "aiomanager",
    "aiometadata",
    "aiostreams",
    "authelia",
    "bitmagnet",
    "comet",
    "crowdsec",
    "metabase",
    "postgres",
    "speedtest_tracker",
] as const);

/** Exact login accepted by the worker database-observability connection URL. */
export const databaseObservabilityObserverRole = "mira_dashboard_observer" as const;

/** NOLOGIN owner for the two count-only observability views. */
export const databaseObservabilityViewOwnerRole =
    "mira_dashboard_observability_owner" as const;

export type DatabaseObservabilityReviewedPostgreSqlDatabase =
    (typeof databaseObservabilityReviewedPostgreSqlDatabases)[number];

/** Exact databases that expose one reviewed count-only torrent view. */
export const databaseObservabilityTorrentCountDatabases = Object.freeze([
    "bitmagnet",
    "comet",
] as const);

/** PostgreSQL bootstrap database used for the fixed cluster-level statistics reads. */
export const databaseObservabilityControlDatabase = "postgres" as const;

/** Exact sorted database set admitted into metric and cached browser projections. */
export const databaseObservabilityMetricDatabases = Object.freeze([
    "aiomanager",
    "aiometadata",
    "aiostreams",
    "authelia",
    "bitmagnet",
    "comet",
    "crowdsec",
    "metabase",
    "speedtest_tracker",
] as const);

/** PgBouncer virtual database admitted only for fixed SHOW POOLS/STATS reads. */
export const databaseObservabilityPgBouncerVirtualDatabase = "pgbouncer" as const;
