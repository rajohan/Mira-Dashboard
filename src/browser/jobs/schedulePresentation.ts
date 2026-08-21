import type { ScheduleConfiguration } from "../../contracts/jobModel.ts";

/** @returns A compact operator-facing description of one schedule variant. */
export function scheduleConfigurationLabel(configuration: ScheduleConfiguration): string {
    switch (configuration.kind) {
        case "cron": {
            return `${configuration.expression} · ${configuration.timeZone}`;
        }
        case "daily": {
            return `Daily ${configuration.timeOfDay} · ${configuration.timeZone}`;
        }
        case "interval": {
            return `Every ${configuration.intervalMs / 1000} seconds`;
        }
    }
}
