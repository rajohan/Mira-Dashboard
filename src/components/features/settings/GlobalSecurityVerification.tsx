import { KeyRound, ShieldCheck, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";

import {
    useAccountSecurity,
    useRecoveryStepUp,
    useTotpStepUp,
    useWebAuthnStepUp,
} from "../../../hooks";
import { router } from "../../../router";
import { useAuthStore } from "../../../stores/authStore";
import { Alert } from "../../ui/Alert";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";
import { Modal } from "../../ui/Modal";

type VerificationRequest = "enroll" | "step-up" | undefined;
type CodeMethod = "recovery" | "totp" | undefined;

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message.trim()
        ? error.message
        : "Verification failed";
}

/** Handles central enrollment and fresh-MFA requirements for privileged actions. */
export function GlobalSecurityVerification() {
    const { isAuthenticated } = useAuthStore();
    const { data } = useAccountSecurity(isAuthenticated);
    const totpStepUp = useTotpStepUp();
    const recoveryStepUp = useRecoveryStepUp();
    const webAuthnStepUp = useWebAuthnStepUp();
    const [request, setRequest] = useState<VerificationRequest>();
    const [codeMethod, setCodeMethod] = useState<CodeMethod>();
    const [code, setCode] = useState("");
    const [error, setError] = useState<string>();
    const [isComplete, setIsComplete] = useState(false);

    useEffect(() => {
        function onVerificationRequired(event: Event): void {
            const code = (
                event as CustomEvent<{
                    code?: string;
                }>
            ).detail?.code;
            setRequest(code === "mfa_enrollment_required" ? "enroll" : "step-up");
            setCodeMethod(undefined);
            setCode("");
            setError(undefined);
            setIsComplete(false);
        }

        addEventListener("mira:security-verification-required", onVerificationRequired);
        return () => {
            removeEventListener(
                "mira:security-verification-required",
                onVerificationRequired
            );
        };
    }, []);

    function close(): void {
        setRequest(undefined);
        setCodeMethod(undefined);
        setCode("");
        setError(undefined);
        setIsComplete(false);
    }

    async function verifyCode(): Promise<void> {
        if (!codeMethod || !code.trim()) return;
        setError(undefined);
        try {
            if (codeMethod === "totp") {
                await totpStepUp.mutateAsync(code.trim());
            } else {
                await recoveryStepUp.mutateAsync(code.trim());
            }
            setCode("");
            setIsComplete(true);
        } catch (error_) {
            setError(errorMessage(error_));
        }
    }

    async function verifySecurityKey(): Promise<void> {
        setError(undefined);
        try {
            await webAuthnStepUp.mutateAsync();
            setIsComplete(true);
        } catch (error_) {
            setError(errorMessage(error_));
        }
    }

    const methods = data?.factors.methods ?? [];
    const isPending =
        totpStepUp.isPending || recoveryStepUp.isPending || webAuthnStepUp.isPending;

    return (
        <Modal
            isOpen={Boolean(request)}
            onClose={close}
            size="sm"
            title={
                request === "enroll"
                    ? "Protect privileged actions"
                    : "Verify this privileged action"
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
                            close();
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
            ) : isComplete ? (
                <div className="space-y-4">
                    <Alert variant="success">
                        Verification complete. Retry the privileged action.
                    </Alert>
                    <Button className="w-full" onClick={close}>
                        Done
                    </Button>
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
