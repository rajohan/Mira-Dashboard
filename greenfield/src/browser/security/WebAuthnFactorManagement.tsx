import { useForm } from "@tanstack/react-form";
import { Fingerprint, Trash2 } from "lucide-react";

import type { AccountSecuritySummary } from "../../contracts/accountSecurity.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import type { useExclusiveDashboardAction } from "../hooks/useExclusiveDashboardAction.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Button } from "../ui/Button.tsx";
import { Form } from "../ui/Form.tsx";
import { firstFormFieldError } from "../ui/formErrors.ts";
import { FormField } from "../ui/FormField.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Input } from "../ui/Input.tsx";
import { optionalFactorLabelFormSchema } from "./mfaFormSchemas.ts";
import { useDashboardWebAuthnClient } from "./webauthn/webauthnContextValue.ts";

interface WebAuthnFactorManagementProps {
    readonly action: ReturnType<typeof useExclusiveDashboardAction>;
    readonly available: boolean;
    readonly credentials: AccountSecuritySummary["mfa"]["webAuthnCredentials"];
    readonly factorCapacityReached: boolean;
    readonly onRecoveryCodes: (codes: readonly string[]) => void;
    readonly onRemove: (credential: Readonly<{ id: string; label: string }>) => void;
    readonly refreshAfter: (operation: () => Promise<unknown>) => Promise<boolean>;
}

/**
 * Manages WebAuthn security-key inventory and registration ceremonies.
 * @returns Security-key inventory and enrollment controls.
 */
export function WebAuthnFactorManagement({
    action,
    available,
    credentials,
    factorCapacityReached,
    onRecoveryCodes,
    onRemove,
    refreshAfter,
}: WebAuthnFactorManagementProps) {
    const client = useDashboardTrpcClient();
    const webAuthn = useDashboardWebAuthnClient();
    const labelForm = useForm({
        defaultValues: { label: "" },
        onSubmit: async ({ formApi, value }) => {
            const succeeded = await refreshAfter(async () => {
                const challenge = await client.mutation(
                    "accountSecurity.beginWebAuthnEnrollment",
                    {}
                );
                const response = await webAuthn.register(challenge.options);
                const result = await client.mutation(
                    "accountSecurity.confirmWebAuthnEnrollment",
                    value.label.length === 0
                        ? { response }
                        : { label: value.label, response }
                );
                if (result.enabledNow) onRecoveryCodes(result.recoveryCodes);
            });
            if (succeeded) formApi.setFieldValue("label", "");
        },
        validators: { onSubmit: optionalFactorLabelFormSchema },
    });

    return (
        <div>
            <Heading level={3}>Security keys</Heading>
            <ul className="mt-3 space-y-3">
                {credentials.map((credential) => (
                    <li
                        className="border-primary-700 rounded-lg border p-3 text-sm"
                        key={credential.id}
                    >
                        <p className="text-primary-100 font-medium">{credential.label}</p>
                        <p className="text-primary-400 mt-1">
                            Added {formatDashboardDateTime(credential.createdAtMs)} ·
                            {credential.usable ? " usable" : " unavailable"}
                        </p>
                        <Button
                            aria-label={`Remove security key ${credential.label}`}
                            busy={action.busy}
                            busyLabel="Removing…"
                            className="mt-3"
                            onClick={() => onRemove(credential)}
                            size="sm"
                            variant="danger"
                        >
                            <Icon icon={Trash2} size="sm" tone="inherit" />
                            Remove
                        </Button>
                    </li>
                ))}
            </ul>
            {available ? (
                <Form className="mt-4" onSubmit={() => void labelForm.handleSubmit()}>
                    <labelForm.Field name="label">
                        {(field) => (
                            <FormField
                                disabled={factorCapacityReached || action.busy}
                                error={firstFormFieldError(field.state.meta.errors)}
                                label="Security-key label"
                            >
                                <Input
                                    className="mt-2"
                                    name={field.name}
                                    onBlur={field.handleBlur}
                                    onChange={(event) =>
                                        field.handleChange(event.currentTarget.value)
                                    }
                                    placeholder="Primary security key"
                                    value={field.state.value}
                                />
                            </FormField>
                        )}
                    </labelForm.Field>
                    <labelForm.Subscribe
                        selector={(state) =>
                            [state.canSubmit, state.isSubmitting] as const
                        }
                    >
                        {([canSubmit, isSubmitting]) => (
                            <Button
                                busy={action.busy || isSubmitting}
                                busyLabel="Waiting for security key…"
                                className="mt-3"
                                disabled={factorCapacityReached || !canSubmit}
                                type="submit"
                            >
                                <Icon icon={Fingerprint} size="sm" tone="inherit" />
                                Enroll security key
                            </Button>
                        )}
                    </labelForm.Subscribe>
                </Form>
            ) : (
                <p className="text-primary-400 mt-3 text-sm">
                    WebAuthn is unavailable for this origin.
                </p>
            )}
        </div>
    );
}
