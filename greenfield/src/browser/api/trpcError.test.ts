import { describe, expect, test } from "bun:test";

import { DashboardProtocolError } from "./trpcClient.ts";
import {
    dashboardUnavailableReadRetryDelay,
    dashboardUnavailableReadRetryMaximum,
    retryDashboardUnavailableRead,
} from "./trpcError.ts";

describe("Dashboard tRPC read retry policy", () => {
    test("retries only bounded transient unavailability", () => {
        const unavailable = { data: { code: "SERVICE_UNAVAILABLE" } };
        expect(retryDashboardUnavailableRead(0, unavailable)).toBeTrue();
        expect(
            retryDashboardUnavailableRead(
                dashboardUnavailableReadRetryMaximum - 1,
                unavailable
            )
        ).toBeTrue();
        expect(
            retryDashboardUnavailableRead(
                dashboardUnavailableReadRetryMaximum,
                unavailable
            )
        ).toBeFalse();
        expect(
            retryDashboardUnavailableRead(0, { data: { code: "UNAUTHORIZED" } })
        ).toBeFalse();
        expect(
            retryDashboardUnavailableRead(0, new DashboardProtocolError())
        ).toBeFalse();
    });

    test("caps reconnect delay without a zero-delay retry storm", () => {
        expect(
            [0, 1, 2, 3, 8].map((attemptIndex) =>
                dashboardUnavailableReadRetryDelay(attemptIndex)
            )
        ).toEqual([1000, 2000, 4000, 5000, 5000]);
    });
});
