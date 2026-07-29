import { describe, expect, it } from "bun:test";

import { resolveDashboardOrigin } from "../../../scripts/miraDashboardApi";

describe("Dashboard automation API wrapper", () => {
    it("derives its loopback origin from the configured Dashboard port", () => {
        expect(resolveDashboardOrigin("")).toBe("http://127.0.0.1:3100");
        expect(resolveDashboardOrigin("4317")).toBe("http://127.0.0.1:4317");
        expect(resolveDashboardOrigin(" 4317 ")).toBe("http://127.0.0.1:4317");
        expect(resolveDashboardOrigin("0")).toBe("http://127.0.0.1:3100");
        expect(resolveDashboardOrigin("65536")).toBe("http://127.0.0.1:3100");
        expect(resolveDashboardOrigin("not-a-port")).toBe("http://127.0.0.1:3100");
    });
});
