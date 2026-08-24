import { describe, expect, test } from "bun:test";

import { captureFailure } from "../../test/support/promise.ts";
import {
    bootstrapAuthenticationLifecycle,
    createAuthenticationLifecycleHarness,
} from "./testSupport/authenticationLifecycle.ts";

describe("authentication lifecycle login", () => {
    test("does not commit login after password verification is aborted", async () => {
        const verificationStarted = Promise.withResolvers<void>();
        const verificationResult = Promise.withResolvers<boolean>();
        const harness = await createAuthenticationLifecycleHarness({
            verifyPassword: () => {
                verificationStarted.resolve();
                return verificationResult.promise;
            },
        });
        const controller = new AbortController();

        try {
            await bootstrapAuthenticationLifecycle(harness);
            const pending = harness.service.login(
                { password: "current-password-1", username: "operator" },
                {
                    clientSourceId: "client-source-1",
                    requestId: "request-aborted-login",
                    signal: controller.signal,
                }
            );
            await verificationStarted.promise;
            controller.abort(new Error("request cancelled"));
            verificationResult.resolve(true);

            expect(await captureFailure(() => pending)).toBe(controller.signal.reason);
            expect(
                harness.database.sqlite
                    .query<{ count: number }, []>(
                        "SELECT count(*) AS count FROM auth_sessions"
                    )
                    .get()
            ).toEqual({ count: 1 });
            expect(
                harness.database.sqlite
                    .query<{ count: number }, []>(
                        "SELECT count(*) AS count FROM audit_events"
                    )
                    .get()
            ).toEqual({ count: 1 });
            expect(
                harness.database.sqlite
                    .query<{ count: number }, []>(
                        "SELECT count(*) AS count FROM auth_rate_limit_buckets"
                    )
                    .get()
            ).toEqual({ count: 0 });
        } finally {
            harness.database.sqlite.close(true);
        }
    });
});
