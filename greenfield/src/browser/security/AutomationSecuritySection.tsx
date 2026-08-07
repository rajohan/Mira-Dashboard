import { Fieldset, Legend } from "@headlessui/react";
import { useForm } from "@tanstack/react-form";
import {
    infiniteQueryOptions,
    useInfiniteQuery,
    useQueryClient,
} from "@tanstack/react-query";
import { Bot, KeyRound, Plus, RefreshCw, ShieldOff, Trash2 } from "lucide-react";
import { useState } from "react";

import {
    automationCredentialSettingsSchema,
    createAutomationPrincipalInputSchema,
    type AutomationCredentialCursor,
    type AutomationPrincipalCursor,
    type AutomationPrincipalSummary,
    type ListAutomationCredentialsResult,
    type ListAutomationPrincipalsResult,
} from "../../contracts/automationSecurity.ts";
import {
    type ApplicationCapability,
    applicationCapabilities,
} from "../../contracts/security.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { useExclusiveDashboardAction } from "../hooks/useExclusiveDashboardAction.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { Checkbox } from "../ui/Checkbox.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { ExpandableCard } from "../ui/ExpandableCard.tsx";
import { Form } from "../ui/Form.tsx";
import { firstFormFieldError } from "../ui/formErrors.ts";
import { FormField } from "../ui/FormField.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Input } from "../ui/Input.tsx";
import { LoadingState } from "../ui/LoadingState.tsx";
import {
    automationCredentialsQueryKey,
    automationPrincipalsQueryKey,
    refreshSecurityQueries,
} from "./securityQueries.ts";
import { OneTimeSecretPanel, SecuritySection } from "./SecurityUi.tsx";

interface CapabilityPickerProps {
    readonly disabled?: boolean;
    readonly onChange: (capabilities: ApplicationCapability[]) => void;
    readonly value: readonly ApplicationCapability[];
}

function CapabilityPicker({ disabled, onChange, value }: CapabilityPickerProps) {
    return (
        <Fieldset className="mt-4" disabled={disabled}>
            <Legend className="text-primary-200 text-sm font-medium">Capabilities</Legend>
            <div className="mt-2 flex flex-wrap gap-4">
                {applicationCapabilities.map((capability) => (
                    <Checkbox
                        checked={value.includes(capability)}
                        key={capability}
                        label={capability}
                        onChange={(checked) =>
                            onChange(
                                checked
                                    ? [...value, capability].toSorted()
                                    : value.filter((item) => item !== capability)
                            )
                        }
                    />
                ))}
            </div>
        </Fieldset>
    );
}

interface AutomationCredentialPanelProps {
    readonly onIssuedToken: (token: string) => void;
    readonly principal: AutomationPrincipalSummary;
}

function AutomationCredentialPanel({
    onIssuedToken,
    principal,
}: AutomationCredentialPanelProps) {
    const action = useExclusiveDashboardAction();
    const client = useDashboardTrpcClient();
    const queryClient = useQueryClient();
    const credentials = useInfiniteQuery(
        infiniteQueryOptions({
            initialPageParam: undefined as AutomationCredentialCursor | undefined,
            queryFn: ({ pageParam, signal }): Promise<ListAutomationCredentialsResult> =>
                client.query(
                    "automationSecurity.listCredentials",
                    pageParam === undefined
                        ? { limit: 50, principalId: principal.id }
                        : { cursor: pageParam, limit: 50, principalId: principal.id },
                    { signal }
                ),
            getNextPageParam: (lastPage) => lastPage.nextCursor,
            queryKey: automationCredentialsQueryKey(principal.id),
            retry: false,
            staleTime: 0,
        })
    );

    async function complete(operation: () => Promise<unknown>): Promise<boolean> {
        const result = await action.run(async () => {
            await operation();
            await refreshSecurityQueries(queryClient);
        });
        return result.status === "success";
    }

    const credentialForm = useForm({
        defaultValues: { label: "" },
        onSubmit: async ({ formApi, value }) => {
            const result = await action.run(async () => {
                const created = await client.mutation(
                    "automationSecurity.createCredential",
                    {
                        credential: value,
                        expectedAuthorizationVersion: principal.authorizationVersion,
                        principalId: principal.id,
                    }
                );
                await refreshSecurityQueries(queryClient);
                return created.token;
            });
            if (result.status === "success") {
                formApi.setFieldValue("label", "");
                onIssuedToken(result.value);
            }
        },
        validators: { onSubmit: automationCredentialSettingsSchema },
    });

    async function rotateCredential(credentialId: string, label: string) {
        const result = await action.run(async () => {
            const rotated = await client.mutation("automationSecurity.rotateCredential", {
                credentialId,
                expectedAuthorizationVersion: principal.authorizationVersion,
                principalId: principal.id,
                replacement: { label },
            });
            await refreshSecurityQueries(queryClient);
            return rotated.token;
        });
        if (result.status === "success") {
            credentialForm.setFieldValue("label", "");
            onIssuedToken(result.value);
        }
    }

    async function revokeCredential(credentialId: string) {
        await complete(() =>
            client.mutation("automationSecurity.revokeCredential", {
                credentialId,
                expectedAuthorizationVersion: principal.authorizationVersion,
                principalId: principal.id,
            })
        );
    }

    return (
        <div>
            <Alert className="mb-4" message={action.error} />
            {credentials.isPending && (
                <LoadingState label="Loading credentials…" size="sm" />
            )}
            {credentials.isError && (
                <div>
                    <Alert message={dashboardBrowserFailureMessage(credentials.error)} />
                    <Button
                        className="mt-3"
                        onClick={() => void credentials.refetch()}
                        size="sm"
                        variant="secondary"
                    >
                        <Icon icon={RefreshCw} size="sm" tone="inherit" />
                        Try again
                    </Button>
                </div>
            )}
            <credentialForm.Subscribe
                selector={(state) =>
                    [state.canSubmit, state.isSubmitting, state.values.label] as const
                }
            >
                {([canSubmit, isSubmitting, credentialLabel]) => (
                    <>
                        {credentials.isSuccess &&
                            credentials.data.pages.every(
                                (page) => page.credentials.length === 0
                            ) && (
                                <EmptyState
                                    description="Create the first scoped credential for this principal."
                                    icon={KeyRound}
                                    title="No credentials"
                                />
                            )}
                        {credentials.isSuccess && (
                            <ul className="space-y-3">
                                {credentials.data.pages.flatMap((page) =>
                                    page.credentials.map((credential) => (
                                        <li
                                            className="border-primary-700 rounded-lg border p-3 text-sm"
                                            key={credential.id}
                                        >
                                            <p className="text-primary-100 font-medium">
                                                {credential.label}
                                            </p>
                                            <p className="text-primary-400 mt-1">
                                                Created{" "}
                                                {formatDashboardDateTime(
                                                    credential.createdAtMs
                                                )}{" "}
                                                ·
                                                {credential.revokedAtMs === undefined
                                                    ? " active"
                                                    : ` revoked ${formatDashboardDateTime(credential.revokedAtMs)}`}
                                            </p>
                                            {!principal.disabled &&
                                                credential.revokedAtMs === undefined && (
                                                    <div className="mt-3 flex flex-wrap gap-2">
                                                        <Button
                                                            busy={action.busy}
                                                            busyLabel="Staging…"
                                                            disabled={
                                                                credentialLabel.length ===
                                                                0
                                                            }
                                                            onClick={() =>
                                                                void rotateCredential(
                                                                    credential.id,
                                                                    credentialLabel
                                                                )
                                                            }
                                                            size="sm"
                                                            variant="secondary"
                                                        >
                                                            <Icon
                                                                icon={RefreshCw}
                                                                size="sm"
                                                                tone="inherit"
                                                            />
                                                            Stage replacement
                                                        </Button>
                                                        <Button
                                                            busy={action.busy}
                                                            busyLabel="Revoking…"
                                                            onClick={() =>
                                                                void revokeCredential(
                                                                    credential.id
                                                                )
                                                            }
                                                            size="sm"
                                                            variant="danger"
                                                        >
                                                            <Icon
                                                                icon={Trash2}
                                                                size="sm"
                                                                tone="inherit"
                                                            />
                                                            Revoke
                                                        </Button>
                                                    </div>
                                                )}
                                        </li>
                                    ))
                                )}
                            </ul>
                        )}
                        {credentials.hasNextPage && (
                            <Button
                                busy={credentials.isFetchingNextPage}
                                busyLabel="Loading…"
                                className="mt-3"
                                onClick={() => void credentials.fetchNextPage()}
                                size="sm"
                                variant="secondary"
                            >
                                Load older credentials
                            </Button>
                        )}
                        {!principal.disabled && (
                            <Form
                                className="border-primary-700 mt-4 border-t pt-4"
                                onSubmit={() => void credentialForm.handleSubmit()}
                            >
                                <credentialForm.Field name="label">
                                    {(field) => (
                                        <FormField
                                            disabled={action.busy}
                                            description="This label is also used when staging a replacement above."
                                            error={firstFormFieldError(
                                                field.state.meta.errors
                                            )}
                                            label="New or replacement credential label"
                                        >
                                            <Input
                                                className="mt-2"
                                                name={field.name}
                                                onBlur={field.handleBlur}
                                                onChange={(event) =>
                                                    field.handleChange(
                                                        event.currentTarget.value
                                                    )
                                                }
                                                required
                                                value={field.state.value}
                                            />
                                        </FormField>
                                    )}
                                </credentialForm.Field>
                                <Button
                                    busy={action.busy || isSubmitting}
                                    busyLabel="Creating…"
                                    className="mt-3"
                                    disabled={!canSubmit}
                                    type="submit"
                                >
                                    <Icon icon={Plus} size="sm" tone="inherit" />
                                    Create credential
                                </Button>
                            </Form>
                        )}
                    </>
                )}
            </credentialForm.Subscribe>
        </div>
    );
}

interface AutomationPrincipalCardProps {
    readonly principal: AutomationPrincipalSummary;
}

function AutomationPrincipalCard({ principal }: AutomationPrincipalCardProps) {
    const action = useExclusiveDashboardAction();
    const client = useDashboardTrpcClient();
    const queryClient = useQueryClient();
    const [capabilities, setCapabilities] = useState<ApplicationCapability[]>([
        ...principal.capabilities,
    ]);
    const [issuedToken, setIssuedToken] = useState<string>();

    async function complete(operation: () => Promise<unknown>) {
        const result = await action.run(async () => {
            await operation();
            await refreshSecurityQueries(queryClient);
        });
        return result.status === "success";
    }

    async function replaceCapabilities() {
        const result = await action.run(async () => {
            const updated = await client.mutation(
                "automationSecurity.replaceCapabilities",
                {
                    capabilities,
                    expectedAuthorizationVersion: principal.authorizationVersion,
                    principalId: principal.id,
                }
            );
            await refreshSecurityQueries(queryClient);
            return updated.principal.capabilities;
        });
        if (result.status === "success") setCapabilities([...result.value]);
    }

    async function disablePrincipal() {
        await complete(() =>
            client.mutation("automationSecurity.disablePrincipal", {
                expectedAuthorizationVersion: principal.authorizationVersion,
                principalId: principal.id,
            })
        );
    }

    return (
        <li className="border-primary-700 rounded-xl border p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <Heading level={3}>{principal.label}</Heading>
                    <p className="text-primary-400 mt-1 font-mono text-sm">
                        {principal.id}
                    </p>
                    <p className="text-primary-400 mt-1 text-sm">
                        {principal.disabled ? "Disabled" : "Active"} ·{" "}
                        {principal.activeCredentialCount} active credential(s)
                    </p>
                </div>
                {!principal.disabled && (
                    <Button
                        busy={action.busy}
                        busyLabel="Disabling…"
                        onClick={() => void disablePrincipal()}
                        size="sm"
                        variant="danger"
                    >
                        <Icon icon={ShieldOff} size="sm" tone="inherit" />
                        Disable principal
                    </Button>
                )}
            </div>
            <Alert className="mt-4" message={action.error} />
            {issuedToken !== undefined && (
                <OneTimeSecretPanel
                    id={`automation-token-${principal.id}`}
                    onDismiss={() => setIssuedToken(undefined)}
                    title="New automation token"
                >
                    {issuedToken}
                </OneTimeSecretPanel>
            )}
            <CapabilityPicker
                disabled={principal.disabled || action.busy}
                onChange={setCapabilities}
                value={capabilities}
            />
            {!principal.disabled && (
                <Button
                    busy={action.busy}
                    busyLabel="Updating…"
                    className="mt-3"
                    onClick={() => void replaceCapabilities()}
                    size="sm"
                    variant="secondary"
                >
                    Replace capabilities
                </Button>
            )}
            <ExpandableCard
                className="mt-5"
                description="Create, stage, rotate, or revoke scoped credentials."
                icon={KeyRound}
                title="Manage credentials"
            >
                <AutomationCredentialPanel
                    onIssuedToken={setIssuedToken}
                    principal={principal}
                />
            </ExpandableCard>
        </li>
    );
}

/**
 * Renders cursor-paginated automation identities and one-time credential issuance.
 * @returns The automation-security management section.
 */
export function AutomationSecuritySection() {
    const action = useExclusiveDashboardAction();
    const client = useDashboardTrpcClient();
    const queryClient = useQueryClient();
    const [issuedToken, setIssuedToken] = useState<string>();
    const principals = useInfiniteQuery(
        infiniteQueryOptions({
            initialPageParam: undefined as AutomationPrincipalCursor | undefined,
            queryFn: ({ pageParam, signal }): Promise<ListAutomationPrincipalsResult> =>
                client.query(
                    "automationSecurity.listPrincipals",
                    pageParam === undefined
                        ? { limit: 50 }
                        : { cursor: pageParam, limit: 50 },
                    { signal }
                ),
            getNextPageParam: (lastPage) => lastPage.nextCursor,
            queryKey: automationPrincipalsQueryKey,
            retry: false,
            staleTime: 0,
        })
    );
    const principalForm = useForm({
        defaultValues: {
            capabilities: [] as ApplicationCapability[],
            id: "",
            initialCredential: { label: "" },
            label: "",
        },
        onSubmit: async ({ formApi, value }) => {
            const result = await action.run(async () => {
                const created = await client.mutation(
                    "automationSecurity.createPrincipal",
                    value
                );
                await refreshSecurityQueries(queryClient);
                return created.token;
            });
            if (result.status === "success") {
                formApi.reset();
                setIssuedToken(result.value);
            }
        },
        validators: { onSubmit: createAutomationPrincipalInputSchema },
    });

    return (
        <SecuritySection
            description="Create least-privilege automation principals and rotate exact one-time credentials."
            id="automation-security-heading"
            title="Automation credentials"
        >
            <Alert className="mb-4" message={action.error} />
            {issuedToken !== undefined && (
                <OneTimeSecretPanel
                    id="new-principal-token"
                    onDismiss={() => setIssuedToken(undefined)}
                    title="Initial automation token"
                >
                    {issuedToken}
                </OneTimeSecretPanel>
            )}
            <Form
                className="border-primary-700 rounded-xl border p-4"
                onSubmit={() => void principalForm.handleSubmit()}
            >
                <Heading level={3}>Create principal</Heading>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <principalForm.Field name="id">
                        {(field) => (
                            <FormField
                                disabled={action.busy}
                                error={firstFormFieldError(field.state.meta.errors)}
                                label="Principal ID"
                            >
                                <Input
                                    autoCapitalize="none"
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
                    </principalForm.Field>
                    <principalForm.Field name="label">
                        {(field) => (
                            <FormField
                                disabled={action.busy}
                                error={firstFormFieldError(field.state.meta.errors)}
                                label="Principal label"
                            >
                                <Input
                                    className="mt-2"
                                    name={field.name}
                                    onBlur={field.handleBlur}
                                    onChange={(event) =>
                                        field.handleChange(event.currentTarget.value)
                                    }
                                    required
                                    value={field.state.value}
                                />
                            </FormField>
                        )}
                    </principalForm.Field>
                    <principalForm.Field name="initialCredential.label">
                        {(field) => (
                            <FormField
                                disabled={action.busy}
                                error={firstFormFieldError(field.state.meta.errors)}
                                label="Initial credential label"
                            >
                                <Input
                                    className="mt-2"
                                    name={field.name}
                                    onBlur={field.handleBlur}
                                    onChange={(event) =>
                                        field.handleChange(event.currentTarget.value)
                                    }
                                    required
                                    value={field.state.value}
                                />
                            </FormField>
                        )}
                    </principalForm.Field>
                </div>
                <principalForm.Field name="capabilities">
                    {(field) => (
                        <CapabilityPicker
                            disabled={action.busy}
                            onChange={field.handleChange}
                            value={field.state.value}
                        />
                    )}
                </principalForm.Field>
                <principalForm.Subscribe
                    selector={(state) => [state.canSubmit, state.isSubmitting] as const}
                >
                    {([canSubmit, isSubmitting]) => (
                        <Button
                            busy={action.busy || isSubmitting}
                            busyLabel="Creating…"
                            className="mt-4"
                            disabled={!canSubmit}
                            type="submit"
                        >
                            <Icon icon={Plus} size="sm" tone="inherit" />
                            Create principal and credential
                        </Button>
                    )}
                </principalForm.Subscribe>
            </Form>
            {principals.isPending && (
                <LoadingState
                    className="mt-5"
                    label="Loading automation principals…"
                    size="sm"
                />
            )}
            {principals.isError && (
                <div className="mt-5">
                    <Alert message={dashboardBrowserFailureMessage(principals.error)} />
                    <Button
                        className="mt-3"
                        onClick={() => void principals.refetch()}
                        size="sm"
                        variant="secondary"
                    >
                        <Icon icon={RefreshCw} size="sm" tone="inherit" />
                        Try again
                    </Button>
                </div>
            )}
            {principals.isSuccess &&
                principals.data.pages.every((page) => page.principals.length === 0) && (
                    <EmptyState
                        className="mt-5"
                        description="Create the first least-privilege automation identity above."
                        icon={Bot}
                        title="No automation principals"
                    />
                )}
            {principals.isSuccess && (
                <ul className="mt-5 space-y-4">
                    {principals.data.pages.flatMap((page) =>
                        page.principals.map((principal) => (
                            <AutomationPrincipalCard
                                key={principal.id}
                                principal={principal}
                            />
                        ))
                    )}
                </ul>
            )}
            {principals.hasNextPage && (
                <Button
                    busy={principals.isFetchingNextPage}
                    busyLabel="Loading…"
                    className="mt-4"
                    onClick={() => void principals.fetchNextPage()}
                    variant="secondary"
                >
                    Load older principals
                </Button>
            )}
        </SecuritySection>
    );
}
