import { describe, expect, it } from "vitest";

import type { CronJob } from "../hooks";
import {
    cronExpressionIsValid,
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
        expect(
            sortCronJobs([
                { name: "Enabled", enabled: true },
                { name: "Disabled", enabled: false },
            ] as CronJob[]).map(getCronJobName)
        ).toEqual(["Enabled", "Disabled"]);
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

    it.each(["0 4 * * *", "*/15 1-5 * * 1,2", "5/15 10 * * *", "0 9 1-31 * 0-7"])(
        "accepts supported cron expression %s",
        (expression) => {
            expect(cronExpressionIsValid(expression)).toBe(true);
        }
    );

    it.each([
        "",
        "not cron",
        "60 * * * *",
        "* 24 * * *",
        "* * 0 * *",
        "* * * 13 *",
        "* * * * 8",
        "*/0 * * * *",
        "*/a * * * *",
        "1/0 * * * *",
        "1/2/3 * * * *",
        "5-1 * * * *",
        "1-2-3 * * * *",
        "999999999999999999999 * * * *",
        "-1 * * * *",
        "/5 * * * *",
        "1,,2 * * * *",
        "a * * * *",
    ])("rejects unsupported cron expression %s", (expression) => {
        expect(cronExpressionIsValid(expression)).toBe(false);
    });

    it("formats timestamps and statuses", () => {
        expect(formatCronTimestamp("bad")).toBe("—");
        expect(formatCronTimestamp(Number("NaN"))).toBe("—");
        expect(formatCronTimestamp(Infinity)).toBe("—");
        const date = new Date(Date.UTC(2026, 4, 10, 6, 7));
        expect(formatCronTimestamp(date.getTime())).toBe("10.05.2026, 08:07");
        const missingStatus: string | undefined = undefined;
        expect(formatCronLastStatus(missingStatus)).toBe("UNKNOWN");
        expect(formatCronLastStatus("")).toBe("UNKNOWN");
        expect(formatCronLastStatus("  ok  ")).toBe("OK");
        expect(formatCronLastStatus("success")).toBe("SUCCESS");
    });

    it("maps status variants", () => {
        expect(getCronStatusVariant(" ok ")).toBe("success");
        expect(getCronStatusVariant("success")).toBe("success");
        expect(getCronStatusVariant("succeeded")).toBe("success");
        expect(getCronStatusVariant("completed")).toBe("success");
        expect(getCronStatusVariant("running")).toBe("warning");
        expect(getCronStatusVariant("pending")).toBe("warning");
        expect(getCronStatusVariant("queued")).toBe("warning");
        expect(getCronStatusVariant("in_progress")).toBe("warning");
        expect(getCronStatusVariant("in-progress")).toBe("warning");
        expect(getCronStatusVariant("error")).toBe("error");
        expect(getCronStatusVariant("failed")).toBe("error");
        expect(getCronStatusVariant("failure")).toBe("error");
        expect(getCronStatusVariant("skipped")).toBe("default");
    });
});
