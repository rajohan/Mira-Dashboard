import { describe, expect, it } from "vitest";

import type { CronJob } from "../hooks";
import {
    formatCronLastStatus,
    formatCronTimestamp,
    getCronJobId,
    getCronJobName,
    getCronStateValue,
    getCronStatusVariant,
    sortCronJobs,
} from "./cronUtils";

describe("cron utils", () => {
    it("derives stable ids and display names", () => {
        expect(getCronJobId({ jobId: "job-1" } as CronJob)).toBe("job-1");
        expect(getCronJobId({ id: "legacy-1" } as CronJob)).toBe("legacy-1");
        expect(getCronJobName({ name: "Nightly" } as CronJob)).toBe("Nightly");
        expect(getCronJobName({ jobId: "job-1" } as CronJob)).toBe("job-1");
        expect(getCronJobName({} as CronJob)).toBe("Unnamed job");
    });

    it("sorts enabled jobs before disabled jobs by name", () => {
        const jobs = [
            { name: "Zoo", enabled: false },
            { name: "Beta", enabled: true },
            { name: "Alpha" },
        ] as CronJob[];

        expect(sortCronJobs(jobs).map(getCronJobName)).toEqual(["Alpha", "Beta", "Zoo"]);
        expect(jobs.map(getCronJobName)).toEqual(["Zoo", "Beta", "Alpha"]);
    });

    it("reads state values safely", () => {
        expect(
            getCronStateValue(
                { state: { lastRunStatus: "ok" } } as CronJob,
                "lastRunStatus"
            )
        ).toBe("ok");
        expect(
            getCronStateValue({ state: null } as unknown as CronJob, "lastRunStatus")
        ).toBeUndefined();
        expect(getCronStateValue({} as CronJob, "lastRunStatus")).toBeUndefined();
    });

    it("formats timestamps and statuses", () => {
        expect(formatCronTimestamp("bad")).toBe("—");
        expect(formatCronTimestamp(new Date(2026, 4, 10, 6, 7).getTime())).toBe(
            "10.05.2026, 06:07"
        );
        const missingStatus: string | undefined = undefined;
        expect(formatCronLastStatus(missingStatus)).toBe("UNKNOWN");
        expect(formatCronLastStatus("")).toBe("UNKNOWN");
        expect(formatCronLastStatus("success")).toBe("SUCCESS");
    });

    it("maps status variants", () => {
        expect(getCronStatusVariant("ok")).toBe("success");
        expect(getCronStatusVariant("success")).toBe("success");
        expect(getCronStatusVariant("running")).toBe("warning");
        expect(getCronStatusVariant("error")).toBe("error");
        expect(getCronStatusVariant("failed")).toBe("error");
        expect(getCronStatusVariant("skipped")).toBe("default");
    });
});
