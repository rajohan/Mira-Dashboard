import type { RequestAuthentication } from "../../../contracts/security.ts";
import type {
    ApplicationRuntime,
    RealtimeEventRuntimeService,
} from "../../platform/runtime/applicationRuntime.ts";
import { createRequestContext, type RequestContext } from "../../trpc/context.ts";

const anonymousAuthentication: RequestAuthentication = { kind: "anonymous" };

interface TestApplicationRuntimeOverrides {
    readonly dispose?: ApplicationRuntime["dispose"];
    readonly initialize?: ApplicationRuntime["initialize"];
    readonly stream?: RealtimeEventRuntimeService["stream"];
}

/**
 * Creates a lifecycle-safe runtime stub for transport and composition tests.
 * @param overrides Runtime methods exercised by the current test.
 * @returns A complete inert runtime with the requested overrides.
 */
export function createTestApplicationRuntime(
    overrides: TestApplicationRuntimeOverrides = {}
): ApplicationRuntime {
    return Object.freeze({
        dispose: overrides.dispose ?? (() => Promise.resolve()),
        initialize: overrides.initialize ?? (() => Promise.resolve()),
        services: Object.freeze({
            realtimeEvents: Object.freeze({
                stream:
                    overrides.stream ??
                    (() =>
                        Promise.reject(
                            new Error("Test application runtime has no realtime stream")
                        )),
            }),
        }),
    });
}

/**
 * Creates an explicitly authenticated or anonymous request context for tests.
 * @param authentication Validated identity state supplied to request context creation.
 * @param applicationRuntime Process runtime exposed through the context.
 * @returns A validated test request context.
 */
export function createTestRequestContext(
    authentication: RequestAuthentication = anonymousAuthentication,
    applicationRuntime = createTestApplicationRuntime()
): Promise<RequestContext> {
    return createRequestContext({
        applicationRuntime,
        authenticateRequest: () => authentication,
        request: new Request("http://localhost/trpc/test"),
    });
}
