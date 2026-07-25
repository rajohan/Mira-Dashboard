import { KeyRound, ShieldCheck, Smartphone } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
    useAccountSecurity,
    usePasswordReauthentication,
    useRecoveryStepUp,
    useTotpStepUp,
    useWebAuthnStepUp,
} from "../../../hooks";
import {
    cancelSecurityVerification,
    completeSecurityVerification,
    dispatchSecurityVerificationRequired,
    SECURITY_VERIFICATION_CANCELLED_EVENT_NAME,
    SECURITY_VERIFICATION_FLOW_TIMEOUT_MS,
    SECURITY_VERIFICATION_REQUIRED_EVENT_NAME,
} from "../../../lib/securityVerification";
import { router } from "../../../router";
import { useAuthStore } from "../../../stores/authStore";
import { Alert } from "../../ui/Alert";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";
import { Modal } from "../../ui/Modal";

type VerificationRequest = "enroll" | "password" | "step-up" | undefined;
type CodeMethod = "recovery" | "totp" | undefined;

function requestForVerificationCode(
    code: string | undefined,
    isMfaEnabled: boolean
): VerificationRequest {
    if (code === "mfa_enrollment_required") {
        return "enroll";
    }
    if (code === "recent_verification_required") {
        return isMfaEnabled ? "step-up" : "password";
    }
    return code === "step_up_required" ? "step-up" : undefined;
}

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message.trim()
        ? error.message
        : "Verification failed";
}

/** Handles central enrollment and fresh-MFA requirements for privileged actions. */
export function GlobalSecurityVerification() {
    const { isAuthenticated, mfaEnabled, sessionId } = useAuthStore();
    const { data } = useAccountSecurity(isAuthenticated);
    const passwordReauth = usePasswordReauthentication();
    const totpStepUp = useTotpStepUp();
    const recoveryStepUp = useRecoveryStepUp();
    const webAuthnStepUp = useWebAuthnStepUp();
    const [request, setRequest] = useState<VerificationRequest>();
    const [codeMethod, setCodeMethod] = useState<CodeMethod>();
    const [code, setCode] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string>();
    const requestReference = useRef<VerificationRequest>(request);
    const verificationGenerationReference = useRef(0);
    const verificationTimeoutReference = useRef<
        ReturnType<typeof setTimeout> | undefined
    >(undefined);
    requestReference.current = request;

    const clearVerificationTimeout = useCallback((): void => {
        if (verificationTimeoutReference.current === undefined) {
            return;
        }
        clearTimeout(verificationTimeoutReference.current);
        verificationTimeoutReference.current = undefined;
    }, []);

    const startVerificationTimeout = useCallback(
        (verificationGeneration: number): void => {
            clearVerificationTimeout();
            verificationTimeoutReference.current = setTimeout(() => {
                verificationTimeoutReference.current = undefined;
                if (
                    verificationGenerationReference.current === verificationGeneration &&
                    requestReference.current
                ) {
                    cancelSecurityVerification();
                }
            }, SECURITY_VERIFICATION_FLOW_TIMEOUT_MS);
        },
        [clearVerificationTimeout]
    );

    const reset = useCallback((): void => {
        clearVerificationTimeout();
        verificationGenerationReference.current += 1;
        requestReference.current = undefined;
        setRequest(undefined);
        setCodeMethod(undefined);
        setCode("");
        setPassword("");
        setError(undefined);
    }, [clearVerificationTimeout]);

    useEffect(() => {
        function onVerificationRequired(event: Event): void {
            if (!isAuthenticated) {
                return;
            }
            const code = (
                event as CustomEvent<{
                    code?: string;
                }>
            ).detail?.code;
            const nextRequest = requestForVerificationCode(code, mfaEnabled);
            if (
                !nextRequest ||
                (requestReference.current && requestReference.current !== nextRequest)
            ) {
                return;
            }
            event.preventDefault();
            if (requestReference.current) {
                return;
            }
            verificationGenerationReference.current += 1;
            requestReference.current = nextRequest;
            startVerificationTimeout(verificationGenerationReference.current);
            setRequest(nextRequest);
            setCodeMethod(undefined);
            setCode("");
            setPassword("");
            setError(undefined);
        }

        addEventListener(
            SECURITY_VERIFICATION_REQUIRED_EVENT_NAME,
            onVerificationRequired
        );
        addEventListener(SECURITY_VERIFICATION_CANCELLED_EVENT_NAME, reset);
        return () => {
            removeEventListener(
                SECURITY_VERIFICATION_REQUIRED_EVENT_NAME,
                onVerificationRequired
            );
            removeEventListener(SECURITY_VERIFICATION_CANCELLED_EVENT_NAME, reset);
        };
    }, [isAuthenticated, mfaEnabled, reset, startVerificationTimeout]);

    useEffect(() => {
        if (!isAuthenticated && requestReference.current) {
            cancelSecurityVerification();
        }
    }, [isAuthenticated]);

    useEffect(() => clearVerificationTimeout, [clearVerificationTimeout]);

    useEffect(() => {
        if (!isAuthenticated || !data) {
            return;
        }
        const summarySessionId = data.sessions.find(
            (session) => session.isCurrent
        )?.sessionId;
        if ((sessionId && summarySessionId !== sessionId) || !data.factors.enabledAt) {
            return;
        }
        const requireStepUp = () => {
            if (requestReference.current) {
                return;
            }
            dispatchSecurityVerificationRequired("step_up_required");
        };
        if (!data.recentVerification.mfa) {
            requireStepUp();
            return;
        }
        const expiresAt = Date.parse(data.recentVerification.mfaUntil ?? "");
        if (!Number.isFinite(expiresAt)) {
            return;
        }
        const remainingMs = expiresAt - Date.now();
        if (remainingMs <= 0) {
            requireStepUp();
            return;
        }
        const timeout = setTimeout(requireStepUp, remainingMs + 1);
        return () => clearTimeout(timeout);
    }, [data, isAuthenticated, sessionId]);

    async function runVerification(action: () => Promise<unknown>): Promise<void> {
        const verificationGeneration = verificationGenerationReference.current;
        setError(undefined);
        try {
            await action();
            if (
                verificationGenerationReference.current !== verificationGeneration ||
                !requestReference.current
            ) {
                return;
            }
            completeSecurityVerification();
            reset();
        } catch (error_) {
            if (verificationGenerationReference.current !== verificationGeneration) {
                return;
            }
            setError(errorMessage(error_));
        }
    }

    async function verifyPassword(): Promise<void> {
        if (!password) return;
        await runVerification(() => passwordReauth.mutateAsync(password));
    }

    async function verifyCode(): Promise<void> {
        if (!codeMethod || !code.trim()) return;
        await runVerification(async () => {
            if (codeMethod === "totp") {
                await totpStepUp.mutateAsync(code.trim());
            } else {
                await recoveryStepUp.mutateAsync(code.trim());
            }
        });
    }

    async function verifySecurityKey(): Promise<void> {
        await runVerification(() => webAuthnStepUp.mutateAsync());
    }

    const methods = data?.factors.methods ?? [];
    const isPending =
        passwordReauth.isPending ||
        totpStepUp.isPending ||
        recoveryStepUp.isPending ||
        webAuthnStepUp.isPending;

    return (
        <Modal
            isOpen={Boolean(request)}
            isDismissDisabled={isPending}
            onClose={cancelSecurityVerification}
            size="sm"
            title={
                request === "enroll"
                    ? "Protect privileged actions"
                    : request === "password"
                      ? "Verify current password"
                      : "Verify your session"
            }
        >
            {request === "enroll" ? (
                <div className="space-y-4">
                    <p className="text-sm text-primary-300">
                        Register a security key or authenticator app before changing
                        sensitive configuration or running privileged operations.
                    </p>
                    <Button
                        className="w-full"
                        onClick={() => {
                            cancelSecurityVerification();
                            void router.navigate({
                                search: { view: "dashboard" },
                                to: "/settings",
                            });
                        }}
                    >
                        <ShieldCheck className="size-4" />
                        Open Dashboard security settings
                    </Button>
                </div>
            ) : request === "password" ? (
                <div className="space-y-3">
                    <p className="text-sm text-primary-300">
                        Confirm your current Dashboard password. The verification remains
                        valid for a short period.
                    </p>

                    {error ? <Alert variant="error">{error}</Alert> : undefined}

                    <form
                        className="space-y-3"
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
                            disabled={isPending || !password}
                            type="submit"
                        >
                            Verify
                        </Button>
                    </form>
                </div>
            ) : (
                <div className="space-y-3">
                    <p className="text-sm text-primary-300">
                        Confirm with a recently registered second factor. The verification
                        remains valid for a short period.
                    </p>

                    {error ? <Alert variant="error">{error}</Alert> : undefined}

                    {!codeMethod && methods.includes("webauthn") ? (
                        <Button
                            className="w-full"
                            disabled={isPending}
                            onClick={() => void verifySecurityKey()}
                        >
                            <KeyRound className="size-4" />
                            Use security key
                        </Button>
                    ) : undefined}
                    {!codeMethod && methods.includes("totp") ? (
                        <Button
                            className="w-full"
                            disabled={isPending}
                            onClick={() => setCodeMethod("totp")}
                            variant="secondary"
                        >
                            <Smartphone className="size-4" />
                            Use authenticator app
                        </Button>
                    ) : undefined}
                    {!codeMethod && methods.includes("recovery") ? (
                        <Button
                            className="w-full"
                            disabled={isPending}
                            onClick={() => setCodeMethod("recovery")}
                            variant="ghost"
                        >
                            Use recovery code
                        </Button>
                    ) : undefined}

                    {codeMethod ? (
                        <form
                            className="space-y-3"
                            onSubmit={(event_) => {
                                event_.preventDefault();
                                void verifyCode();
                            }}
                        >
                            <Input
                                autoComplete="one-time-code"
                                inputMode={codeMethod === "totp" ? "numeric" : "text"}
                                label={
                                    codeMethod === "totp"
                                        ? "6-digit code"
                                        : "Recovery code"
                                }
                                onChange={(event_) => setCode(event_.target.value)}
                                value={code}
                            />
                            <Button
                                className="w-full"
                                disabled={isPending || !code.trim()}
                                type="submit"
                            >
                                Verify
                            </Button>
                            <Button
                                className="w-full"
                                disabled={isPending}
                                onClick={() => {
                                    setCodeMethod(undefined);
                                    setCode("");
                                    setError(undefined);
                                }}
                                type="button"
                                variant="ghost"
                            >
                                Choose another method
                            </Button>
                        </form>
                    ) : undefined}
                </div>
            )}
        </Modal>
    );
}
