import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { handleUnauthorizedSession, notifyAuthSessionRotated } from "../lib/authBoundary";
import { authActions, useAuthUser } from "../stores/authStore";
import { apiDeleteRequired, apiFetchRequired, apiPostRequired } from "./useApi";

export type MfaMethod = "recovery" | "totp" | "webauthn";

export interface TotpFactor {
    confirmedAt: string;
    createdAt: string;
    id: string;
    label: string;
}

export interface WebAuthnCredential {
    backedUp: boolean;
    createdAt: string;
    deviceType: "multiDevice" | "singleDevice";
    id: string;
    label: string;
    lastUsedAt?: string;
}

export interface DashboardSession {
    authMethod: "password" | MfaMethod;
    authenticatedAt: string;
    createdAt: string;
    elevatedAt?: string;
    elevatedMethod?: "password" | MfaMethod;
    expiresAt: string;
    isCurrent: boolean;
    lastSeenAt: string;
    mfaVerifiedAt?: string;
    sessionId: string;
    userAgent?: string;
}

export interface AccountSecuritySummary {
    factors: {
        enabledAt?: string;
        methods: MfaMethod[];
        recoveryCodesRemaining: number;
        totpFactors: TotpFactor[];
        webAuthnCredentials: WebAuthnCredential[];
    };
    recentVerification: {
        mfa: boolean;
        mfaUntil?: string;
        password: boolean;
        passwordUntil?: string;
    };
    recommendation: {
        minimumSecurityKeys: number;
        needsBackupSecurityKey: boolean;
    };
    sessions: DashboardSession[];
    totp:
        | { available: true }
        | {
              available: false;
              reason: "encryption_key_not_configured";
          };
    webAuthn:
        | { available: true; rpId: string }
        | { available: false; reason: "not_configured" };
}

export interface TotpEnrollment {
    factorId: string;
    label: string;
    otpauthUri: string;
    secret: string;
}

interface FactorConfirmationResponse {
    isOk: boolean;
    recoveryCodes?: string[];
    sessionRotated: boolean;
}

export const accountSecurityKeys = {
    all: ["account-security"] as const,
    user: (userId: number | undefined) => [...accountSecurityKeys.all, userId] as const,
};

function invalidateSecurity(
    queryClient: ReturnType<typeof useQueryClient>,
    didRotateSession = false
): void {
    if (didRotateSession) {
        notifyAuthSessionRotated();
    }
    void queryClient.invalidateQueries({ queryKey: accountSecurityKeys.all });
    void authActions.refreshSession();
}

export function useAccountSecurity(isEnabled = true) {
    const user = useAuthUser();
    return useQuery({
        enabled: isEnabled && user !== undefined,
        queryFn: () => apiFetchRequired<AccountSecuritySummary>("/account/security"),
        queryKey: accountSecurityKeys.user(user?.id),
        staleTime: 15_000,
    });
}

export function usePasswordReauthentication() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (password: string) =>
            apiPostRequired<{ isOk: boolean }>("/account/security/reauth/password", {
                password,
            }),
        onSuccess: () => invalidateSecurity(queryClient, true),
    });
}

export function useChangePassword() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({
            currentPassword,
            newPassword,
        }: {
            currentPassword: string;
            newPassword: string;
        }) =>
            apiPostRequired<{
                isOk: boolean;
                revokedSessions: number;
            }>("/account/security/password/change", {
                currentPassword,
                newPassword,
            }),
        onSuccess: () => invalidateSecurity(queryClient, true),
    });
}

export function useTotpStepUp() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (code: string) =>
            apiPostRequired<{ isOk: boolean }>("/account/security/step-up/totp", {
                code,
            }),
        onSuccess: () => invalidateSecurity(queryClient, true),
    });
}

export function useRecoveryStepUp() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (code: string) =>
            apiPostRequired<{ isOk: boolean }>("/account/security/step-up/recovery", {
                code,
            }),
        onSuccess: () => invalidateSecurity(queryClient, true),
    });
}

export function useWebAuthnStepUp() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async () => {
            const { options } = await apiPostRequired<{
                options: Parameters<typeof startAuthentication>[0]["optionsJSON"];
            }>("/account/security/step-up/webauthn/options");
            const response = await startAuthentication({
                optionsJSON: options,
            });
            return apiPostRequired<{ isOk: boolean }>(
                "/account/security/step-up/webauthn/verify",
                { response }
            );
        },
        onSuccess: () => invalidateSecurity(queryClient, true),
    });
}

export function useCreateTotpEnrollment() {
    return useMutation({
        mutationFn: (label: string) =>
            apiPostRequired<{ enrollment: TotpEnrollment }>(
                "/account/security/totp/setup",
                { label }
            ),
    });
}

export function useConfirmTotpEnrollment() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ code, factorId }: { code: string; factorId: string }) =>
            apiPostRequired<FactorConfirmationResponse>(
                "/account/security/totp/confirm",
                { code, factorId }
            ),
        onSuccess: (response) =>
            invalidateSecurity(queryClient, response.sessionRotated === true),
    });
}

export function useRemoveTotpFactor() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (factorId: string) =>
            apiDeleteRequired<{ isOk: boolean }>(
                `/account/security/totp/${encodeURIComponent(factorId)}`
            ),
        onSuccess: () => invalidateSecurity(queryClient),
    });
}

export function useRegisterSecurityKey() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (label: string) => {
            const { options } = await apiPostRequired<{
                options: Parameters<typeof startRegistration>[0]["optionsJSON"];
            }>("/account/security/webauthn/register/options");
            const response = await startRegistration({
                optionsJSON: options,
            });
            return apiPostRequired<
                FactorConfirmationResponse & {
                    credential: WebAuthnCredential;
                }
            >("/account/security/webauthn/register/verify", {
                label,
                response,
            });
        },
        onSuccess: (response) =>
            invalidateSecurity(queryClient, response.sessionRotated === true),
    });
}

export function useRemoveSecurityKey() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (credentialId: string) =>
            apiDeleteRequired<{ isOk: boolean }>(
                `/account/security/webauthn/${encodeURIComponent(credentialId)}`
            ),
        onSuccess: () => invalidateSecurity(queryClient),
    });
}

export function useRotateRecoveryCodes() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: () =>
            apiPostRequired<{ recoveryCodes: string[] }>(
                "/account/security/recovery-codes/rotate"
            ),
        onSuccess: () => invalidateSecurity(queryClient),
    });
}

export function useDisableMfa() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (password: string) =>
            apiPostRequired<{ isOk: boolean }>("/account/security/mfa/disable", {
                password,
            }),
        onSuccess: () => invalidateSecurity(queryClient, true),
    });
}

export function useRevokeSession() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (sessionId: string) =>
            apiDeleteRequired<{ isOk: boolean; loggedOut: boolean }>(
                `/account/security/sessions/${encodeURIComponent(sessionId)}`
            ),
        onSuccess: (response) => {
            if (response.loggedOut) {
                handleUnauthorizedSession();
            } else {
                invalidateSecurity(queryClient);
            }
        },
    });
}

export function useRevokeOtherSessions() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: () =>
            apiPostRequired<{ isOk: boolean; revoked: number }>(
                "/account/security/sessions/revoke-others"
            ),
        onSuccess: () => invalidateSecurity(queryClient),
    });
}

export function useRevokeAllSessions() {
    return useMutation({
        mutationFn: () =>
            apiPostRequired<{ isOk: boolean; revoked: number }>(
                "/account/security/sessions/revoke-all"
            ),
        onSuccess: handleUnauthorizedSession,
    });
}
