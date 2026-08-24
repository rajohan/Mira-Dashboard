/** Complete contract-ordered inventory of reviewed log-maintenance policies. */
export const logMaintenancePolicyIds = Object.freeze([
    "docker-managed",
    "host-alternatives",
    "host-apport",
    "host-dpkg",
    "host-rsyslog",
] as const);

/** Exact durable action identity for worker-owned fixed-policy log maintenance. */
export const logMaintenanceJobActionKey = "maintenance.rotate-logs";

/** Maximum canonical maintenance payload bytes admitted to the status indexes. */
export const logMaintenanceJobPayloadIndexMaximumBytes = 128;

/** Fixed root-owned systemd units that implement reviewed host log maintenance. */
export const fixedSystemLogrotateUnits = Object.freeze({
    "host-alternatives": "mira-dashboard-log-maintenance@host-alternatives.service",
    "host-apport": "mira-dashboard-log-maintenance@host-apport.service",
    "host-dpkg": "mira-dashboard-log-maintenance@host-dpkg.service",
    "host-rsyslog": "mira-dashboard-log-maintenance@host-rsyslog.service",
});
