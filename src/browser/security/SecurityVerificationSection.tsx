import { useForm } from "@tanstack/react-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Mail, ShieldCheck } from "lucide-react";
import { useState } from "react";

import type { AccountSecuritySummary } from "../../contracts/accountSecurity.ts";
import { emailChangeInputSchema } from "../../contracts/auth.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import {
    authStatusQueryOptions,
    publishAuthenticationStatus,
} from "../auth/authQueries.ts";
import { useExclusiveDashboardAction } from "../hooks/useExclusiveDashboardAction.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Form } from "../ui/Form.tsx";
import { progressiveFormValidators, touchedFormFieldError } from "../ui/formErrors.ts";
import { FormField } from "../ui/FormField.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Input } from "../ui/Input.tsx";
import { Modal } from "../ui/Modal.tsx";
import { PasswordChangeForm } from "./PasswordChangeForm.tsx";
import { SecurityProofControls } from "./SecurityProofControls.tsx";
import { refreshSecurityQueries } from "./securityQueries.ts";
import { SecuritySection } from "./SecurityUi.tsx";

interface SecurityVerificationSectionProps {
    readonly summary: AccountSecuritySummary;
}

function useSecurityActionCompletion() {
    const action = useExclusiveDashboardAction();
    const queryClient = useQueryClient();
    const [notice, setNotice] = useState<string>();

    async function complete(
        operation: () => Promise<unknown>,
        successMessage: string
    ): Promise<boolean> {
        setNotice(undefined);
        const result = await action.run(async () => {
            await operation();
            await refreshSecurityQueries(queryClient);
        });
        if (result.status !== "success") return false;
        setNotice(successMessage);
        return true;
    }

    return { action, complete, dismissNotice: () => setNotice(undefined), notice };
}

/**
 * Shows account verification status and opens the appropriate proof in a modal.
 * @returns The compact two-step-login status section.
 */
export function SecurityVerificationSection({
    summary,
}: SecurityVerificationSectionProps) {
    const { action, complete, dismissNotice, notice } = useSecurityActionCompletion();
    const [verificationMode, setVerificationMode] = useState<"mfa" | "password">();
    let verificationAction;
    if (summary.mfa.enabled) {
        verificationAction = (
            <Button
                disabled={action.busy}
                onClick={() => setVerificationMode("mfa")}
                variant="secondary"
            >
                Verify now
            </Button>
        );
    } else if (!summary.recentAuth.password.recent) {
        verificationAction = (
            <Button
                disabled={action.busy}
                onClick={() => setVerificationMode("password")}
                variant="secondary"
            >
                Verify password
            </Button>
        );
    }

    return (
        <div className="contents">
            <Heading className="sr-only" id="security-verification-heading" level={2}>
                Verification and password
            </Heading>
            <Alert message={notice} onDismiss={dismissNotice} variant="success" />
            <SecuritySection
                actions={verificationAction}
                badge={
                    <Badge variant={summary.mfa.enabled ? "success" : "warning"}>
                        {summary.mfa.enabled ? "Enabled" : "Not enabled"}
                    </Badge>
                }
                description="Security keys are phishing-resistant. Authenticator apps are supported as an alternative."
                id="two-step-login-heading"
                icon={ShieldCheck}
                title="Two-step login"
            />
            <Modal
                description={
                    verificationMode === "password"
                        ? "Confirm your current Dashboard password."
                        : "Use one of your registered second-factor methods."
                }
                dismissible={!action.busy}
                onClose={() => setVerificationMode(undefined)}
                open={verificationMode !== undefined}
                size="sm"
                title={
                    verificationMode === "password"
                        ? "Verify current password"
                        : "Verify second factor"
                }
            >
                <Alert className="mb-4" message={action.error} />
                {verificationMode !== undefined && (
                    <SecurityProofControls
                        action={action}
                        complete={complete}
                        methods={summary.mfa.methods}
                        mode={verificationMode}
                        onVerified={() => setVerificationMode(undefined)}
                    />
                )}
            </Modal>
        </div>
    );
}

/**
 * Keeps password rotation compact until the user explicitly opens its modal.
 * @returns The Dashboard-password management section.
 */
export function DashboardPasswordSection() {
    const { action, complete, dismissNotice, notice } = useSecurityActionCompletion();
    const [open, setOpen] = useState(false);

    return (
        <div className="contents">
            <Alert message={notice} onDismiss={dismissNotice} variant="success" />
            <SecuritySection
                actions={
                    <Button
                        disabled={action.busy}
                        onClick={() => setOpen(true)}
                        variant="secondary"
                    >
                        Change password
                    </Button>
                }
                description="Changing it signs every other Dashboard browser out. Forgotten passwords use a short-lived email link."
                id="dashboard-password-heading"
                icon={KeyRound}
                title="Dashboard password"
            />
            <PasswordChangeForm
                action={action}
                complete={complete}
                onClose={() => setOpen(false)}
                open={open}
            />
        </div>
    );
}

/**
 * Manages the account email used exclusively for security and password recovery.
 * @returns Account-email settings section and edit modal.
 */
export function AccountEmailSection() {
    const client = useDashboardTrpcClient();
    const queryClient = useQueryClient();
    const { action, complete, dismissNotice, notice } = useSecurityActionCompletion();
    const [open, setOpen] = useState(false);
    const { data: status } = useQuery(authStatusQueryOptions(client));
    const currentEmail = status?.state === "authenticated" ? status.user.email : "";
    const emailVerified = status?.state === "authenticated" && status.user.emailVerified;
    const pendingEmail =
        status?.state === "authenticated" ? status.user.pendingEmail : undefined;
    let emailBadgeVariant: "info" | "success" | "warning" = "warning";
    let emailBadgeLabel = "Unverified";
    if (pendingEmail !== undefined) {
        emailBadgeVariant = "info";
        emailBadgeLabel = "Change pending";
    } else if (emailVerified) {
        emailBadgeVariant = "success";
        emailBadgeLabel = "Verified";
    }
    const form = useForm({
        defaultValues: { email: currentEmail },
        onSubmit: async ({ value }) => {
            const changed = await complete(async () => {
                const result = await client.mutation("auth.changeEmail", value);
                const freshStatus = await client.query("auth.status", {});
                await publishAuthenticationStatus(queryClient, freshStatus);
                return result;
            }, "Verification email sent.");
            if (changed) setOpen(false);
        },
        validators: progressiveFormValidators(emailChangeInputSchema),
    });
    return (
        <div className="contents">
            <Alert message={notice} onDismiss={dismissNotice} variant="success" />
            <SecuritySection
                actions={
                    <Button onClick={() => setOpen(true)} variant="secondary">
                        Change email
                    </Button>
                }
                badge={<Badge variant={emailBadgeVariant}>{emailBadgeLabel}</Badge>}
                description="Verified address used for account security and password recovery."
                id="account-email-heading"
                icon={Mail}
                title="Account email"
            />
            <Modal
                description="Reset links will be delivered to this address."
                dismissible={!action.busy}
                onClose={() => setOpen(false)}
                open={open}
                size="sm"
                title="Change account email"
            >
                <Alert className="mb-4" message={action.error} />
                <Alert
                    className="mb-4"
                    message={
                        pendingEmail === undefined
                            ? undefined
                            : `Waiting for verification of ${pendingEmail}.`
                    }
                    variant="info"
                />
                <Form onSubmit={() => void form.handleSubmit()}>
                    <form.Field name="email">
                        {(field) => (
                            <FormField
                                disabled={action.busy}
                                error={touchedFormFieldError(field.state.meta)}
                                label="Email"
                            >
                                <Input
                                    autoComplete="email"
                                    className="mt-2"
                                    name={field.name}
                                    onBlur={field.handleBlur}
                                    onChange={(event) =>
                                        field.handleChange(event.currentTarget.value)
                                    }
                                    required
                                    type="email"
                                    value={field.state.value}
                                />
                            </FormField>
                        )}
                    </form.Field>
                    <form.Subscribe
                        selector={(state) =>
                            [state.canSubmit, state.values.email] as const
                        }
                    >
                        {([canSubmit, candidateEmail]) => (
                            <Button
                                busy={action.busy}
                                className="mt-5"
                                disabled={
                                    !canSubmit ||
                                    (emailVerified && candidateEmail === currentEmail)
                                }
                                fullWidth
                                type="submit"
                            >
                                Save email
                            </Button>
                        )}
                    </form.Subscribe>
                </Form>
            </Modal>
        </div>
    );
}
