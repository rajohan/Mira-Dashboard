import { useState } from "react";

import type { TotpEnrollment } from "../../../../../contracts/accountSecurity/responses";
import {
    useAccountSecurity,
    useChangePassword,
    useConfirmTotpEnrollment,
    useCreateTotpEnrollment,
    useDisableMfa,
    usePasswordReauthentication,
    useRecoveryStepUp,
    useRegisterSecurityKey,
    useRemoveSecurityKey,
    useRemoveTotpFactor,
    useRevokeAllSessions,
    useRevokeOtherSessions,
    useRevokeSession,
    useRotateRecoveryCodes,
    useTotpStepUp,
    useWebAuthnStepUp,
} from "../../../hooks/useAccountSecurity";
import { messageFromError } from "../../../lib/errorMessage";

type VerificationMode = "mfa" | "password" | undefined;
type PendingFactorRemoval =
    | {
          id: string;
          label: string;
          type: "security-key" | "totp";
      }
    | undefined;

export function useAccountSecurityController() {
    const { data, isLoading } = useAccountSecurity();
    const changePassword = useChangePassword();
    const passwordReauth = usePasswordReauthentication();
    const totpStepUp = useTotpStepUp();
    const recoveryStepUp = useRecoveryStepUp();
    const webAuthnStepUp = useWebAuthnStepUp();
    const registerSecurityKey = useRegisterSecurityKey();
    const removeSecurityKey = useRemoveSecurityKey();
    const createTotp = useCreateTotpEnrollment();
    const confirmTotp = useConfirmTotpEnrollment();
    const removeTotp = useRemoveTotpFactor();
    const rotateRecoveryCodes = useRotateRecoveryCodes();
    const disableMfa = useDisableMfa();
    const revokeSession = useRevokeSession();
    const revokeOthers = useRevokeOtherSessions();
    const revokeAll = useRevokeAllSessions();

    const [error, setError] = useState<string>();
    const [success, setSuccess] = useState<string>();
    const [verificationMode, setVerificationMode] = useState<VerificationMode>();
    const [verificationCode, setVerificationCode] = useState("");
    const [password, setPassword] = useState("");
    const [keyLabel, setKeyLabel] = useState("Primary YubiKey");
    const [showKeyModal, setShowKeyModal] = useState(false);
    const [totpLabel, setTotpLabel] = useState("Authenticator app");
    const [totpEnrollment, setTotpEnrollment] = useState<TotpEnrollment>();
    const [totpCode, setTotpCode] = useState("");
    const [showTotpModal, setShowTotpModal] = useState(false);
    const [recoveryCodes, setRecoveryCodes] = useState<string[]>();
    const [showDisableModal, setShowDisableModal] = useState(false);
    const [showPasswordModal, setShowPasswordModal] = useState(false);
    const [currentPassword, setCurrentPassword] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [pendingFactorRemoval, setPendingFactorRemoval] =
        useState<PendingFactorRemoval>();

    const isMfaEnabled = Boolean(data?.factors.enabledAt);
    const registeredSecurityKeyCount = data?.factors.webAuthnCredentials.length ?? 0;
    let canManage = false;
    if (data) {
        canManage = isMfaEnabled
            ? data.recentVerification.mfa
            : data.recentVerification.password;
    }
    const isBusy =
        changePassword.isPending ||
        passwordReauth.isPending ||
        totpStepUp.isPending ||
        recoveryStepUp.isPending ||
        webAuthnStepUp.isPending ||
        registerSecurityKey.isPending ||
        createTotp.isPending ||
        confirmTotp.isPending ||
        removeSecurityKey.isPending ||
        removeTotp.isPending ||
        rotateRecoveryCodes.isPending ||
        disableMfa.isPending ||
        revokeSession.isPending ||
        revokeOthers.isPending ||
        revokeAll.isPending;

    function requiresManagementVerification(): boolean {
        if (canManage) return true;
        setVerificationMode(isMfaEnabled ? "mfa" : "password");
        setError(undefined);
        return false;
    }

    async function registerKey(): Promise<void> {
        if (!requiresManagementVerification()) {
            setShowKeyModal(false);
            return;
        }
        setError(undefined);
        try {
            const result = await registerSecurityKey.mutateAsync(keyLabel.trim());
            setShowKeyModal(false);
            setKeyLabel(
                registeredSecurityKeyCount === 0 ? "Backup YubiKey" : "Additional YubiKey"
            );
            if (result.recoveryCodes?.length) {
                setRecoveryCodes(result.recoveryCodes);
            }
            setSuccess("Security key registered");
            registerSecurityKey.reset();
        } catch (error_) {
            setError(messageFromError(error_, "Security-key registration failed"));
        }
    }

    async function startTotpSetup(): Promise<void> {
        if (!requiresManagementVerification()) {
            setShowTotpModal(false);
            return;
        }
        setError(undefined);
        try {
            const result = await createTotp.mutateAsync(totpLabel.trim());
            setTotpEnrollment(result.enrollment);
            setTotpCode("");
            createTotp.reset();
        } catch (error_) {
            setError(messageFromError(error_, "Authenticator setup failed"));
        }
    }

    async function completeTotpSetup(): Promise<void> {
        if (!totpEnrollment) return;
        setError(undefined);
        try {
            const result = await confirmTotp.mutateAsync({
                code: totpCode,
                factorId: totpEnrollment.factorId,
            });
            setShowTotpModal(false);
            setTotpEnrollment(undefined);
            setTotpCode("");
            if (result.recoveryCodes?.length) {
                setRecoveryCodes(result.recoveryCodes);
            }
            setSuccess("Authenticator app added");
            confirmTotp.reset();
        } catch (error_) {
            setError(messageFromError(error_, "Authenticator code was not accepted"));
        }
    }

    async function verifyPassword(): Promise<void> {
        setError(undefined);
        try {
            await passwordReauth.mutateAsync(password);
            setPassword("");
            setVerificationMode(undefined);
            setSuccess("Password verified for sensitive changes");
        } catch (error_) {
            setError(messageFromError(error_, "Password verification failed"));
        }
    }

    async function verifyMfa(method: "recovery" | "totp" | "webauthn"): Promise<void> {
        setError(undefined);
        try {
            if (method === "webauthn") {
                await webAuthnStepUp.mutateAsync();
            } else if (method === "totp") {
                await totpStepUp.mutateAsync(verificationCode);
            } else {
                await recoveryStepUp.mutateAsync(verificationCode);
            }
            setVerificationCode("");
            setVerificationMode(undefined);
            setSuccess("Recent MFA verification recorded");
        } catch (error_) {
            setError(messageFromError(error_, "MFA verification failed"));
        }
    }

    async function rotateCodes(): Promise<void> {
        if (!requiresManagementVerification()) return;
        setError(undefined);
        try {
            const result = await rotateRecoveryCodes.mutateAsync();
            setRecoveryCodes(result.recoveryCodes);
            rotateRecoveryCodes.reset();
        } catch (error_) {
            setError(messageFromError(error_, "Could not rotate recovery codes"));
        }
    }

    async function removeSelectedFactor(): Promise<void> {
        if (!pendingFactorRemoval) return;
        setError(undefined);
        try {
            if (pendingFactorRemoval.type === "security-key") {
                await removeSecurityKey.mutateAsync(pendingFactorRemoval.id);
                setSuccess("Security key removed");
            } else {
                await removeTotp.mutateAsync(pendingFactorRemoval.id);
                setSuccess("Authenticator app removed");
            }
            setPendingFactorRemoval(undefined);
        } catch (error_) {
            setError(
                messageFromError(
                    error_,
                    pendingFactorRemoval.type === "security-key"
                        ? "Could not remove security key"
                        : "Could not remove authenticator app"
                )
            );
        }
    }

    async function copyRecoveryCodes(): Promise<void> {
        try {
            if (!navigator.clipboard) {
                throw new Error("Clipboard API unavailable");
            }
            await navigator.clipboard.writeText(recoveryCodes?.join("\n") ?? "");
            setSuccess("Recovery codes copied");
        } catch {
            setError("Could not copy recovery codes");
        }
    }
    return {
        canManage,
        changePassword,
        completeTotpSetup,
        confirmPassword,
        confirmTotp,
        copyRecoveryCodes,
        createTotp,
        currentPassword,
        data,
        disableMfa,
        error,
        isBusy,
        isLoading,
        isMfaEnabled,
        keyLabel,
        newPassword,
        password,
        passwordReauth,
        pendingFactorRemoval,
        recoveryCodes,
        recoveryStepUp,
        registerKey,
        registerSecurityKey,
        registeredSecurityKeyCount,
        removeSecurityKey,
        removeSelectedFactor,
        removeTotp,
        requiresManagementVerification,
        revokeAll,
        revokeOthers,
        revokeSession,
        rotateCodes,
        rotateRecoveryCodes,
        setConfirmPassword,
        setCurrentPassword,
        setError,
        setKeyLabel,
        setNewPassword,
        setPassword,
        setPendingFactorRemoval,
        setRecoveryCodes,
        setShowDisableModal,
        setShowKeyModal,
        setShowPasswordModal,
        setShowTotpModal,
        setSuccess,
        setTotpCode,
        setTotpEnrollment,
        setTotpLabel,
        setVerificationCode,
        setVerificationMode,
        showDisableModal,
        showKeyModal,
        showPasswordModal,
        showTotpModal,
        startTotpSetup,
        success,
        totpCode,
        totpEnrollment,
        totpLabel,
        totpStepUp,
        verificationCode,
        verificationMode,
        verifyMfa,
        verifyPassword,
        webAuthnStepUp,
    };
}

export type AccountSecurityController = ReturnType<typeof useAccountSecurityController>;
