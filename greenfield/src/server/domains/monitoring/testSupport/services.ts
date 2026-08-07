import { Effect } from "effect";

import { MonitoringCatalogService } from "../catalogService.ts";
import { MonitoringService } from "../service.ts";

function unexpectedMonitoringServiceCall(): Effect.Effect<never> {
    return Effect.die(new Error("Test monitoring service received an unexpected call"));
}

/**
 * Creates an inert catalog service for tests whose subject does not include monitoring.
 * @param overrides Exact catalog methods exercised by the current test.
 * @returns Complete fail-closed monitoring catalog test double.
 */
export function createTestMonitoringCatalogService(
    overrides: Partial<MonitoringCatalogService["Service"]> = {}
): MonitoringCatalogService["Service"] {
    return MonitoringCatalogService.of({
        clearReadNotifications: unexpectedMonitoringServiceCall,
        deleteNotification: unexpectedMonitoringServiceCall,
        deleteReport: unexpectedMonitoringServiceCall,
        getIncident: unexpectedMonitoringServiceCall,
        getReport: unexpectedMonitoringServiceCall,
        listIncidents: unexpectedMonitoringServiceCall,
        listNotifications: unexpectedMonitoringServiceCall,
        listReports: unexpectedMonitoringServiceCall,
        markAllNotificationsRead: unexpectedMonitoringServiceCall,
        markNotificationRead: unexpectedMonitoringServiceCall,
        upsertNotification: unexpectedMonitoringServiceCall,
        upsertReport: unexpectedMonitoringServiceCall,
        ...overrides,
    });
}

/**
 * Creates an inert ingestion service for tests whose subject does not include monitoring.
 * @param overrides Exact ingestion methods exercised by the current test.
 * @returns Complete fail-closed monitoring ingestion test double.
 */
export function createTestMonitoringService(
    overrides: Partial<MonitoringService["Service"]> = {}
): MonitoringService["Service"] {
    return MonitoringService.of({
        submitCompleteSnapshot: unexpectedMonitoringServiceCall,
        ...overrides,
    });
}
