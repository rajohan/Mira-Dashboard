import { addMilliseconds, compareAsc } from "date-fns";

import { webAuthnCredentialMaximumPerUser } from "../../../../contracts/accountSecurity.ts";
import type { MfaWebAuthnCredentialRecord } from "./lifecycleRepositoryTypes.ts";
import type { MfaLoginLifecycleContext } from "./loginLifecycleContext.ts";
import type { MfaLoginLifecycleService } from "./loginLifecycleTypes.ts";
import { resolvePendingLogin } from "./loginPendingLifecycle.ts";
import {
    webAuthnCredentialDescriptor,
    webAuthnCredentialSnapshotMatches,
} from "./webauthn/credentialState.ts";

const webAuthnLoginChallengeLifetimeMs = 5 * 60 * 1000;
const webAuthnCredentialReadMaximum = webAuthnCredentialMaximumPerUser + 1;

type WebAuthnLoginChallengeOperation = Pick<
    MfaLoginLifecycleService,
    "beginWebAuthnLogin"
>;

type WebAuthnLoginChallengePort = Pick<
    MfaLoginLifecycleContext,
    "generateId" | "now" | "repository" | "webAuthn"
>;

function compatibleCredentials(
    credentials: readonly MfaWebAuthnCredentialRecord[],
    rpId: string
): readonly MfaWebAuthnCredentialRecord[] | undefined {
    if (credentials.length > webAuthnCredentialMaximumPerUser) return undefined;
    return credentials.filter((credential) => credential.rpId === rpId);
}

function sameCredentialSnapshot(
    current: readonly MfaWebAuthnCredentialRecord[],
    expected: readonly MfaWebAuthnCredentialRecord[]
): boolean {
    return (
        current.length === expected.length &&
        current.every((credential, index) => {
            const expectedCredential = expected[index];
            return (
                expectedCredential !== undefined &&
                webAuthnCredentialSnapshotMatches(credential, expectedCredential)
            );
        })
    );
}

function generatedCredentialSetMatches(
    generatedIds: readonly string[],
    credentials: readonly MfaWebAuthnCredentialRecord[]
): boolean {
    if (generatedIds.length !== credentials.length) return false;
    const expected = new Set(credentials.map((credential) => credential.credentialId));
    return generatedIds.every((id) => expected.delete(id)) && expected.size === 0;
}

/**
 * Creates the pending-login-bound WebAuthn assertion challenge operation.
 * @returns Frozen challenge-generation operation.
 */
export function createWebAuthnLoginChallengeOperation(
    context: WebAuthnLoginChallengePort
): WebAuthnLoginChallengeOperation {
    const { generateId, now, repository } = context;

    return Object.freeze({
        async beginWebAuthnLogin(credential, metadata) {
            metadata.signal?.throwIfAborted();
            const webAuthn = context.webAuthn;
            if (webAuthn === undefined) return { status: "service-unavailable" };

            const checkedAt = now();
            const snapshot = repository.withReadTransaction((reader) => {
                const resolved = resolvePendingLogin(reader, credential, checkedAt);
                const credentials =
                    resolved === undefined
                        ? []
                        : reader.listWebAuthnCredentials(
                              resolved.user.id,
                              webAuthnCredentialReadMaximum
                          );
                return { credentials, resolved };
            });
            if (snapshot.resolved === undefined) return { status: "state-changed" };
            if (!snapshot.resolved.pending.allowsWebAuthn) {
                return { status: "not-available" };
            }
            const available = compatibleCredentials(
                snapshot.credentials,
                webAuthn.relyingParty.rpId
            );
            if (available === undefined || available.length === 0) {
                return { status: "not-available" };
            }

            let generation: Awaited<
                ReturnType<typeof webAuthn.adapter.generateAuthenticationOptions>
            >;
            try {
                generation = await webAuthn.adapter.generateAuthenticationOptions({
                    allowCredentials: available.map((storedCredential) =>
                        webAuthnCredentialDescriptor(storedCredential)
                    ),
                });
            } catch {
                metadata.signal?.throwIfAborted();
                return { status: "service-unavailable" };
            }
            metadata.signal?.throwIfAborted();
            if (
                generation.status !== "generated" ||
                (generation.status === "generated" &&
                    generation.options.rpId !== webAuthn.relyingParty.rpId) ||
                !generatedCredentialSetMatches(
                    generation.status === "generated"
                        ? generation.options.allowCredentials.map(({ id }) => id)
                        : [],
                    available
                )
            ) {
                return { status: "service-unavailable" };
            }

            const committedAt = now();
            const challengeId = generateId();
            return repository.withImmediateTransaction((unit) => {
                const current = resolvePendingLogin(
                    unit,
                    credential,
                    committedAt,
                    "webauthn"
                );
                if (current === undefined) return { status: "state-changed" } as const;
                const currentCredentials = unit.listWebAuthnCredentials(
                    current.user.id,
                    webAuthnCredentialReadMaximum
                );
                if (!sameCredentialSnapshot(currentCredentials, snapshot.credentials)) {
                    return { status: "not-available" } as const;
                }
                const currentAvailable = compatibleCredentials(
                    currentCredentials,
                    webAuthn.relyingParty.rpId
                );
                if (
                    currentAvailable === undefined ||
                    currentAvailable.length === 0 ||
                    !generatedCredentialSetMatches(
                        generation.options.allowCredentials.map(({ id }) => id),
                        currentAvailable
                    )
                ) {
                    return { status: "not-available" } as const;
                }

                const expiresAt = new Date(
                    Math.min(
                        addMilliseconds(
                            committedAt,
                            webAuthnLoginChallengeLifetimeMs
                        ).getTime(),
                        current.pending.expiresAt.getTime()
                    )
                );
                if (compareAsc(expiresAt, committedAt) <= 0) {
                    return { status: "state-changed" } as const;
                }
                const challenge = unit.replaceWebAuthnChallenge({
                    authenticationVersion: current.pending.authenticationVersion,
                    challenge: generation.options.challenge,
                    configFingerprint: webAuthn.relyingParty.fingerprint,
                    createdAt: committedAt,
                    expiresAt,
                    id: challengeId,
                    pendingLoginId: current.pending.id,
                    purpose: "login",
                    sessionId: null,
                });
                return {
                    expiresAtMs: challenge.expiresAt.getTime(),
                    options: generation.options,
                    status: "created",
                } as const;
            });
        },
    });
}
