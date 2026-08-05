import { maxTime } from "date-fns/constants";

import type {
    ApplicationCapability,
    RequestAuthentication,
} from "../../../contracts/security.ts";
import type { AuthenticationResolution } from "../../domains/security/authenticationResolution.ts";
import type {
    ApplicationRuntime,
    RealtimeEventRuntimeService,
} from "../../platform/runtime/applicationRuntime.ts";
import { createRequestContext, type RequestContext } from "../../trpc/context.ts";

const anonymousAuthentication: RequestAuthentication = { kind: "anonymous" };

export const testSecurityUserId = "019fc968-1a9b-7770-8f1b-d5b863b0e7b4";
export const testSessionSelector = "a".repeat(32);
export const testAutomationCredentialId = "019fc968-1a9b-7771-9f1b-d5b863b0e7b4";

/**
 * Creates one valid session identity with the requested test capabilities.
 * @param capabilities Capabilities granted to the test user.
 * @returns A valid session request identity.
 */
export function createTestSessionAuthentication(
    capabilities: readonly ApplicationCapability[]
): RequestAuthentication {
    return {
        kind: "authenticated",
        principal: {
            authorizationVersion: 1,
            capabilities: [...capabilities],
            authenticatorId: testSessionSelector,
            id: testSecurityUserId,
            kind: "session",
        },
    };
}

/**
 * Creates one valid automation identity with the requested test capabilities.
 * @param capabilities Capabilities granted to the test automation principal.
 * @returns A valid automation request identity.
 */
export function createTestAutomationAuthentication(
    capabilities: readonly ApplicationCapability[]
): RequestAuthentication {
    return {
        kind: "authenticated",
        principal: {
            authorizationVersion: 1,
            capabilities: [...capabilities],
            authenticatorId: testAutomationCredentialId,
            id: "test-automation",
            kind: "automation",
        },
    };
}

/**
 * Builds a stable test resolution whose lease revalidates the same identity.
 * @param authentication Test request identity.
 * @returns Authentication-service output accepted by request-context creation.
 */
export function createTestAuthenticationResolution(
    authentication: RequestAuthentication
): AuthenticationResolution {
    if (authentication.kind !== "authenticated") {
        return Object.freeze({ authentication });
    }
    const resolution: AuthenticationResolution = Object.freeze({
        authentication,
        lease: Object.freeze({
            expiresAtMs: maxTime,
            revalidate: () => Promise.resolve(resolution),
        }),
    });
    return resolution;
}

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
        authenticateRequest: () => createTestAuthenticationResolution(authentication),
        request: new Request("http://localhost/trpc/test"),
    });
}
