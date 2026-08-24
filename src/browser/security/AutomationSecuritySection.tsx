import { useForm } from "@tanstack/react-form";
import {
    infiniteQueryOptions,
    useInfiniteQuery,
    useQueryClient,
} from "@tanstack/react-query";
import { Bot, Plus, RefreshCw } from "lucide-react";

import type { AuthStatus } from "../../contracts/auth.ts";
import {
    createAutomationPrincipalInputSchema,
    type AutomationPrincipalCursor,
    type ListAutomationPrincipalsResult,
} from "../../contracts/automationSecurity.ts";
import type { ApplicationCapability } from "../../contracts/security.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { authStatusQueryKey } from "../auth/authQueries.ts";
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
import { VirtualizedList } from "../ui/VirtualizedList.tsx";
import { AutomationCapabilityPicker } from "./AutomationCapabilityPicker.tsx";
import { AutomationPrincipalCard } from "./AutomationPrincipalCard.tsx";
import { useAutomationTokenPresenter } from "./automationTokenPresentationContextValue.ts";
import { revealIssuedAutomationToken } from "./issuedAutomationToken.ts";
import {
    automationPrincipalsQueryKey,
    refreshSecurityQueries,
} from "./securityQueries.ts";
import { SecuritySection } from "./SecurityUi.tsx";

/**
 * Renders cursor-paginated automation identities and one-time credential issuance.
 * @returns The automation-security management section.
 */
export function AutomationSecuritySection() {
    const action = useExclusiveDashboardAction();
    const automationTokenPresenter = useAutomationTokenPresenter();
    const client = useDashboardTrpcClient();
    const queryClient = useQueryClient();
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
    const principalPageError = principals.isFetchNextPageError ? principals.error : null;
    const principalForm = useForm({
        defaultValues: {
            capabilities: [] as ApplicationCapability[],
            id: "",
            initialCredential: { label: "" },
            label: "",
        },
        onSubmit: async ({ formApi, value }) => {
            const result = await action.run(async () => {
                const authentication =
                    queryClient.getQueryData<AuthStatus>(authStatusQueryKey);
                if (authentication?.state !== "authenticated") {
                    throw new TypeError(
                        "Authenticated automation-token owner unavailable"
                    );
                }
                const ownerUserId = authentication.user.id;
                const created = await client.mutation(
                    "automationSecurity.createPrincipal",
                    value
                );
                await revealIssuedAutomationToken(
                    created.token,
                    (token) => {
                        automationTokenPresenter.present(ownerUserId, token);
                    },
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
            description="Create automation accounts and give each one only the permissions it needs. New access tokens are shown once."
            id="automation-security-heading"
            icon={Bot}
            title="Automation access"
        >
            <Alert className="mb-4" message={action.error} />
            <Form
                className="border-primary-700 rounded-xl border p-4"
                onSubmit={() => void principalForm.handleSubmit()}
            >
                <Heading level={3}>Create automation account</Heading>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <principalForm.Field name="id">
                        {(field) => (
                            <FormField
                                disabled={action.busy}
                                error={firstFormFieldError(field.state.meta.errors)}
                                description="A stable ID used by scripts and configuration."
                                label="Account ID"
                            >
                                <Input
                                    autoCapitalize="none"
                                    className="mt-2"
                                    name={field.name}
                                    onBlur={field.handleBlur}
                                    onChange={(event) =>
                                        field.handleChange(event.currentTarget.value)
                                    }
                                    placeholder="openclaw-heartbeat"
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
                                label="Account name"
                            >
                                <Input
                                    className="mt-2"
                                    name={field.name}
                                    onBlur={field.handleBlur}
                                    onChange={(event) =>
                                        field.handleChange(event.currentTarget.value)
                                    }
                                    placeholder="OpenClaw heartbeat"
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
                                label="First token name"
                            >
                                <Input
                                    className="mt-2"
                                    name={field.name}
                                    onBlur={field.handleBlur}
                                    onChange={(event) =>
                                        field.handleChange(event.currentTarget.value)
                                    }
                                    placeholder="Daily heartbeat"
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
                            className="mt-4 w-full sm:w-auto"
                            disabled={!canSubmit}
                            type="submit"
                        >
                            <Icon icon={Plus} size="sm" tone="inherit" />
                            Create account and token
                        </Button>
                    )}
                </principalForm.Subscribe>
            </Form>
            {principals.isPending && (
                <LoadingState
                    className="mt-5"
                    label="Loading automation accounts…"
                    size="sm"
                />
            )}
            {principals.error !== null && !principals.isFetchNextPageError && (
                <Alert
                    action={
                        <Button
                            onClick={() => void principals.refetch()}
                            size="sm"
                            variant="secondary"
                        >
                            <Icon icon={RefreshCw} size="sm" tone="inherit" />
                            Try again
                        </Button>
                    }
                    className="mt-5"
                    message={dashboardBrowserFailureMessage(principals.error)}
                />
            )}
            {principals.data !== undefined &&
                principals.data.pages.every((page) => page.principals.length === 0) && (
                    <EmptyState
                        className="mt-5"
                        description="Create an automation account above when a script or service needs Dashboard access."
                        icon={Bot}
                        title="No automation accounts"
                    />
                )}
            {principals.data !== undefined && (
                <VirtualizedList
                    className="mt-5"
                    estimateSize={() => 320}
                    getKey={(principal) => principal.id}
                    itemClassName="pb-4"
                    items={principals.data.pages.flatMap((page) => page.principals)}
                    label="Automation accounts"
                    preserveItemState
                    pagination={{
                        ...(principalPageError === null
                            ? {}
                            : {
                                  error: dashboardBrowserFailureMessage(
                                      principalPageError
                                  ),
                              }),
                        hasMore: principals.hasNextPage,
                        loading: principals.isFetchingNextPage,
                        loadingLabel: "Loading older automation accounts…",
                        onLoadMore: () => void principals.fetchNextPage(),
                    }}
                    renderItem={(principal) => (
                        <AutomationPrincipalCard principal={principal} />
                    )}
                />
            )}
        </SecuritySection>
    );
}
