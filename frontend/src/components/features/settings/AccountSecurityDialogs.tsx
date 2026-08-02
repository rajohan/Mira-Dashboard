import { Copy, Download, KeyRound } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";

import { messageFromError } from "../../../lib/errorMessage";
import { Alert } from "../../ui/Alert";
import { Button } from "../../ui/Button";
import { ConfirmModal } from "../../ui/ConfirmModal";
import { Input } from "../../ui/Input";
import { Modal } from "../../ui/Modal";
import type { AccountSecurityController } from "./useAccountSecurityController";

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

export function AccountSecurityDialogs({
    controller,
}: {
    controller: AccountSecurityController;
}) {
    const {
        changePassword,
        completeTotpSetup,
        confirmPassword,
        confirmTotp,
        copyRecoveryCodes,
        createTotp,
        currentPassword,
        data,
        disableMfa,
        isBusy,
        keyLabel,
        newPassword,
        password,
        pendingFactorRemoval,
        recoveryCodes,
        registerKey,
        removeSecurityKey,
        removeSelectedFactor,
        removeTotp,
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
        totpCode,
        totpEnrollment,
        totpLabel,
        verificationCode,
        verificationMode,
        verifyMfa,
        verifyPassword,
    } = controller;

    if (!data) return null;

    const hasTotpMethod = data.factors.methods.includes("totp");
    const hasRecoveryMethod = data.factors.methods.includes("recovery");
    let verificationCodeLabel = "Recovery code";
    if (hasTotpMethod && hasRecoveryMethod) {
        verificationCodeLabel = "Authenticator or recovery code";
    } else if (hasTotpMethod) {
        verificationCodeLabel = "Authenticator code";
    }

    return (
        <>
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
                            void (async () => {
                                try {
                                    const result = await changePassword.mutateAsync({
                                        currentPassword,
                                        newPassword,
                                    });
                                    setCurrentPassword("");
                                    setNewPassword("");
                                    setConfirmPassword("");
                                    setShowPasswordModal(false);
                                    setSuccess(
                                        `Password changed; ${result.revokedSessions} other session${result.revokedSessions === 1 ? "" : "s"} revoked`
                                    );
                                } catch (error_) {
                                    setError(
                                        messageFromError(
                                            error_,
                                            "Could not change password"
                                        )
                                    );
                                }
                            })();
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
                    isOpen
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
                            {data.factors.methods.includes("totp") ||
                            data.factors.methods.includes("recovery") ? (
                                <form
                                    className="space-y-2"
                                    onSubmit={(event_) => {
                                        event_.preventDefault();
                                        void verifyMfa(
                                            data.factors.methods.includes("totp")
                                                ? "totp"
                                                : "recovery"
                                        );
                                    }}
                                >
                                    <Input
                                        autoComplete="one-time-code"
                                        inputMode={
                                            data.factors.methods.includes("recovery")
                                                ? "text"
                                                : "numeric"
                                        }
                                        label={verificationCodeLabel}
                                        onChange={(event_) =>
                                            setVerificationCode(event_.target.value)
                                        }
                                        value={verificationCode}
                                    />
                                    {data.factors.methods.includes("totp") ? (
                                        <Button
                                            className="w-full"
                                            disabled={isBusy || !verificationCode.trim()}
                                            type="submit"
                                            variant="secondary"
                                        >
                                            Verify TOTP
                                        </Button>
                                    ) : undefined}
                                    {data.factors.methods.includes("recovery") ? (
                                        <Button
                                            className="w-full"
                                            disabled={isBusy || !verificationCode.trim()}
                                            onClick={() => void verifyMfa("recovery")}
                                            type="button"
                                            variant="ghost"
                                        >
                                            Use recovery code
                                        </Button>
                                    ) : undefined}
                                </form>
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
                    <div className="my-4 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
                        {recoveryCodes?.map((code) => (
                            <code
                                className="min-w-0 rounded bg-primary-900 p-2 text-center text-xs break-all whitespace-normal text-primary-100"
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
                            void (async () => {
                                try {
                                    await disableMfa.mutateAsync(password);
                                    setPassword("");
                                    setShowDisableModal(false);
                                    setSuccess("Two-step login disabled");
                                } catch (error_) {
                                    setError(
                                        messageFromError(error_, "Could not disable MFA")
                                    );
                                }
                            })();
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
        </>
    );
}
