import { useForm } from "@tanstack/react-form";
import {
    infiniteQueryOptions,
    useInfiniteQuery,
    useQueryClient,
} from "@tanstack/react-query";
import { Bot, Plus, RefreshCw } from "lucide-react";
import { useState } from "react";

import {
    createAutomationPrincipalInputSchema,
    type AutomationPrincipalCursor,
    type ListAutomationPrincipalsResult,
} from "../../contracts/automationSecurity.ts";
import type { ApplicationCapability } from "../../contracts/security.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { useExclusiveDashboardAction } from "../hooks/useExclusiveDashboardAction.ts";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Form } from "../ui/Form.tsx";
import { firstFormFieldError } from "../ui/formErrors.ts";
import { FormField } from "../ui/FormField.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Input } from "../ui/Input.tsx";
import { LoadingState } from "../ui/LoadingState.tsx";
import { AutomationCapabilityPicker } from "./AutomationCapabilityPicker.tsx";
import { AutomationPrincipalCard } from "./AutomationPrincipalCard.tsx";
import { revealIssuedAutomationToken } from "./issuedAutomationToken.ts";
import {
    automationPrincipalsQueryKey,
    refreshSecurityQueries,
} from "./securityQueries.ts";
import { OneTimeSecretPanel, SecuritySection } from "./SecurityUi.tsx";

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
                await revealIssuedAutomationToken(
                    created.token,
                    (token) => setIssuedToken(token),
                    () => refreshSecurityQueries(queryClient)
                );
            });
            if (result.status === "success") {
                formApi.reset();
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
                        <AutomationCapabilityPicker
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
