import {
    Copy,
    Download,
    KeyRound,
    Laptop,
    LogOut,
    Plus,
    RefreshCw,
    ShieldCheck,
    Smartphone,
    Trash2,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";

import {
    type TotpEnrollment,
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
} from "../../../hooks";
import { formatDate } from "../../../utils/format";
import { Alert } from "../../ui/Alert";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Card, CardTitle } from "../../ui/Card";
import { ConfirmModal } from "../../ui/ConfirmModal";
import { Input } from "../../ui/Input";
import { LoadingState } from "../../ui/LoadingState";
import { Modal } from "../../ui/Modal";

type VerificationMode = "mfa" | "password" | undefined;
type PendingFactorRemoval =
    | {
          id: string;
          label: string;
          type: "security-key" | "totp";
      }
    | undefined;

function message(error: unknown, fallback: string): string {
    return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function downloadRecoveryCodes(codes: string[]): void {
    const blob = new Blob(
        [
            [
                "Mira Dashboard recovery codes",
                "Each code can be used once. Store these offline.",
                "",
                ...codes,
                "",
            ].join("\n"),
        ],
        { type: "text/plain;charset=utf-8" }
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "mira-dashboard-recovery-codes.txt";
    anchor.click();
    URL.revokeObjectURL(url);
}

/** Renders Dashboard-owned account security, factors, recovery, and sessions. */
export function AccountSecuritySection() {
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

    if (isLoading || !data) {
        return <LoadingState size="lg" />;
    }

    const isMfaEnabled = Boolean(data.factors.enabledAt);
    const registeredSecurityKeyCount = data.factors.webAuthnCredentials.length;
    const canManage = isMfaEnabled
        ? data.recentVerification.mfa
        : data.recentVerification.password;
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
            setError(message(error_, "Security-key registration failed"));
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
            setError(message(error_, "Authenticator setup failed"));
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
            setError(message(error_, "Authenticator code was not accepted"));
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
            setError(message(error_, "Password verification failed"));
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
            setError(message(error_, "MFA verification failed"));
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
            setError(message(error_, "Could not rotate recovery codes"));
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
                message(
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

    return (
        <div className="space-y-4">
            {error ? (
                <Alert variant="error">
                    {error}
                    <Button
                        className="ml-auto"
                        onClick={() => setError(undefined)}
                        size="sm"
                        variant="ghost"
                    >
                        ×
                    </Button>
                </Alert>
            ) : undefined}
            {success ? (
                <Alert variant="success">
                    {success}
                    <Button
                        className="ml-auto"
                        onClick={() => setSuccess(undefined)}
                        size="sm"
                        variant="ghost"
                    >
                        ×
                    </Button>
                </Alert>
            ) : undefined}

            <Card variant="bordered">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                        <div className="flex items-center gap-2">
                            <ShieldCheck className="size-5 text-accent-400" />
                            <CardTitle>Two-step login</CardTitle>
                            <Badge variant={isMfaEnabled ? "success" : "warning"}>
                                {isMfaEnabled ? "Enabled" : "Not enabled"}
                            </Badge>
                        </div>
                        <p className="mt-2 text-sm text-primary-400">
                            Security keys are phishing-resistant. TOTP is supported as an
                            optional lower-assurance alternative.
                        </p>
                    </div>
                    {isMfaEnabled ? (
                        <Button
                            disabled={isBusy}
                            onClick={() => setVerificationMode("mfa")}
                            variant="secondary"
                        >
                            Verify now
                        </Button>
                    ) : data.recentVerification.password ? undefined : (
                        <Button
                            disabled={isBusy}
                            onClick={() => setVerificationMode("password")}
                            variant="secondary"
                        >
                            Verify password
                        </Button>
                    )}
                </div>
            </Card>

            <div className="grid gap-4 xl:grid-cols-2">
                <Card variant="bordered">
                    <div className="flex items-start justify-between gap-3">
                        <div>
                            <div className="flex items-center gap-2">
                                <KeyRound className="size-5 text-accent-400" />
                                <CardTitle>Security keys</CardTitle>
                            </div>
                            <p className="mt-1 text-sm text-primary-400">
                                Register two named YubiKeys and store the backup
                                separately.
                            </p>
                        </div>
                        <Button
                            disabled={isBusy || !data.webAuthn.available}
                            onClick={() => {
                                if (!requiresManagementVerification()) return;
                                setKeyLabel(
                                    data.factors.webAuthnCredentials.length === 0
                                        ? "Primary YubiKey"
                                        : "Backup YubiKey"
                                );
                                setShowKeyModal(true);
                            }}
                            size="sm"
                        >
                            <Plus className="size-4" />
                            Add key
                        </Button>
                    </div>

                    {data.webAuthn.available ? undefined : (
                        <Alert className="mt-3" variant="warning">
                            WebAuthn RP ID and HTTPS origin are not configured.
                        </Alert>
                    )}
                    {data.recommendation.needsBackupSecurityKey ? (
                        <Alert className="mt-3" variant="warning">
                            Add a second YubiKey before relying on security-key-only
                            login.
                        </Alert>
                    ) : undefined}

                    <div className="mt-3 space-y-2">
                        {data.factors.webAuthnCredentials.map((credential) => (
                            <div
                                className="flex items-center justify-between gap-3 rounded-lg border border-primary-700 bg-primary-900/40 p-3"
                                key={credential.id}
                            >
                                <div className="min-w-0">
                                    <div className="truncate text-sm font-medium text-primary-100">
                                        {credential.label}
                                    </div>
                                    <div className="text-xs text-primary-400">
                                        Added {formatDate(credential.createdAt)}
                                        {credential.lastUsedAt
                                            ? ` · last used ${formatDate(credential.lastUsedAt)}`
                                            : ""}
                                    </div>
                                </div>
                                <Button
                                    aria-label={`Remove ${credential.label}`}
                                    disabled={isBusy}
                                    onClick={() => {
                                        if (!requiresManagementVerification()) return;
                                        setPendingFactorRemoval({
                                            id: credential.id,
                                            label: credential.label,
                                            type: "security-key",
                                        });
                                    }}
                                    size="sm"
                                    variant="danger"
                                >
                                    <Trash2 className="size-4" />
                                </Button>
                            </div>
                        ))}
                        {data.factors.webAuthnCredentials.length === 0 ? (
                            <p className="py-3 text-sm text-primary-500">
                                No security keys registered.
                            </p>
                        ) : undefined}
                    </div>
                </Card>

                <Card variant="bordered">
                    <div className="flex items-start justify-between gap-3">
                        <div>
                            <div className="flex items-center gap-2">
                                <Smartphone className="size-5 text-accent-400" />
                                <CardTitle>Authenticator apps</CardTitle>
                            </div>
                            <p className="mt-1 text-sm text-primary-400">
                                Standard 6-digit RFC 6238 TOTP.
                            </p>
                        </div>
                        <Button
                            disabled={isBusy || !data.totp.available}
                            onClick={() => {
                                if (!requiresManagementVerification()) return;
                                setTotpEnrollment(undefined);
                                setTotpLabel("Authenticator app");
                                setShowTotpModal(true);
                            }}
                            size="sm"
                            variant="secondary"
                        >
                            <Plus className="size-4" />
                            Add app
                        </Button>
                    </div>
                    {data.totp.available ? undefined : (
                        <Alert className="mt-3" variant="warning">
                            TOTP encryption is not configured on the Dashboard host.
                        </Alert>
                    )}
                    <div className="mt-3 space-y-2">
                        {data.factors.totpFactors.map((factor) => (
                            <div
                                className="flex items-center justify-between gap-3 rounded-lg border border-primary-700 bg-primary-900/40 p-3"
                                key={factor.id}
                            >
                                <div>
                                    <div className="text-sm font-medium text-primary-100">
                                        {factor.label}
                                    </div>
                                    <div className="text-xs text-primary-400">
                                        Added {formatDate(factor.confirmedAt)}
                                    </div>
                                </div>
                                <Button
                                    aria-label={`Remove ${factor.label}`}
                                    disabled={isBusy}
                                    onClick={() => {
                                        if (!requiresManagementVerification()) return;
                                        setPendingFactorRemoval({
                                            id: factor.id,
                                            label: factor.label,
                                            type: "totp",
                                        });
                                    }}
                                    size="sm"
                                    variant="danger"
                                >
                                    <Trash2 className="size-4" />
                                </Button>
                            </div>
                        ))}
                        {data.factors.totpFactors.length === 0 ? (
                            <p className="py-3 text-sm text-primary-500">
                                No authenticator apps registered.
                            </p>
                        ) : undefined}
                    </div>
                </Card>
            </div>

            <Card variant="bordered">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                        <div className="flex items-center gap-2">
                            <ShieldCheck className="size-5 text-accent-400" />
                            <CardTitle>Recovery codes</CardTitle>
                        </div>
                        <p className="mt-1 text-sm text-primary-400">
                            {data.factors.recoveryCodesRemaining} unused one-time codes
                            remain. Full codes are shown only when generated.
                        </p>
                    </div>
                    <Button
                        disabled={isBusy || !isMfaEnabled}
                        onClick={() => void rotateCodes()}
                        variant="secondary"
                    >
                        <RefreshCw className="size-4" />
                        Rotate codes
                    </Button>
                </div>
            </Card>

            <Card variant="bordered">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                        <div className="flex items-center gap-2">
                            <KeyRound className="size-5 text-accent-400" />
                            <CardTitle>Dashboard password</CardTitle>
                        </div>
                        <p className="mt-1 text-sm text-primary-400">
                            Changing it revokes every other Dashboard session. Forgotten
                            passwords require the host-local recovery command.
                        </p>
                    </div>
                    <Button
                        disabled={isBusy}
                        onClick={() => {
                            if (isMfaEnabled && !data.recentVerification.mfa) {
                                setVerificationMode("mfa");
                                return;
                            }
                            setCurrentPassword("");
                            setNewPassword("");
                            setConfirmPassword("");
                            setShowPasswordModal(true);
                        }}
                        variant="secondary"
                    >
                        Change password
                    </Button>
                </div>
            </Card>

            <Card variant="bordered">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                        <div className="flex items-center gap-2">
                            <Laptop className="size-5 text-accent-400" />
                            <CardTitle>Active sessions</CardTitle>
                        </div>
                        <p className="mt-1 text-sm text-primary-400">
                            Sessions expire after inactivity and can be revoked
                            independently.
                        </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <Button
                            disabled={isBusy || data.sessions.length <= 1}
                            onClick={() => {
                                if (!requiresManagementVerification()) return;
                                void revokeOthers
                                    .mutateAsync()
                                    .catch((error_) =>
                                        setError(
                                            message(
                                                error_,
                                                "Could not revoke other sessions"
                                            )
                                        )
                                    );
                            }}
                            size="sm"
                            variant="secondary"
                        >
                            Log out others
                        </Button>
                        <Button
                            disabled={isBusy}
                            onClick={() => {
                                if (!requiresManagementVerification()) return;
                                void revokeAll
                                    .mutateAsync()
                                    .catch((error_) =>
                                        setError(
                                            message(
                                                error_,
                                                "Could not log out all sessions"
                                            )
                                        )
                                    );
                            }}
                            size="sm"
                            variant="danger"
                        >
                            <LogOut className="size-4" />
                            Log out all
                        </Button>
                    </div>
                </div>
                <div className="mt-3 space-y-2">
                    {data.sessions.map((session) => (
                        <div
                            className="flex flex-col gap-3 rounded-lg border border-primary-700 bg-primary-900/40 p-3 sm:flex-row sm:items-center sm:justify-between"
                            key={session.sessionId}
                        >
                            <div className="min-w-0">
                                <div className="flex items-center gap-2 text-sm font-medium text-primary-100">
                                    <span className="truncate">
                                        {session.userAgent || "Unknown browser"}
                                    </span>
                                    {session.isCurrent ? (
                                        <Badge variant="success">Current</Badge>
                                    ) : undefined}
                                </div>
                                <div className="text-xs text-primary-400">
                                    Last active {formatDate(session.lastSeenAt)} ·{" "}
                                    {session.authMethod}
                                </div>
                            </div>
                            <Button
                                disabled={isBusy}
                                onClick={() => {
                                    if (!requiresManagementVerification()) return;
                                    void revokeSession
                                        .mutateAsync(session.sessionId)
                                        .catch((error_) =>
                                            setError(
                                                message(
                                                    error_,
                                                    "Could not revoke session"
                                                )
                                            )
                                        );
                                }}
                                size="sm"
                                variant={session.isCurrent ? "danger" : "secondary"}
                            >
                                {session.isCurrent ? "Log out" : "Revoke"}
                            </Button>
                        </div>
                    ))}
                </div>
            </Card>

            {isMfaEnabled ? (
                <Card className="border-red-800/60" variant="bordered">
                    <CardTitle>Disable two-step login</CardTitle>
                    <p className="mt-1 text-sm text-primary-400">
                        Removes all keys, authenticator apps, and recovery codes. All
                        sessions are revoked.
                    </p>
                    <Button
                        className="mt-3"
                        disabled={isBusy}
                        onClick={() => {
                            if (!requiresManagementVerification()) return;
                            setPassword("");
                            setShowDisableModal(true);
                        }}
                        variant="danger"
                    >
                        Disable MFA
                    </Button>
                </Card>
            ) : undefined}

            {pendingFactorRemoval ? (
                <ConfirmModal
                    confirmLabel="Remove factor"
                    danger
                    isOpen
                    loading={removeSecurityKey.isPending || removeTotp.isPending}
                    message={`Remove ${pendingFactorRemoval.label}? You cannot remove the final configured second factor.`}
                    onCancel={() => setPendingFactorRemoval(undefined)}
                    onConfirm={() => void removeSelectedFactor()}
                    title="Remove login factor"
                />
            ) : undefined}

            {showPasswordModal ? (
                <Modal
                    isOpen={showPasswordModal}
                    onClose={() => {
                        setCurrentPassword("");
                        setNewPassword("");
                        setConfirmPassword("");
                        setShowPasswordModal(false);
                    }}
                    size="sm"
                    title="Change Dashboard password"
                >
                    <form
                        className="space-y-4"
                        onSubmit={(event_) => {
                            event_.preventDefault();
                            setError(undefined);
                            if (newPassword !== confirmPassword) {
                                setError("New passwords do not match");
                                return;
                            }
                            void changePassword
                                .mutateAsync({
                                    currentPassword,
                                    newPassword,
                                })
                                .then((result) => {
                                    setCurrentPassword("");
                                    setNewPassword("");
                                    setConfirmPassword("");
                                    setShowPasswordModal(false);
                                    setSuccess(
                                        `Password changed; ${result.revokedSessions} other session${result.revokedSessions === 1 ? "" : "s"} revoked`
                                    );
                                })
                                .catch((error_) =>
                                    setError(message(error_, "Could not change password"))
                                );
                        }}
                    >
                        <Input
                            autoComplete="current-password"
                            label="Current password"
                            onChange={(event_) => setCurrentPassword(event_.target.value)}
                            type="password"
                            value={currentPassword}
                        />
                        <Input
                            autoComplete="new-password"
                            description="8-256 characters"
                            label="New password"
                            minLength={8}
                            onChange={(event_) => setNewPassword(event_.target.value)}
                            type="password"
                            value={newPassword}
                        />
                        <Input
                            autoComplete="new-password"
                            label="Confirm new password"
                            minLength={8}
                            onChange={(event_) => setConfirmPassword(event_.target.value)}
                            type="password"
                            value={confirmPassword}
                        />
                        <Button
                            className="w-full"
                            disabled={
                                isBusy ||
                                !currentPassword ||
                                newPassword.length < 8 ||
                                !confirmPassword
                            }
                            type="submit"
                        >
                            Change and revoke other sessions
                        </Button>
                    </form>
                </Modal>
            ) : undefined}

            {verificationMode === undefined ? undefined : (
                <Modal
                    isOpen={verificationMode !== undefined}
                    onClose={() => {
                        setVerificationCode("");
                        setPassword("");
                        setVerificationMode(undefined);
                    }}
                    size="sm"
                    title={
                        verificationMode === "password"
                            ? "Verify current password"
                            : "Verify second factor"
                    }
                >
                    {verificationMode === "password" ? (
                        <form
                            className="space-y-4"
                            onSubmit={(event_) => {
                                event_.preventDefault();
                                void verifyPassword();
                            }}
                        >
                            <Input
                                autoComplete="current-password"
                                label="Current password"
                                onChange={(event_) => setPassword(event_.target.value)}
                                type="password"
                                value={password}
                            />
                            <Button
                                className="w-full"
                                disabled={isBusy || !password}
                                type="submit"
                            >
                                Verify
                            </Button>
                        </form>
                    ) : (
                        <div className="space-y-3">
                            {data.factors.methods.includes("webauthn") ? (
                                <Button
                                    className="w-full"
                                    disabled={isBusy}
                                    onClick={() => void verifyMfa("webauthn")}
                                >
                                    <KeyRound className="size-4" />
                                    Use security key
                                </Button>
                            ) : undefined}
                            {data.factors.methods.includes("totp") ? (
                                <form
                                    className="space-y-2"
                                    onSubmit={(event_) => {
                                        event_.preventDefault();
                                        void verifyMfa("totp");
                                    }}
                                >
                                    <Input
                                        autoComplete="one-time-code"
                                        inputMode="numeric"
                                        label="Authenticator code"
                                        onChange={(event_) =>
                                            setVerificationCode(event_.target.value)
                                        }
                                        value={verificationCode}
                                    />
                                    <Button
                                        className="w-full"
                                        disabled={isBusy || !verificationCode.trim()}
                                        type="submit"
                                        variant="secondary"
                                    >
                                        Verify TOTP
                                    </Button>
                                </form>
                            ) : undefined}
                            {data.factors.methods.includes("recovery") ? (
                                <Button
                                    className="w-full"
                                    disabled={isBusy || !verificationCode.trim()}
                                    onClick={() => void verifyMfa("recovery")}
                                    variant="ghost"
                                >
                                    Use entered value as recovery code
                                </Button>
                            ) : undefined}
                        </div>
                    )}
                </Modal>
            )}

            {showKeyModal ? (
                <Modal
                    isOpen={showKeyModal}
                    onClose={() => setShowKeyModal(false)}
                    size="sm"
                    title="Register security key"
                >
                    <div className="space-y-4">
                        <Input
                            description="Use a distinct name such as Primary YubiKey or Backup YubiKey."
                            label="Key name"
                            maxLength={64}
                            onChange={(event_) => setKeyLabel(event_.target.value)}
                            value={keyLabel}
                        />
                        <Button
                            className="w-full"
                            disabled={isBusy || !keyLabel.trim()}
                            onClick={() => void registerKey()}
                        >
                            Touch and register key
                        </Button>
                    </div>
                </Modal>
            ) : undefined}

            {showTotpModal ? (
                <Modal
                    isOpen={showTotpModal}
                    onClose={() => {
                        setShowTotpModal(false);
                        setTotpEnrollment(undefined);
                        setTotpCode("");
                        createTotp.reset();
                        confirmTotp.reset();
                    }}
                    size="sm"
                    title="Add authenticator app"
                >
                    {totpEnrollment ? (
                        <div className="space-y-4">
                            <div className="mx-auto w-fit rounded-lg bg-white p-3">
                                <QRCodeSVG
                                    level="M"
                                    size={192}
                                    value={totpEnrollment.otpauthUri}
                                />
                            </div>
                            <div>
                                <p className="text-xs text-primary-400">
                                    Manual setup key
                                </p>
                                <code className="mt-1 block rounded bg-primary-900 p-2 text-xs break-all text-primary-100">
                                    {totpEnrollment.secret}
                                </code>
                            </div>
                            <Input
                                autoComplete="one-time-code"
                                inputMode="numeric"
                                label="Confirm 6-digit code"
                                onChange={(event_) => setTotpCode(event_.target.value)}
                                value={totpCode}
                            />
                            <Button
                                className="w-full"
                                disabled={isBusy || !/^\d{6}$/u.test(totpCode)}
                                onClick={() => void completeTotpSetup()}
                            >
                                Confirm authenticator
                            </Button>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            <Input
                                label="App name"
                                maxLength={64}
                                onChange={(event_) => setTotpLabel(event_.target.value)}
                                value={totpLabel}
                            />
                            <Button
                                className="w-full"
                                disabled={isBusy || !totpLabel.trim()}
                                onClick={() => void startTotpSetup()}
                            >
                                Create setup code
                            </Button>
                        </div>
                    )}
                </Modal>
            ) : undefined}

            {recoveryCodes ? (
                <Modal
                    isOpen={Boolean(recoveryCodes)}
                    onClose={() => setRecoveryCodes(undefined)}
                    size="md"
                    title="Save recovery codes now"
                >
                    <Alert variant="warning">
                        These full codes are shown once. Store them offline; do not put
                        them in Dashboard notes or screenshots.
                    </Alert>
                    <div className="my-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {recoveryCodes?.map((code) => (
                            <code
                                className="rounded bg-primary-900 p-2 text-center text-xs text-primary-100"
                                key={code}
                            >
                                {code}
                            </code>
                        ))}
                    </div>
                    <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                        <Button
                            onClick={() => void copyRecoveryCodes()}
                            variant="secondary"
                        >
                            <Copy className="size-4" />
                            Copy
                        </Button>
                        <Button
                            onClick={() => downloadRecoveryCodes(recoveryCodes ?? [])}
                        >
                            <Download className="size-4" />
                            Download
                        </Button>
                    </div>
                </Modal>
            ) : undefined}

            {showDisableModal ? (
                <Modal
                    isOpen={showDisableModal}
                    onClose={() => {
                        setPassword("");
                        setShowDisableModal(false);
                    }}
                    size="sm"
                    title="Disable two-step login"
                >
                    <form
                        className="space-y-4"
                        onSubmit={(event_) => {
                            event_.preventDefault();
                            setError(undefined);
                            void disableMfa
                                .mutateAsync(password)
                                .then(() => {
                                    setPassword("");
                                    setShowDisableModal(false);
                                    setSuccess("Two-step login disabled");
                                })
                                .catch((error_) =>
                                    setError(message(error_, "Could not disable MFA"))
                                );
                        }}
                    >
                        <Alert variant="warning">
                            This removes every key, TOTP seed, and recovery code.
                        </Alert>
                        <Input
                            autoComplete="current-password"
                            label="Current password"
                            onChange={(event_) => setPassword(event_.target.value)}
                            type="password"
                            value={password}
                        />
                        <Button
                            className="w-full"
                            disabled={isBusy || !password}
                            type="submit"
                            variant="danger"
                        >
                            Disable and revoke sessions
                        </Button>
                    </form>
                </Modal>
            ) : undefined}
        </div>
    );
}
