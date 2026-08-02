import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
    type AccountPasswordRequest,
    type MfaCodeRequest,
    type PasswordChangeRequest,
    type TotpConfirmationRequest,
    type TotpEnrollmentRequest,
    type WebAuthnAuthenticationRequest,
    type WebAuthnRegistrationRequest,
} from "../../../contracts/accountSecurity/requests";
import {
    parseAccountSecurityMutationResponse,
    parseMfaStepUpResponse,
    parsePasswordChangeResponse,
    parsePasswordReauthenticationResponse,
    parseRecoveryCodesResponse,
    parseSessionRevocationResponse,
    parseSessionsRevocationResponse,
    parseTotpConfirmationResponse,
    parseTotpEnrollmentResponse,
    parseWebAuthnRegistrationOptionsResponse,
    parseWebAuthnRegistrationResponse,
} from "../../../contracts/accountSecurity/responses";
import { parseAccountSecuritySummary } from "../../../contracts/accountSecurity/summary";
import { parseWebAuthnOptionsResponse } from "../../../contracts/auth";
import { handleUnauthorizedSession, notifyAuthSessionRotated } from "../lib/authBoundary";
import { authActions, useAuthSessionId, useAuthUser } from "../stores/authStore";
import { apiDeleteParsed, apiFetchParsed, apiPostParsed } from "./useApi";

export const accountSecurityKeys = {
    all: ["account-security"] as const,
    session: (userId: number | undefined, sessionId: string | undefined) =>
        [...accountSecurityKeys.all, userId, sessionId] as const,
};

function invalidateSecurity(
    queryClient: ReturnType<typeof useQueryClient>,
    didRotateSession = false
): void {
    if (didRotateSession) {
        notifyAuthSessionRotated();
    }
    void queryClient.invalidateQueries({ queryKey: accountSecurityKeys.all });
    void authActions.refreshSession().catch(() => {
        // The rotated cookie remains authoritative when a best-effort refresh fails.
    });
}

export function useAccountSecurity(isEnabled = true) {
    const user = useAuthUser();
    const sessionId = useAuthSessionId();
    return useQuery({
        enabled: isEnabled && user !== undefined,
        queryFn: () => apiFetchParsed("/account/security", parseAccountSecuritySummary),
        queryKey: accountSecurityKeys.session(user?.id, sessionId),
        staleTime: 15_000,
    });
}

export function usePasswordReauthentication() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (password: string) =>
            apiPostParsed(
                "/account/security/reauth/password",
                parsePasswordReauthenticationResponse,
                { password } satisfies AccountPasswordRequest
            ),
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
            apiPostParsed(
                "/account/security/password/change",
                parsePasswordChangeResponse,
                { currentPassword, newPassword } satisfies PasswordChangeRequest
            ),
        onSuccess: () => invalidateSecurity(queryClient, true),
    });
}

export function useTotpStepUp() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (code: string) =>
            apiPostParsed("/account/security/step-up/totp", parseMfaStepUpResponse, {
                code,
            } satisfies MfaCodeRequest),
        onSuccess: () => invalidateSecurity(queryClient, true),
    });
}

export function useRecoveryStepUp() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (code: string) =>
            apiPostParsed("/account/security/step-up/recovery", parseMfaStepUpResponse, {
                code,
            } satisfies MfaCodeRequest),
        onSuccess: () => invalidateSecurity(queryClient, true),
    });
}

export function useWebAuthnStepUp() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async () => {
            const { options } = await apiPostParsed(
                "/account/security/step-up/webauthn/options",
                parseWebAuthnOptionsResponse
            );
            const response = await startAuthentication({
                optionsJSON: options,
            });
            return apiPostParsed(
                "/account/security/step-up/webauthn/verify",
                parseMfaStepUpResponse,
                { response } satisfies WebAuthnAuthenticationRequest,
                {
                    canRetryAfterUnauthorizedRecovery: false,
                    canRetryAfterSecurityVerification: false,
                }
            );
        },
        onSuccess: () => invalidateSecurity(queryClient, true),
    });
}

export function useCreateTotpEnrollment() {
    return useMutation({
        mutationFn: (label: string) =>
            apiPostParsed("/account/security/totp/setup", parseTotpEnrollmentResponse, {
                label,
            } satisfies TotpEnrollmentRequest),
    });
}

export function useConfirmTotpEnrollment() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ code, factorId }: { code: string; factorId: string }) =>
            apiPostParsed(
                "/account/security/totp/confirm",
                parseTotpConfirmationResponse,
                { code, factorId } satisfies TotpConfirmationRequest,
                { canRetryAfterSecurityVerification: false }
            ),
        onSuccess: (response) => invalidateSecurity(queryClient, response.sessionRotated),
    });
}

export function useRemoveTotpFactor() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (factorId: string) =>
            apiDeleteParsed(
                `/account/security/totp/${encodeURIComponent(factorId)}`,
                parseAccountSecurityMutationResponse
            ),
        onSuccess: () => invalidateSecurity(queryClient),
    });
}

export function useRegisterSecurityKey() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (label: string) => {
            const { options } = await apiPostParsed(
                "/account/security/webauthn/register/options",
                parseWebAuthnRegistrationOptionsResponse
            );
            const response = await startRegistration({
                optionsJSON: options,
            });
            return apiPostParsed(
                "/account/security/webauthn/register/verify",
                parseWebAuthnRegistrationResponse,
                {
                    label,
                    response,
                } satisfies WebAuthnRegistrationRequest,
                {
                    canRetryAfterUnauthorizedRecovery: false,
                    canRetryAfterSecurityVerification: false,
                }
            );
        },
        onSuccess: (response) => invalidateSecurity(queryClient, response.sessionRotated),
    });
}

export function useRemoveSecurityKey() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (credentialId: string) =>
            apiDeleteParsed(
                `/account/security/webauthn/${encodeURIComponent(credentialId)}`,
                parseAccountSecurityMutationResponse
            ),
        onSuccess: () => invalidateSecurity(queryClient),
    });
}

export function useRotateRecoveryCodes() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: () =>
            apiPostParsed(
                "/account/security/recovery-codes/rotate",
                parseRecoveryCodesResponse
            ),
        onSuccess: () => invalidateSecurity(queryClient),
    });
}

export function useDisableMfa() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (password: string) =>
            apiPostParsed(
                "/account/security/mfa/disable",
                parseAccountSecurityMutationResponse,
                { password } satisfies AccountPasswordRequest
            ),
        onSuccess: () => invalidateSecurity(queryClient, true),
    });
}

export function useRevokeSession() {
    const queryClient = useQueryClient();
    const currentSessionId = useAuthSessionId();
    return useMutation({
        mutationFn: (sessionId: string) =>
            apiDeleteParsed(
                `/account/security/sessions/${encodeURIComponent(sessionId)}`,
                parseSessionRevocationResponse,
                {
                    canRetryAfterUnauthorizedRecovery: sessionId !== currentSessionId,
                    canRetryAfterSecurityVerification: sessionId !== currentSessionId,
                }
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
            apiPostParsed(
                "/account/security/sessions/revoke-others",
                parseSessionsRevocationResponse
            ),
        onSuccess: () => invalidateSecurity(queryClient),
    });
}

export function useRevokeAllSessions() {
    return useMutation({
        mutationFn: () =>
            apiPostParsed(
                "/account/security/sessions/revoke-all",
                parseSessionsRevocationResponse
            ),
        onSuccess: handleUnauthorizedSession,
    });
}
