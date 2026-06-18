import { useForm } from "@tanstack/react-form";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { Alert } from "../components/ui/Alert";
import { Button } from "../components/ui/Button";
import { Card, CardTitle } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { authActions } from "../stores/authStore";

/** Represents the bootstrap API response. */
interface BootstrapResponse {
    bootstrapRequired: boolean;
    hasGatewayToken: boolean;
}

/** Renders the login UI. */
export function Login() {
    const navigate = useNavigate();
    const [bootstrapState, setBootstrapState] = useState<BootstrapResponse | undefined>(
        undefined
    );
    const [error, setError] = useState<string | undefined>(undefined);
    const [isSubmitting, setIsSubmitting] = useState(false);

    useEffect(() => {
        void (async () => {
            try {
                const response = await fetch("/api/auth/bootstrap", {
                    credentials: "include",
                });
                if (!response.ok) {
                    throw new Error("Failed to load auth state");
                }
                setBootstrapState((await response.json()) as BootstrapResponse);
            } catch (error_) {
                setError(
                    error_ instanceof Error ? error_.message : "Failed to load auth state"
                );
            }
        })();
    }, []);

    const form = useForm({
        defaultValues: { username: "", password: "", gatewayToken: "" },
        onSubmit: async ({ value }) => {
            const bootstrapRequired = bootstrapState?.bootstrapRequired ?? false;
            setError(undefined);
            setIsSubmitting(true);

            try {
                const endpoint = bootstrapRequired
                    ? "/api/auth/register-first-user"
                    : "/api/auth/login";
                const response = await fetch(endpoint, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    credentials: "include",
                    body: JSON.stringify({
                        username: value.username.trim(),
                        password: value.password,
                        ...(bootstrapRequired && {
                            gatewayToken: value.gatewayToken.trim(),
                        }),
                    }),
                });

                if (!response.ok) {
                    let payload: { error?: string };
                    try {
                        payload = (await response.json()) as { error?: string };
                    } catch {
                        payload = { error: "Authentication failed" };
                    }
                    throw new Error(payload.error || "Authentication failed");
                }

                await authActions.refreshSession();
                await navigate({ to: "/" });
            } catch (error_) {
                setError(
                    error_ instanceof Error ? error_.message : "Authentication failed"
                );
                try {
                    await authActions.refreshSession();
                } catch {
                    // Bootstrap reload below handles stale auth state.
                }
                try {
                    const bootstrapResponse = await fetch("/api/auth/bootstrap", {
                        credentials: "include",
                    });
                    const nextBootstrap =
                        (await bootstrapResponse.json()) as BootstrapResponse;
                    setBootstrapState(nextBootstrap);
                } catch {
                    // Keep the primary authentication error visible.
                }
            } finally {
                setIsSubmitting(false);
            }
        },
    });

    const bootstrapRequired = bootstrapState?.bootstrapRequired ?? false;

    return (
        <div className="bg-primary-900 flex min-h-screen items-center justify-center p-4">
            <Card className="w-full max-w-md" variant="bordered">
                <div className="mb-4 text-center">
                    <div className="mb-2 text-4xl">👩‍💻</div>
                    <CardTitle className="text-center">Mira Dashboard</CardTitle>
                    <p className="text-primary-400 mt-2">
                        {bootstrapRequired
                            ? "Create the first dashboard user and save the gateway token server-side"
                            : "Log in with your dashboard username and password"}
                    </p>
                </div>

                {error ? (
                    <Alert className="mb-2" variant="error">
                        {error}
                    </Alert>
                ) : undefined}

                <form
                    onSubmit={(event_) => {
                        event_.preventDefault();
                        void form.handleSubmit();
                    }}
                    className="space-y-4"
                >
                    <form.Field name="username">
                        {(field) => (
                            <Input
                                type="text"
                                label="Username"
                                value={field.state.value}
                                onChange={(event_) =>
                                    field.handleChange(event_.target.value)
                                }
                                placeholder="Enter your username"
                                autoComplete="username"
                            />
                        )}
                    </form.Field>

                    <form.Field name="password">
                        {(field) => (
                            <Input
                                type="password"
                                label="Password"
                                value={field.state.value}
                                onChange={(event_) =>
                                    field.handleChange(event_.target.value)
                                }
                                placeholder="Enter your password"
                                autoComplete={
                                    bootstrapRequired
                                        ? "new-password"
                                        : "current-password"
                                }
                            />
                        )}
                    </form.Field>

                    {bootstrapRequired ? (
                        <form.Field name="gatewayToken">
                            {(field) => (
                                <Input
                                    type="password"
                                    label="Gateway Token"
                                    value={field.state.value}
                                    onChange={(event_) =>
                                        field.handleChange(event_.target.value)
                                    }
                                    placeholder="Enter your OpenClaw gateway token"
                                    autoComplete="off"
                                />
                            )}
                        </form.Field>
                    ) : undefined}

                    <Button type="submit" className="w-full" disabled={isSubmitting}>
                        {isSubmitting
                            ? bootstrapRequired
                                ? "Creating account..."
                                : "Logging in..."
                            : bootstrapRequired
                              ? "Create first user"
                              : "Log in"}
                    </Button>
                </form>

                <p className="text-primary-500 mt-4 text-center text-xs">
                    {bootstrapRequired
                        ? "The gateway token is only required once during first-user setup."
                        : "Gateway access stays server-side after bootstrap."}
                </p>
            </Card>
        </div>
    );
}
