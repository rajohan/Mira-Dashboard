import { describe, expect, it } from "vitest";

import * as hooks from "./index";

describe("hooks barrel", () => {
    it("re-exports core hook utilities", () => {
        expect(hooks.apiFetch).toBeDefined();
        expect(hooks.useHealth).toBeDefined();
        expect(hooks.useMetrics).toBeDefined();
        expect(hooks.useWeather).toBeDefined();
        expect(hooks.useOpenClawSocket).toBeDefined();
    });

    it("re-exports key factories", () => {
        expect(hooks.cacheKeys.all).toEqual(["cache"]);
        expect(hooks.cronKeys.all).toEqual(["cron"]);
        expect(hooks.fileKeys.all).toEqual(["files"]);
        expect(hooks.logKeys.files()).toEqual(["logs", "files"]);
        expect(hooks.pullRequestKeys.all).toEqual(["pull-requests"]);
        expect(hooks.sessionKeys.all).toEqual(["sessions"]);
        expect(hooks.taskKeys.all).toEqual(["tasks"]);
        expect(hooks.terminalKeys.history).toEqual(["terminal", "history"]);
    });
});
