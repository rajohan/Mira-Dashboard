import {
    getIncidentInputSchema,
    listIncidentsInputSchema,
    listIncidentsResultSchema,
} from "../../../contracts/incidents.ts";
import {
    incidentRecordSchema,
    notificationRecordSchema,
    reportDetailSchema,
} from "../../../contracts/monitoring.ts";
import {
    bulkNotificationInputSchema,
    bulkNotificationResultSchema,
    deleteNotificationResultSchema,
    listNotificationsInputSchema,
    listNotificationsResultSchema,
    notificationIdentityInputSchema,
    upsertNotificationInputSchema,
} from "../../../contracts/notifications.ts";
import {
    deleteReportInputSchema,
    deleteReportResultSchema,
    getReportInputSchema,
    listReportsInputSchema,
    listReportsResultSchema,
    upsertReportInputSchema,
} from "../../../contracts/reports.ts";
import { capabilityProcedure, principalKindProcedure } from "../../trpc/trpc.ts";
import { runMonitoringEffect } from "./routeEffects.ts";

const incidentReadProcedure = capabilityProcedure("reports:read");
const notificationReadProcedure = capabilityProcedure("notifications:read");
const reportReadProcedure = capabilityProcedure("reports:read");
const reportWriteProcedure = capabilityProcedure("reports:write");
const notificationProducerProcedure = principalKindProcedure(
    "notifications:write",
    "automation",
    "An automation principal is required"
);
const notificationSessionWriteProcedure = principalKindProcedure(
    "notifications:write",
    "session",
    "A browser session is required"
);

/** Capability-scoped incident lifecycle read routes. */
export const incidentRoutes = {
    get: incidentReadProcedure
        .input(getIncidentInputSchema)
        .output(incidentRecordSchema)
        .query(({ ctx, input }) =>
            runMonitoringEffect(ctx.monitoringCatalogService.getIncident(input))
        ),
    list: incidentReadProcedure
        .input(listIncidentsInputSchema)
        .output(listIncidentsResultSchema)
        .query(({ ctx, input }) =>
            runMonitoringEffect(ctx.monitoringCatalogService.listIncidents(input))
        ),
};

/** Capability- and principal-kind-scoped Dashboard notification routes. */
export const notificationRoutes = {
    clearRead: notificationSessionWriteProcedure
        .input(bulkNotificationInputSchema)
        .output(bulkNotificationResultSchema)
        .mutation(({ ctx, input }) =>
            runMonitoringEffect(
                ctx.monitoringCatalogService.clearReadNotifications(input)
            )
        ),
    delete: notificationSessionWriteProcedure
        .input(notificationIdentityInputSchema)
        .output(deleteNotificationResultSchema)
        .mutation(({ ctx, input }) =>
            runMonitoringEffect(ctx.monitoringCatalogService.deleteNotification(input))
        ),
    list: notificationReadProcedure
        .input(listNotificationsInputSchema)
        .output(listNotificationsResultSchema)
        .query(({ ctx, input }) =>
            runMonitoringEffect(ctx.monitoringCatalogService.listNotifications(input))
        ),
    markAllRead: notificationSessionWriteProcedure
        .input(bulkNotificationInputSchema)
        .output(bulkNotificationResultSchema)
        .mutation(({ ctx, input }) =>
            runMonitoringEffect(
                ctx.monitoringCatalogService.markAllNotificationsRead(input)
            )
        ),
    markRead: notificationSessionWriteProcedure
        .input(notificationIdentityInputSchema)
        .output(notificationRecordSchema)
        .mutation(({ ctx, input }) =>
            runMonitoringEffect(ctx.monitoringCatalogService.markNotificationRead(input))
        ),
    upsert: notificationProducerProcedure
        .input(upsertNotificationInputSchema)
        .output(notificationRecordSchema)
        .mutation(({ ctx, input }) =>
            runMonitoringEffect(ctx.monitoringCatalogService.upsertNotification(input))
        ),
};

/** Capability-scoped immutable report catalog routes. */
export const reportRoutes = {
    delete: reportWriteProcedure
        .input(deleteReportInputSchema)
        .output(deleteReportResultSchema)
        .mutation(({ ctx, input }) =>
            runMonitoringEffect(ctx.monitoringCatalogService.deleteReport(input))
        ),
    get: reportReadProcedure
        .input(getReportInputSchema)
        .output(reportDetailSchema)
        .query(({ ctx, input }) =>
            runMonitoringEffect(ctx.monitoringCatalogService.getReport(input))
        ),
    list: reportReadProcedure
        .input(listReportsInputSchema)
        .output(listReportsResultSchema)
        .query(({ ctx, input }) =>
            runMonitoringEffect(ctx.monitoringCatalogService.listReports(input))
        ),
    upsert: reportWriteProcedure
        .input(upsertReportInputSchema)
        .output(reportDetailSchema)
        .mutation(({ ctx, input }) =>
            runMonitoringEffect(ctx.monitoringCatalogService.upsertReport(input))
        ),
};
