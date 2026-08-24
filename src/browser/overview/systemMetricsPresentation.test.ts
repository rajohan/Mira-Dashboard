import { describe, expect, test } from "bun:test";

import { DashboardProtocolError } from "../api/trpcClient.ts";
import { systemMetricsFailureMessage } from "./systemMetricsPresentation.ts";

describe("system metrics presentation", () => {
    test("maps failures to fixed text without raw transport details", () => {
        const secret = "private /proc failure";
        expect(systemMetricsFailureMessage(new TypeError(secret))).toBe(
            "The system usage request could not be completed. Try again."
        );
        expect(systemMetricsFailureMessage(new DashboardProtocolError())).toBe(
            "The server returned unexpected system data. Reload before retrying."
        );
        expect(
            systemMetricsFailureMessage({ data: { code: "SERVICE_UNAVAILABLE" } })
        ).toBe("System usage is temporarily unavailable. Try again shortly.");
        expect(systemMetricsFailureMessage(new TypeError(secret))).not.toContain(secret);
    });
});
