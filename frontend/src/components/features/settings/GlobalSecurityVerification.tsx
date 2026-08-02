import { KeyRound, ShieldCheck, Smartphone } from "lucide-react";
import { useEffect, useEffectEvent, useRef, type ReactNode, useState } from "react";

import {
    useAccountSecurity,
    usePasswordReauthentication,
    useRecoveryStepUp,
    useTotpStepUp,
    useWebAuthnStepUp,
} from "../../../hooks/useAccountSecurity";
import { AUTH_SESSION_ROTATED_EVENT_NAME } from "../../../lib/authBoundary";
import { messageFromError } from "../../../lib/errorMessage";
import { subscribeToGlobalEvent } from "../../../lib/globalEvents";
import {
    cancelSecurityVerification,
    completeSecurityVerification,
    dispatchSecurityVerificationRequired,
    refreshSecurityVerificationDeadline,
    SECURITY_VERIFICATION_CANCELLED_EVENT_NAME,
    SECURITY_VERIFICATION_FLOW_TIMEOUT_MS,
    SECURITY_VERIFICATION_REQUIRED_EVENT_NAME,
} from "../../../lib/securityVerification";
import { router } from "../../../router";
import { authActions, authStore, useAuthStore } from "../../../stores/authStore";
import { Alert } from "../../ui/Alert";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";
import { Modal } from "../../ui/Modal";

type VerificationRequest = "enroll" | "password" | "step-up" | undefined;
type CodeMethod = "recovery" | "totp" | undefined;

interface AuthIdentity {
    sessionId: string;
    userId: number;
}

interface VerificationBinding extends AuthIdentity {
    canAdoptRotatedSession: boolean;
}

function currentAuthIdentity(): AuthIdentity | undefined {
    const { isAuthenticated, sessionId, user } = authStore.state;
    return isAuthenticated && sessionId && user
        ? { sessionId, userId: user.id }
        : undefined;
}

function reconcileVerificationBinding(
    binding: VerificationBinding,
    identity: AuthIdentity
): VerificationBinding | undefined {
    if (binding.userId !== identity.userId) {
        return undefined;
    }
    if (binding.sessionId === identity.sessionId) {
        return binding;
    }
    if (!binding.canAdoptRotatedSession) {
        return undefined;
    }
    binding.sessionId = identity.sessionId;
    binding.canAdoptRotatedSession = false;
    return binding;
}

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

/**
 * Handles central enrollment and fresh-MFA requirements for privileged actions.
 * @returns Global security verification result.
 */
export function GlobalSecurityVerification() {
    const { isAuthenticated, mfaEnabled, sessionId, user } = useAuthStore();
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
    const requestRef = useRef<VerificationRequest>(request);
    const verificationBindingRef = useRef<VerificationBinding | undefined>(undefined);
    const verificationGenerationRef = useRef(0);
    const verificationTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
        undefined
    );

    const clearVerificationTimeout = (): void => {
        if (verificationTimeoutRef.current === undefined) {
            return;
        }
        clearTimeout(verificationTimeoutRef.current);
        verificationTimeoutRef.current = undefined;
    };

    const startVerificationTimeout = (verificationGeneration: number): void => {
        clearVerificationTimeout();
        verificationTimeoutRef.current = setTimeout(() => {
            verificationTimeoutRef.current = undefined;
            if (
                verificationGenerationRef.current === verificationGeneration &&
                requestRef.current
            ) {
                cancelSecurityVerification();
            }
        }, SECURITY_VERIFICATION_FLOW_TIMEOUT_MS);
    };

    const reset = (): void => {
        clearVerificationTimeout();
        verificationGenerationRef.current += 1;
        requestRef.current = undefined;
        verificationBindingRef.current = undefined;
        setRequest(undefined);
        setCodeMethod(undefined);
        setCode("");
        setPassword("");
        setError(undefined);
    };

    const onVerificationRequired = useEffectEvent((event: Event): void => {
        if (!isAuthenticated) {
            return;
        }
        const code = (
            event as CustomEvent<{
                code?: string;
            }>
        ).detail?.code;
        const nextRequest = requestForVerificationCode(code, mfaEnabled);
        const identity = currentAuthIdentity();
        if (!nextRequest || !identity) {
            return;
        }
        const activeRequest = requestRef.current;
        if (activeRequest) {
            const binding = verificationBindingRef.current;
            if (
                activeRequest !== nextRequest ||
                !binding ||
                !reconcileVerificationBinding(binding, identity)
            ) {
                return;
            }
            event.preventDefault();
            return;
        }
        event.preventDefault();
        verificationGenerationRef.current += 1;
        requestRef.current = nextRequest;
        verificationBindingRef.current = {
            ...identity,
            canAdoptRotatedSession: false,
        };
        startVerificationTimeout(verificationGenerationRef.current);
        setRequest(nextRequest);
        setCodeMethod(undefined);
        setCode("");
        setPassword("");
        setError(undefined);
    });
    const resetFromEffect = useEffectEvent(reset);

    useEffect(() => {
        const unsubscribeRequired = subscribeToGlobalEvent(
            SECURITY_VERIFICATION_REQUIRED_EVENT_NAME,
            onVerificationRequired
        );
        const unsubscribeCancelled = subscribeToGlobalEvent(
            SECURITY_VERIFICATION_CANCELLED_EVENT_NAME,
            () => resetFromEffect()
        );
        return () => {
            unsubscribeRequired();
            unsubscribeCancelled();
        };
    }, []);

    useEffect(() => {
        function onSessionRotated(): void {
            const binding = verificationBindingRef.current;
            const identity = currentAuthIdentity();
            if (binding && requestRef.current && identity?.userId === binding.userId) {
                binding.canAdoptRotatedSession = true;
            }
        }

        return subscribeToGlobalEvent(AUTH_SESSION_ROTATED_EVENT_NAME, onSessionRotated);
    }, []);

    useEffect(() => {
        if (!requestRef.current) {
            return;
        }
        const binding = verificationBindingRef.current;
        const identity = currentAuthIdentity();
        if (!binding || !identity || !reconcileVerificationBinding(binding, identity)) {
            cancelSecurityVerification();
        }
    }, [isAuthenticated, sessionId, user?.id]);

    useEffect(
        () => () => {
            const timeout = verificationTimeoutRef.current;
            if (timeout !== undefined) {
                clearTimeout(timeout);
            }
        },
        []
    );

    useEffect(() => {
        if (!isAuthenticated || !data) {
            return;
        }
        const summarySessionId = data.sessions.find(
            (session) => session.isCurrent
        )?.sessionId;
        if (!sessionId || summarySessionId !== sessionId || !data.factors.enabledAt) {
            return;
        }
        const requireStepUp = () => {
            if (requestRef.current) {
                return;
            }
            dispatchSecurityVerificationRequired("step_up_required");
        };
        if (!data.recentVerification.mfa) {
            requireStepUp();
            return;
        }
        const mfaUntil = Date.parse(data.recentVerification.mfaUntil ?? "");
        const remainingMs = data.recentVerification.mfaRemainingMs;
        if (
            typeof remainingMs !== "number" ||
            !Number.isFinite(mfaUntil) ||
            !Number.isFinite(remainingMs)
        ) {
            requireStepUp();
            return;
        }
        if (remainingMs <= 0) {
            requireStepUp();
            return;
        }
        const binding = verificationBindingRef.current;
        const identity = currentAuthIdentity();
        if (
            binding &&
            identity &&
            requestRef.current === "step-up" &&
            reconcileVerificationBinding(binding, identity)
        ) {
            completeSecurityVerification();
            resetFromEffect();
            return;
        }
        const timeout = setTimeout(requireStepUp, remainingMs + 1);
        return () => clearTimeout(timeout);
    }, [data, isAuthenticated, sessionId]);

    async function runVerification(action: () => Promise<unknown>): Promise<void> {
        const verificationGeneration = verificationGenerationRef.current;
        const binding = verificationBindingRef.current;
        const identity = currentAuthIdentity();
        if (!binding || !identity || !reconcileVerificationBinding(binding, identity)) {
            cancelSecurityVerification();
            return;
        }
        startVerificationTimeout(verificationGeneration);
        refreshSecurityVerificationDeadline();
        setError(undefined);
        try {
            await action();
            if (
                verificationGenerationRef.current !== verificationGeneration ||
                !requestRef.current ||
                verificationBindingRef.current !== binding
            ) {
                return;
            }
            await authActions.refreshSession();
            if (
                verificationGenerationRef.current !== verificationGeneration ||
                !requestRef.current ||
                verificationBindingRef.current !== binding
            ) {
                return;
            }
            const currentIdentity = currentAuthIdentity();
            if (
                !currentIdentity ||
                !reconcileVerificationBinding(binding, currentIdentity)
            ) {
                cancelSecurityVerification();
                return;
            }
            completeSecurityVerification();
            reset();
        } catch (error_) {
            if (verificationGenerationRef.current !== verificationGeneration) {
                return;
            }
            setError(messageFromError(error_, "Verification failed"));
        }
    }

    async function verifyPassword(): Promise<void> {
        if (!password) return;
        await runVerification(() => passwordReauth.mutateAsync(password));
    }

    async function verifyCode(): Promise<void> {
        if (!codeMethod || !code.trim()) return;
        await runVerification(async () => {
            const verify =
                codeMethod === "totp"
                    ? totpStepUp.mutateAsync
                    : recoveryStepUp.mutateAsync;
            await verify(code.trim());
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
    let modalTitle = "Verify your session";
    if (request === "enroll") {
        modalTitle = "Protect privileged actions";
    } else if (request === "password") {
        modalTitle = "Verify current password";
    }

    let modalContent: ReactNode;
    if (request === "enroll") {
        modalContent = (
            <div className="space-y-4">
                <p className="text-sm text-primary-300">
                    Register a security key or authenticator app before changing sensitive
                    configuration or running privileged operations.
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
        );
    } else if (request === "password") {
        modalContent = (
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
        );
    } else {
        modalContent = (
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
                                codeMethod === "totp" ? "6-digit code" : "Recovery code"
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
        );
    }

    return (
        <Modal
            isOpen={Boolean(request)}
            isDismissDisabled={isPending}
            onClose={cancelSecurityVerification}
            size="sm"
            title={modalTitle}
        >
            {modalContent}
        </Modal>
    );
}
