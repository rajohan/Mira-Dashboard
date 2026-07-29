import { startAuthentication } from "@simplewebauthn/browser";
import { useForm } from "@tanstack/react-form";
import { useNavigate } from "@tanstack/react-router";
import { KeyRound, ShieldCheck, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";

import type { DashboardMfaMethod } from "../../../contracts/accountSecurity";
import {
    type AuthBootstrapResponse,
    type FirstUserRegistrationRequest,
    type LoginCredentialsRequest,
    type LoginMfaCodeRequest,
    type LoginWebAuthnRequest,
    parseAuthBootstrapResponse,
    parseAuthLoginResponse,
    parseWebAuthnOptionsResponse,
} from "../../../contracts/auth";
import type { ContractParser } from "../../../contracts/runtime";
import { Alert } from "../components/ui/Alert";
import { Button } from "../components/ui/Button";
import { Card, CardTitle } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { apiErrorFromResponse } from "../lib/apiError";
import { messageFromError } from "../lib/errorMessage";
import { authActions, authStore } from "../stores/authStore";

type LoginStep = "credentials" | "method" | "recovery" | "totp";

/**
 * Returns the login flow description for the current step.
 * @param isBootstrapRequired Whether the first account must be created.
 * @param loginStep Current authentication step.
 * @returns Login flow description.
 */
function loginDescription(isBootstrapRequired: boolean, loginStep: LoginStep): string {
    if (isBootstrapRequired) {
        return "Create the first dashboard user and save the gateway token server-side";
    }
    if (loginStep === "credentials") {
        return "Log in with your dashboard username and password";
    }
    return "Complete two-step verification";
}

/**
 * Returns the credential form submission label.
 * @param isSubmitting Whether the request is pending.
 * @param isBootstrapRequired Whether the first account must be created.
 * @returns Submission button label.
 */
function loginSubmitLabel(isSubmitting: boolean, isBootstrapRequired: boolean): string {
    if (isSubmitting) {
        return isBootstrapRequired ? "Creating account..." : "Logging in...";
    }
    return isBootstrapRequired ? "Create first user" : "Continue";
}

/**
 * Returns the login flow footer text.
 * @param isBootstrapRequired Whether the first account must be created.
 * @param loginStep Current authentication step.
 * @returns Login footer text.
 */
function loginFooter(isBootstrapRequired: boolean, loginStep: LoginStep): string {
    if (isBootstrapRequired) {
        return "The gateway token is only required once during first-user setup.";
    }
    if (loginStep === "credentials") {
        return "Forgotten passwords are reset from the host-local recovery CLI.";
    }
    return "Full sessions are issued only after this verification succeeds.";
}

async function responsePayload<T>(
    response: Response,
    parser: ContractParser<T>
): Promise<T> {
    if (!response.ok) {
        throw await apiErrorFromResponse(response, "Authentication failed");
    }
    let payload: unknown;
    try {
        payload = await response.json();
    } catch {
        throw new Error("Authentication failed");
    }
    return parser(payload);
}

/**
 * Renders password-first login followed by a configured second factor.
 * @returns Rendered password-first login followed by a configured second factor.
 */
export function Login() {
    const navigate = useNavigate();
    const [bootstrapState, setBootstrapState] = useState<
        AuthBootstrapResponse | undefined
    >();
    const [error, setError] = useState<string | undefined>();
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [loginStep, setLoginStep] = useState<LoginStep>("credentials");
    const [methods, setMethods] = useState<DashboardMfaMethod[]>([]);
    const [secondFactorCode, setSecondFactorCode] = useState("");

    useEffect(() => {
        void (async () => {
            try {
                const response = await fetch("/api/auth/bootstrap", {
                    credentials: "include",
                });
                if (!response.ok) {
                    throw new Error("Failed to load auth state");
                }
                setBootstrapState(parseAuthBootstrapResponse(await response.json()));
            } catch (error_) {
                setError(messageFromError(error_, "Failed to load auth state"));
            }
        })();
    }, []);

    async function finishAuthentication(): Promise<void> {
        await authActions.refreshSession();
        const session = authStore.state;
        await navigate({
            to: session.isAuthenticated && !session.mfaEnabled ? "/settings" : "/",
            ...(session.isAuthenticated &&
                !session.mfaEnabled && {
                    search: { view: "dashboard" as const },
                }),
        });
    }

    async function submitSecondFactor(method: "recovery" | "totp"): Promise<void> {
        setError(undefined);
        setIsSubmitting(true);
        try {
            const response = await fetch(`/api/auth/login/${method}`, {
                body: JSON.stringify({
                    code: secondFactorCode,
                } satisfies LoginMfaCodeRequest),
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                method: "POST",
            });
            await responsePayload(response, parseAuthLoginResponse);
            setSecondFactorCode("");
            await finishAuthentication();
        } catch (error_) {
            setError(messageFromError(error_, "Authentication failed"));
        } finally {
            setIsSubmitting(false);
        }
    }

    async function authenticateWithSecurityKey(): Promise<void> {
        setError(undefined);
        setIsSubmitting(true);
        try {
            if (
                globalThis.PublicKeyCredential === undefined ||
                navigator.credentials === undefined
            ) {
                throw new Error("This browser does not support security keys");
            }
            const optionsResponse = await fetch("/api/auth/login/webauthn/options", {
                credentials: "include",
                method: "POST",
            });
            const { options } = await responsePayload(
                optionsResponse,
                parseWebAuthnOptionsResponse
            );
            const assertion = await startAuthentication({
                optionsJSON: options,
            });
            const verifyResponse = await fetch("/api/auth/login/webauthn/verify", {
                body: JSON.stringify({
                    response: assertion,
                } satisfies LoginWebAuthnRequest),
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                method: "POST",
            });
            await responsePayload(verifyResponse, parseAuthLoginResponse);
            await finishAuthentication();
        } catch (error_) {
            setError(
                error_ instanceof Error
                    ? error_.message
                    : "Security-key authentication failed"
            );
        } finally {
            setIsSubmitting(false);
        }
    }

    const form = useForm({
        defaultValues: { gatewayToken: "", password: "", username: "" },
        onSubmit: async ({ value }) => {
            const isBootstrapRequired = bootstrapState?.isBootstrapRequired ?? false;
            setError(undefined);
            setIsSubmitting(true);

            try {
                const endpoint = isBootstrapRequired
                    ? "/api/auth/register-first-user"
                    : "/api/auth/login";
                const requestBody:
                    | FirstUserRegistrationRequest
                    | LoginCredentialsRequest = isBootstrapRequired
                    ? {
                          gatewayToken: value.gatewayToken.trim(),
                          password: value.password,
                          username: value.username.trim(),
                      }
                    : {
                          password: value.password,
                          username: value.username.trim(),
                      };
                const response = await fetch(endpoint, {
                    body: JSON.stringify(requestBody),
                    credentials: "include",
                    headers: { "Content-Type": "application/json" },
                    method: "POST",
                });
                const result = await responsePayload(response, parseAuthLoginResponse);
                form.setFieldValue("password", "");

                if (result.mfaRequired) {
                    const configuredMethods = result.methods ?? [];
                    setMethods(configuredMethods);
                    setLoginStep("method");
                    return;
                }
                await finishAuthentication();
            } catch (error_) {
                setError(messageFromError(error_, "Authentication failed"));
                try {
                    const bootstrapResponse = await fetch("/api/auth/bootstrap", {
                        credentials: "include",
                    });
                    setBootstrapState(
                        parseAuthBootstrapResponse(await bootstrapResponse.json())
                    );
                } catch {
                    // Keep the primary authentication error visible.
                }
            } finally {
                setIsSubmitting(false);
            }
        },
    });

    const isBootstrapRequired = bootstrapState?.isBootstrapRequired ?? false;
    const description = loginDescription(isBootstrapRequired, loginStep);
    const submitLabel = loginSubmitLabel(isSubmitting, isBootstrapRequired);
    const footer = loginFooter(isBootstrapRequired, loginStep);

    return (
        <div className="flex min-h-screen items-center justify-center bg-primary-900 p-4">
            <Card className="w-full max-w-md" variant="bordered">
                <div className="mb-4 text-center">
                    <div className="mb-2 text-4xl">👩‍💻</div>
                    <CardTitle className="text-center">Mira Dashboard</CardTitle>
                    <p className="mt-2 text-primary-400">{description}</p>
                </div>

                {error ? (
                    <Alert className="mb-3" variant="error">
                        {error}
                    </Alert>
                ) : undefined}

                {loginStep === "credentials" ? (
                    <form
                        className="space-y-4"
                        onSubmit={(event_) => {
                            event_.preventDefault();
                            void form.handleSubmit();
                        }}
                    >
                        <form.Field name="username">
                            {(field) => (
                                <Input
                                    autoComplete="username"
                                    label="Username"
                                    onChange={(event_) =>
                                        field.handleChange(event_.target.value)
                                    }
                                    placeholder="Enter your username"
                                    type="text"
                                    value={field.state.value}
                                />
                            )}
                        </form.Field>

                        <form.Field name="password">
                            {(field) => (
                                <Input
                                    autoComplete={
                                        isBootstrapRequired
                                            ? "new-password"
                                            : "current-password"
                                    }
                                    label="Password"
                                    onChange={(event_) =>
                                        field.handleChange(event_.target.value)
                                    }
                                    placeholder="Enter your password"
                                    type="password"
                                    value={field.state.value}
                                />
                            )}
                        </form.Field>

                        {isBootstrapRequired ? (
                            <form.Field name="gatewayToken">
                                {(field) => (
                                    <Input
                                        autoComplete="off"
                                        label="Gateway Token"
                                        onChange={(event_) =>
                                            field.handleChange(event_.target.value)
                                        }
                                        placeholder="Enter your OpenClaw gateway token"
                                        type="password"
                                        value={field.state.value}
                                    />
                                )}
                            </form.Field>
                        ) : undefined}

                        <Button className="w-full" disabled={isSubmitting} type="submit">
                            {submitLabel}
                        </Button>
                    </form>
                ) : undefined}

                {loginStep === "method" ? (
                    <div className="space-y-3">
                        {methods.includes("webauthn") ? (
                            <Button
                                className="w-full justify-start"
                                disabled={isSubmitting}
                                onClick={() => void authenticateWithSecurityKey()}
                            >
                                <KeyRound className="size-4" />
                                Security key (YubiKey)
                            </Button>
                        ) : undefined}
                        {methods.includes("totp") ? (
                            <Button
                                className="w-full justify-start"
                                disabled={isSubmitting}
                                onClick={() => {
                                    setError(undefined);
                                    setSecondFactorCode("");
                                    setLoginStep("totp");
                                }}
                                variant="secondary"
                            >
                                <Smartphone className="size-4" />
                                Authenticator app
                            </Button>
                        ) : undefined}
                        {methods.includes("recovery") ? (
                            <Button
                                className="w-full justify-start"
                                disabled={isSubmitting}
                                onClick={() => {
                                    setError(undefined);
                                    setSecondFactorCode("");
                                    setLoginStep("recovery");
                                }}
                                variant="ghost"
                            >
                                <ShieldCheck className="size-4" />
                                Recovery code
                            </Button>
                        ) : undefined}
                        <Button
                            className="w-full"
                            disabled={isSubmitting}
                            onClick={() => {
                                setError(undefined);
                                setMethods([]);
                                setLoginStep("credentials");
                            }}
                            variant="ghost"
                        >
                            Back to password
                        </Button>
                    </div>
                ) : undefined}

                {loginStep === "totp" || loginStep === "recovery" ? (
                    <form
                        className="space-y-4"
                        onSubmit={(event_) => {
                            event_.preventDefault();
                            void submitSecondFactor(loginStep);
                        }}
                    >
                        <Input
                            autoComplete={loginStep === "totp" ? "one-time-code" : "off"}
                            inputMode={loginStep === "totp" ? "numeric" : "text"}
                            label={
                                loginStep === "totp" ? "6-digit code" : "Recovery code"
                            }
                            onChange={(event_) =>
                                setSecondFactorCode(event_.target.value)
                            }
                            placeholder={
                                loginStep === "totp"
                                    ? "123456"
                                    : "xxxxxxxx-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                            }
                            value={secondFactorCode}
                        />
                        <Button
                            className="w-full"
                            disabled={
                                isSubmitting || secondFactorCode.trim().length === 0
                            }
                            type="submit"
                        >
                            {isSubmitting ? "Verifying..." : "Verify"}
                        </Button>
                        <Button
                            className="w-full"
                            disabled={isSubmitting}
                            onClick={() => {
                                setError(undefined);
                                setSecondFactorCode("");
                                setLoginStep("method");
                            }}
                            type="button"
                            variant="ghost"
                        >
                            Choose another method
                        </Button>
                    </form>
                ) : undefined}

                <p className="mt-4 text-center text-xs text-primary-500">{footer}</p>
            </Card>
        </div>
    );
}
