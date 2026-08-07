import { useForm } from "@tanstack/react-form";
import {
    infiniteQueryOptions,
    useInfiniteQuery,
    useQueryClient,
} from "@tanstack/react-query";
import { KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";

import {
    automationCredentialSettingsSchema,
    type AutomationCredentialCursor,
    type AutomationPrincipalSummary,
    type ListAutomationCredentialsResult,
} from "../../contracts/automationSecurity.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { useExclusiveDashboardAction } from "../hooks/useExclusiveDashboardAction.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { ConfirmModal } from "../ui/ConfirmModal.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Form } from "../ui/Form.tsx";
import { firstFormFieldError } from "../ui/formErrors.ts";
import { FormField } from "../ui/FormField.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Input } from "../ui/Input.tsx";
import { LoadingState } from "../ui/LoadingState.tsx";
import { revealIssuedAutomationToken } from "./issuedAutomationToken.ts";
import {
    automationCredentialsQueryKey,
    refreshSecurityQueries,
} from "./securityQueries.ts";

interface AutomationCredentialPanelProps {
    readonly onIssuedToken: (token: string) => void;
    readonly principal: AutomationPrincipalSummary;
}

/**
 * Manages the credential lifecycle for one automation principal.
 * @returns A paginated credential inventory and create/rotate/revoke controls.
 */
export function AutomationCredentialPanel({
    onIssuedToken,
    principal,
}: AutomationCredentialPanelProps) {
    const action = useExclusiveDashboardAction();
    const client = useDashboardTrpcClient();
    const queryClient = useQueryClient();
    const [credentialConfirmation, setCredentialConfirmation] = useState<
        Readonly<{ credentialId: string; label: string }> | undefined
    >();
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

    async function complete(operation: () => Promise<unknown>): Promise<void> {
        await action.run(async () => {
            await operation();
            await refreshSecurityQueries(queryClient);
        });
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
                await revealIssuedAutomationToken(created.token, onIssuedToken, () =>
                    refreshSecurityQueries(queryClient)
                );
            });
            if (result.status === "success") {
                formApi.setFieldValue("label", "");
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
            await revealIssuedAutomationToken(rotated.token, onIssuedToken, () =>
                refreshSecurityQueries(queryClient)
            );
        });
        if (result.status === "success") {
            credentialForm.setFieldValue("label", "");
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

    async function confirmCredentialRevocation() {
        const credential = credentialConfirmation;
        if (credential === undefined) return;
        try {
            await revokeCredential(credential.credentialId);
        } finally {
            setCredentialConfirmation(undefined);
        }
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
                                                            aria-label={`Stage replacement for ${credential.label}`}
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
                                                            aria-label={`Revoke credential ${credential.label}`}
                                                            busy={action.busy}
                                                            busyLabel="Revoking…"
                                                            onClick={() =>
                                                                setCredentialConfirmation(
                                                                    {
                                                                        credentialId:
                                                                            credential.id,
                                                                        label: credential.label,
                                                                    }
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
            <ConfirmModal
                busy={action.busy}
                confirmLabel="Revoke credential"
                danger
                description={`Revoke “${credentialConfirmation?.label ?? ""}”. Requests using its token will stop authenticating immediately.`}
                onCancel={() => setCredentialConfirmation(undefined)}
                onConfirm={() => void confirmCredentialRevocation()}
                open={credentialConfirmation !== undefined}
                title="Revoke automation credential?"
            />
        </div>
    );
}
