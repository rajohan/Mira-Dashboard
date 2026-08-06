import { sha256Hex } from "../../shared/crypto.ts";

const safeFailureIdentifierPattern = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;
const knownFailureTags = new Set([
    "ApplicationConfigurationError",
    "ApplicationListenerStopError",
    "ApplicationListenerStopTimeoutError",
    "AuthenticationUpstreamUnavailableError",
    "AuthenticationWorkCapacityError",
    "AuthenticationWorkTimeoutError",
    "MonitoringRunConflictError",
    "MonitoringSnapshotValidationError",
    "RealtimeEventCursorStreamError",
    "RealtimeEventSlowConsumerStreamError",
    "RealtimeEventStoreBusyError",
    "RealtimeEventStoreStreamError",
    "RealtimeEventStoreUnavailableError",
    "RealtimeEventSubscriptionStreamError",
    "RenewableStreamLeaseInvalidError",
    "RenewableStreamLeaseTimeoutError",
    "WebAuthnRelyingPartyConfigurationError",
]);

/** Redacted failure metadata safe to persist or emit outside the failing boundary. */
export interface SafeFailureDescriptor {
    readonly fingerprint: string;
    readonly kind: "error" | "tagged" | "unknown";
    readonly name?: string;
    readonly tag?: string;
}

function safeIdentifier(value: unknown): string | undefined {
    return typeof value === "string" && safeFailureIdentifierPattern.test(value)
        ? value
        : undefined;
}

function knownFailureTag(value: unknown): string | undefined {
    const identifier = safeIdentifier(value);
    return identifier !== undefined && knownFailureTags.has(identifier)
        ? identifier
        : undefined;
}

function ownDataProperty(value: object, property: string): unknown {
    try {
        const descriptor = Object.getOwnPropertyDescriptor(value, property);
        return descriptor !== undefined && "value" in descriptor
            ? descriptor.value
            : undefined;
    } catch {
        return undefined;
    }
}

function isError(value: unknown): value is Error {
    try {
        return Error.isError(value);
    } catch {
        return false;
    }
}

function descriptorWithoutFingerprint(
    failure: unknown
): Omit<SafeFailureDescriptor, "fingerprint"> {
    if (isError(failure)) {
        const tag = knownFailureTag(ownDataProperty(failure, "_tag"));
        return {
            kind: tag === undefined ? "error" : "tagged",
            name: tag ?? "Error",
            ...(tag === undefined ? {} : { tag }),
        };
    }

    return { kind: "unknown" };
}

/**
 * Converts an arbitrary failure into a stable descriptor without messages, stacks, causes, or values.
 * @param failure Unknown failure crossing an observability boundary.
 * @returns A frozen, bounded descriptor and classification-only fingerprint.
 */
export function describeSafeFailure(failure: unknown): SafeFailureDescriptor {
    let descriptor: Omit<SafeFailureDescriptor, "fingerprint">;
    try {
        descriptor = descriptorWithoutFingerprint(failure);
    } catch {
        descriptor = { kind: "unknown" };
    }
    return Object.freeze({
        ...descriptor,
        fingerprint: sha256Hex(
            `mira-dashboard:safe-failure:v1:${JSON.stringify(descriptor)}`
        ).slice(0, 24),
    });
}
