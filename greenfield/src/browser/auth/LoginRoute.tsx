import { useForm } from "@tanstack/react-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate } from "@tanstack/react-router";
import {
    Fingerprint,
    KeyRound,
    LifeBuoy,
    ShieldCheck,
    Smartphone,
    UserRoundPlus,
    type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import {
    firstUserBootstrapInputSchema,
    passwordLoginInputSchema,
    recoveryLoginInputSchema,
    totpLoginInputSchema,
    type AuthStatus,
} from "../../contracts/auth.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { useExclusiveDashboardAction } from "../hooks/useExclusiveDashboardAction.ts";
import { useDashboardWebAuthnClient } from "../security/webauthn/webauthnContextValue.ts";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { Form } from "../ui/Form.tsx";
import { firstFormFieldError } from "../ui/formErrors.ts";
import { FormField } from "../ui/FormField.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Input } from "../ui/Input.tsx";
import { PageState } from "../ui/PageState.tsx";
import { Text } from "../ui/Text.tsx";
import { authStatusQueryOptions, resetAuthenticatedBrowserCache } from "./authQueries.ts";

interface LoginPanelProps {
    readonly children: ReactNode;
    readonly description: string;
    readonly icon: LucideIcon;
    readonly title: string;
}

function LoginPanel({ children, description, icon, title }: LoginPanelProps) {
    return (
        <Card
            aria-labelledby="login-heading"
            className="bg-primary-900/80 mx-auto w-full max-w-md p-6 shadow-2xl shadow-black/25"
        >
            <div className="text-accent-300 flex items-center gap-2 text-sm font-medium">
                <Icon icon={icon} size="sm" tone="accent" />
                <span>Mira Dashboard</span>
            </div>
            <Heading className="mt-2" id="login-heading" level={1} size="panel">
                {title}
            </Heading>
            <Text className="mt-2" tone="muted">
                {description}
            </Text>
            <div className="mt-6">{children}</div>
        </Card>
    );
}

function useAuthenticationAction() {
    const client = useDashboardTrpcClient();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const action = useExclusiveDashboardAction();

    async function run(operation: () => Promise<unknown>): Promise<void> {
        const result = await action.run(async () => {
            await operation();
            const status = await client.query("auth.status", {});
            resetAuthenticatedBrowserCache(queryClient, status);
            return status;
        });
        if (result.status === "success" && result.value.state === "authenticated") {
            await navigate({ replace: true, to: "/" });
        }
    }

    return { ...action, client, run };
}

function BootstrapForm() {
    const { busy, client, error, run } = useAuthenticationAction();
    const form = useForm({
        defaultValues: {
            gatewayCredential: "",
            password: "",
            username: "",
        },
        onSubmit: async ({ formApi, value }) => {
            await run(async () => {
                await client.mutation("auth.bootstrap", value);
                formApi.setFieldValue("gatewayCredential", "");
                formApi.setFieldValue("password", "");
            });
        },
        validators: { onSubmit: firstUserBootstrapInputSchema },
    });

    return (
        <LoginPanel
            description="Verify the existing Gateway credential and create the sole Dashboard operator."
            icon={UserRoundPlus}
            title="Secure first-user setup"
        >
            <Alert className="mb-5" message={error} />
            <Form onSubmit={() => void form.handleSubmit()}>
                <div className="space-y-4">
                    <form.Field name="username">
                        {(field) => (
                            <FormField
                                disabled={busy}
                                error={firstFormFieldError(field.state.meta.errors)}
                                label="Username"
                            >
                                <Input
                                    autoCapitalize="none"
                                    autoComplete="username"
                                    className="mt-2"
                                    name={field.name}
                                    onBlur={field.handleBlur}
                                    onChange={(event) =>
                                        field.handleChange(event.currentTarget.value)
                                    }
                                    required
                                    spellCheck={false}
                                    value={field.state.value}
                                />
                            </FormField>
                        )}
                    </form.Field>
                    <form.Field name="password">
                        {(field) => (
                            <FormField
                                disabled={busy}
                                error={firstFormFieldError(field.state.meta.errors)}
                                label="Dashboard password"
                            >
                                <Input
                                    autoComplete="new-password"
                                    className="mt-2"
                                    name={field.name}
                                    onBlur={field.handleBlur}
                                    onChange={(event) =>
                                        field.handleChange(event.currentTarget.value)
                                    }
                                    required
                                    type="password"
                                    value={field.state.value}
                                />
                            </FormField>
                        )}
                    </form.Field>
                    <form.Field name="gatewayCredential">
                        {(field) => (
                            <FormField
                                disabled={busy}
                                error={firstFormFieldError(field.state.meta.errors)}
                                label="Gateway credential"
                            >
                                <Input
                                    autoComplete="off"
                                    className="mt-2"
                                    name={field.name}
                                    onBlur={field.handleBlur}
                                    onChange={(event) =>
                                        field.handleChange(event.currentTarget.value)
                                    }
                                    required
                                    spellCheck={false}
                                    type="password"
                                    value={field.state.value}
                                />
                            </FormField>
                        )}
                    </form.Field>
                </div>
                <form.Subscribe
                    selector={(state) => [state.canSubmit, state.isSubmitting] as const}
                >
                    {([canSubmit, isSubmitting]) => (
                        <Button
                            busy={busy || isSubmitting}
                            busyLabel="Creating operator…"
                            className="mt-5"
                            disabled={!canSubmit}
                            fullWidth
                            type="submit"
                        >
                            <Icon icon={UserRoundPlus} size="sm" tone="inherit" />
                            Create operator
                        </Button>
                    )}
                </form.Subscribe>
            </Form>
        </LoginPanel>
    );
}

function PasswordLoginForm() {
    const { busy, client, error, run } = useAuthenticationAction();
    const form = useForm({
        defaultValues: { password: "", username: "" },
        onSubmit: async ({ formApi, value }) => {
            await run(async () => {
                await client.mutation("auth.login", value);
                formApi.setFieldValue("password", "");
            });
        },
        validators: { onSubmit: passwordLoginInputSchema },
    });

    return (
        <LoginPanel
            description="Use your Dashboard operator account."
            icon={KeyRound}
            title="Sign in"
        >
            <Alert className="mb-5" message={error} />
            <Form onSubmit={() => void form.handleSubmit()}>
                <div className="space-y-4">
                    <form.Field name="username">
                        {(field) => (
                            <FormField
                                disabled={busy}
                                error={firstFormFieldError(field.state.meta.errors)}
                                label="Username"
                            >
                                <Input
                                    autoCapitalize="none"
                                    autoComplete="username"
                                    className="mt-2"
                                    name={field.name}
                                    onBlur={field.handleBlur}
                                    onChange={(event) =>
                                        field.handleChange(event.currentTarget.value)
                                    }
                                    required
                                    spellCheck={false}
                                    value={field.state.value}
                                />
                            </FormField>
                        )}
                    </form.Field>
                    <form.Field name="password">
                        {(field) => (
                            <FormField
                                disabled={busy}
                                error={firstFormFieldError(field.state.meta.errors)}
                                label="Password"
                            >
                                <Input
                                    autoComplete="current-password"
                                    className="mt-2"
                                    name={field.name}
                                    onBlur={field.handleBlur}
                                    onChange={(event) =>
                                        field.handleChange(event.currentTarget.value)
                                    }
                                    required
                                    type="password"
                                    value={field.state.value}
                                />
                            </FormField>
                        )}
                    </form.Field>
                </div>
                <form.Subscribe
                    selector={(state) => [state.canSubmit, state.isSubmitting] as const}
                >
                    {([canSubmit, isSubmitting]) => (
                        <Button
                            busy={busy || isSubmitting}
                            busyLabel="Signing in…"
                            className="mt-5"
                            disabled={!canSubmit}
                            fullWidth
                            type="submit"
                        >
                            <Icon icon={KeyRound} size="sm" tone="inherit" />
                            Continue
                        </Button>
                    )}
                </form.Subscribe>
            </Form>
        </LoginPanel>
    );
}

interface PendingMfaFormProps {
    readonly status: Extract<AuthStatus, { state: "pending-mfa" }>;
}

function PendingMfaForm({ status }: PendingMfaFormProps) {
    const { busy, client, error, run } = useAuthenticationAction();
    const webAuthn = useDashboardWebAuthnClient();
    const totpForm = useForm({
        defaultValues: { code: "" },
        onSubmit: async ({ formApi, value }) => {
            await run(async () => {
                await client.mutation("auth.loginTotp", value);
                formApi.setFieldValue("code", "");
            });
        },
        validators: { onSubmit: totpLoginInputSchema },
    });
    const recoveryForm = useForm({
        defaultValues: { code: "" },
        onSubmit: async ({ formApi, value }) => {
            await run(async () => {
                await client.mutation("auth.loginRecovery", value);
                formApi.setFieldValue("code", "");
            });
        },
        validators: { onSubmit: recoveryLoginInputSchema },
    });
    const methods = status.pendingLogin.methods;
    const hasTotp = methods.includes("totp");
    const hasRecovery = methods.includes("recovery");
    const hasWebAuthn = methods.includes("webauthn");

    async function submitWebAuthn() {
        await run(async () => {
            const challenge = await client.mutation("auth.beginWebAuthnLogin", {});
            const credential = await webAuthn.authenticate(challenge.options);
            await client.mutation("auth.loginWebAuthn", { response: credential });
        });
    }

    return (
        <LoginPanel
            description={`Complete the second step for ${status.pendingLogin.username}.`}
            icon={ShieldCheck}
            title="Multi-factor authentication"
        >
            <Alert className="mb-5" message={error} />
            {hasTotp && (
                <Form onSubmit={() => void totpForm.handleSubmit()}>
                    <totpForm.Field name="code">
                        {(field) => (
                            <FormField
                                disabled={busy}
                                error={firstFormFieldError(field.state.meta.errors)}
                                label="Authenticator code"
                            >
                                <Input
                                    autoComplete="one-time-code"
                                    className="mt-2"
                                    inputMode="numeric"
                                    name="totp"
                                    onBlur={field.handleBlur}
                                    onChange={(event) =>
                                        field.handleChange(event.currentTarget.value)
                                    }
                                    required
                                    value={field.state.value}
                                />
                            </FormField>
                        )}
                    </totpForm.Field>
                    <totpForm.Subscribe
                        selector={(state) =>
                            [state.canSubmit, state.isSubmitting] as const
                        }
                    >
                        {([canSubmit, isSubmitting]) => (
                            <Button
                                busy={busy || isSubmitting}
                                busyLabel="Verifying…"
                                className="mt-5"
                                disabled={!canSubmit}
                                fullWidth
                                type="submit"
                            >
                                <Icon icon={Smartphone} size="sm" tone="inherit" />
                                Verify code
                            </Button>
                        )}
                    </totpForm.Subscribe>
                </Form>
            )}
            {hasRecovery && (
                <Form
                    className={
                        hasTotp ? "border-primary-700 mt-6 border-t pt-6" : undefined
                    }
                    onSubmit={() => void recoveryForm.handleSubmit()}
                >
                    <recoveryForm.Field name="code">
                        {(field) => (
                            <FormField
                                disabled={busy}
                                error={firstFormFieldError(field.state.meta.errors)}
                                label="Recovery code"
                            >
                                <Input
                                    autoComplete="off"
                                    className="mt-2"
                                    name="recoveryCode"
                                    onBlur={field.handleBlur}
                                    onChange={(event) =>
                                        field.handleChange(event.currentTarget.value)
                                    }
                                    required
                                    spellCheck={false}
                                    type="password"
                                    value={field.state.value}
                                />
                            </FormField>
                        )}
                    </recoveryForm.Field>
                    <recoveryForm.Subscribe
                        selector={(state) =>
                            [state.canSubmit, state.isSubmitting] as const
                        }
                    >
                        {([canSubmit, isSubmitting]) => (
                            <Button
                                busy={busy || isSubmitting}
                                busyLabel="Verifying…"
                                className="mt-5"
                                disabled={!canSubmit}
                                fullWidth
                                type="submit"
                                variant="secondary"
                            >
                                <Icon icon={LifeBuoy} size="sm" tone="inherit" />
                                Use recovery code
                            </Button>
                        )}
                    </recoveryForm.Subscribe>
                </Form>
            )}
            {hasWebAuthn && (
                <Button
                    busy={busy}
                    busyLabel="Waiting for security key…"
                    className="mt-6"
                    fullWidth
                    onClick={() => void submitWebAuthn()}
                    variant="secondary"
                >
                    <Icon icon={Fingerprint} size="sm" tone="inherit" />
                    Use a security key
                </Button>
            )}
        </LoginPanel>
    );
}

/**
 * Renders bootstrap, password, and pending-MFA authentication states.
 * @returns The current login state or an authenticated redirect.
 */
export function LoginRoute() {
    const client = useDashboardTrpcClient();
    const status = useQuery({
        ...authStatusQueryOptions(client),
        refetchOnMount: false,
    });

    if (status.isPending) {
        return <PageState label="Loading sign-in…" status="loading" />;
    }
    if (status.isError) {
        return (
            <PageState
                message={dashboardBrowserFailureMessage(status.error)}
                onRetry={() => void status.refetch()}
                retryBusy={status.isFetching}
                status="error"
                title="Sign-in unavailable"
            />
        );
    }
    switch (status.data.state) {
        case "anonymous": {
            return <PasswordLoginForm />;
        }
        case "authenticated": {
            return <Navigate replace to="/" />;
        }
        case "bootstrap-required": {
            return <BootstrapForm />;
        }
        case "pending-mfa": {
            return <PendingMfaForm status={status.data} />;
        }
    }
}
