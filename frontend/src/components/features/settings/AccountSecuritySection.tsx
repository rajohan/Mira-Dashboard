import {
    KeyRound,
    Laptop,
    LogOut,
    Plus,
    RefreshCw,
    ShieldCheck,
    Smartphone,
    Trash2,
} from "lucide-react";
import type { ReactNode } from "react";

import { messageFromError } from "../../../lib/errorMessage";
import { formatDate } from "../../../utils/format";
import { Alert } from "../../ui/Alert";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Card, CardTitle } from "../../ui/Card";
import { LoadingState } from "../../ui/LoadingState";
import { AccountSecurityDialogs } from "./AccountSecurityDialogs";
import { useAccountSecurityController } from "./useAccountSecurityController";

/**
 * Renders Dashboard-owned account security, factors, recovery, and sessions.
 * @returns Rendered Dashboard-owned account security, factors, recovery, and sessions.
 */
export function AccountSecuritySection() {
    const controller = useAccountSecurityController();
    const {
        data,
        error,
        isBusy,
        isLoading,
        isMfaEnabled,
        requiresManagementVerification,
        revokeAll,
        revokeOthers,
        revokeSession,
        rotateCodes,
        setConfirmPassword,
        setCurrentPassword,
        setError,
        setKeyLabel,
        setNewPassword,
        setPassword,
        setPendingFactorRemoval,
        setShowDisableModal,
        setShowKeyModal,
        setShowPasswordModal,
        setShowTotpModal,
        setSuccess,
        setTotpEnrollment,
        setTotpLabel,
        setVerificationMode,
        success,
    } = controller;

    if (isLoading || !data) {
        return <LoadingState size="lg" />;
    }

    let verificationButton: ReactNode;
    if (isMfaEnabled) {
        verificationButton = (
            <Button
                disabled={isBusy}
                onClick={() => setVerificationMode("mfa")}
                variant="secondary"
            >
                Verify now
            </Button>
        );
    } else if (!data.recentVerification.password) {
        verificationButton = (
            <Button
                disabled={isBusy}
                onClick={() => setVerificationMode("password")}
                variant="secondary"
            >
                Verify password
            </Button>
        );
    }

    return (
        <div className="space-y-4">
            {error ? (
                <Alert
                    dismissLabel="Dismiss security error"
                    onDismiss={() => setError(undefined)}
                    variant="error"
                >
                    {error}
                </Alert>
            ) : undefined}
            {success ? (
                <Alert
                    dismissLabel="Dismiss security success"
                    onDismiss={() => setSuccess(undefined)}
                    variant="success"
                >
                    {success}
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
                    {verificationButton}
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
                            className="shrink-0 whitespace-nowrap"
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
                            className="shrink-0 whitespace-nowrap"
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
                                            messageFromError(
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
                                            messageFromError(
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
                                                messageFromError(
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

            <AccountSecurityDialogs controller={controller} />
        </div>
    );
}
