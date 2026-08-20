import { useForm } from "@tanstack/react-form";
import {
    infiniteQueryOptions,
    useInfiniteQuery,
    useQueryClient,
} from "@tanstack/react-query";
import { KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";

import type { AuthStatus } from "../../contracts/auth.ts";
import {
    automationCredentialSettingsSchema,
    type AutomationCredentialCursor,
    type AutomationCredentialSummary,
    type AutomationPrincipalSummary,
    type ListAutomationCredentialsResult,
} from "../../contracts/automationSecurity.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { authStatusQueryKey } from "../auth/authQueries.ts";
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
import { VirtualizedList } from "../ui/VirtualizedList.tsx";
import { useAutomationTokenPresenter } from "./automationTokenPresentationContextValue.ts";
import { revealIssuedAutomationToken } from "./issuedAutomationToken.ts";
import {
    automationCredentialsQueryKey,
    refreshSecurityQueries,
} from "./securityQueries.ts";

interface AutomationCredentialPanelProps {
    readonly principal: AutomationPrincipalSummary;
}

function isCredentialUsable(
    credential: AutomationCredentialSummary,
    checkedAtMs: number
): boolean {
    return (
        credential.revokedAtMs === undefined &&
        (credential.expiresAtMs === undefined || credential.expiresAtMs > checkedAtMs)
    );
}

function credentialStatus(
    credential: AutomationCredentialSummary,
    checkedAtMs: number
): string {
    if (credential.revokedAtMs !== undefined) {
        return `revoked ${formatDashboardDateTime(credential.revokedAtMs)}`;
    }
    if (credential.expiresAtMs !== undefined && credential.expiresAtMs <= checkedAtMs) {
        return `expired ${formatDashboardDateTime(credential.expiresAtMs)}`;
    }
    return "active";
}

/**
 * Manages the credential lifecycle for one automation principal.
 * @returns A paginated credential inventory and create/rotate/revoke controls.
 */
export function AutomationCredentialPanel({ principal }: AutomationCredentialPanelProps) {
    const action = useExclusiveDashboardAction();
    const automationTokenPresenter = useAutomationTokenPresenter();
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
    const credentialPageError = credentials.data === undefined ? null : credentials.error;

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
                const authentication =
                    queryClient.getQueryData<AuthStatus>(authStatusQueryKey);
                if (authentication?.state !== "authenticated") {
                    throw new TypeError(
                        "Authenticated automation-token owner unavailable"
                    );
                }
                const ownerUserId = authentication.user.id;
                const created = await client.mutation(
                    "automationSecurity.createCredential",
                    {
                        credential: value,
                        expectedAuthorizationVersion: principal.authorizationVersion,
                        principalId: principal.id,
                    }
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
                formApi.setFieldValue("label", "");
            }
        },
        validators: { onSubmit: automationCredentialSettingsSchema },
    });

    async function rotateCredential(credentialId: string, label: string) {
        const result = await action.run(async () => {
            const authentication =
                queryClient.getQueryData<AuthStatus>(authStatusQueryKey);
            if (authentication?.state !== "authenticated") {
                throw new TypeError("Authenticated automation-token owner unavailable");
            }
            const ownerUserId = authentication.user.id;
            const rotated = await client.mutation("automationSecurity.rotateCredential", {
                credentialId,
                expectedAuthorizationVersion: principal.authorizationVersion,
                principalId: principal.id,
                replacement: { label },
            });
            await revealIssuedAutomationToken(
                rotated.token,
                (token) => {
                    automationTokenPresenter.present(ownerUserId, token);
                },
                () => refreshSecurityQueries(queryClient)
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
                <LoadingState label="Loading access tokens…" size="sm" />
            )}
            {credentials.isError && credentials.data === undefined && (
                <Alert
                    action={
                        <Button
                            onClick={() => void credentials.refetch()}
                            size="sm"
                            variant="secondary"
                        >
                            <Icon icon={RefreshCw} size="sm" tone="inherit" />
                            Try again
                        </Button>
                    }
                    message={dashboardBrowserFailureMessage(credentials.error)}
                />
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
                                    description="Create an access token for this automation account."
                                    icon={KeyRound}
                                    title="No access tokens"
                                />
                            )}
                        {credentials.isSuccess && (
                            <VirtualizedList
                                estimateSize={() => 176}
                                getKey={(credential) => credential.id}
                                itemClassName="pb-3"
                                items={credentials.data.pages.flatMap(
                                    (page) => page.credentials
                                )}
                                label={`Access tokens for ${principal.label}`}
                                pagination={{
                                    ...(credentialPageError === null
                                        ? {}
                                        : {
                                              error: dashboardBrowserFailureMessage(
                                                  credentialPageError
                                              ),
                                          }),
                                    hasMore: credentials.hasNextPage,
                                    loading: credentials.isFetchingNextPage,
                                    loadingLabel: "Loading older access tokens…",
                                    onLoadMore: () => void credentials.fetchNextPage(),
                                }}
                                renderItem={(credential) => {
                                    const usable = isCredentialUsable(
                                        credential,
                                        credentials.dataUpdatedAt
                                    );
                                    return (
                                        <div className="border-primary-700 rounded-lg border p-3 text-sm">
                                            <p className="text-primary-100 font-medium">
                                                {credential.label}
                                            </p>
                                            <p className="text-primary-400 mt-1">
                                                Created{" "}
                                                {formatDashboardDateTime(
                                                    credential.createdAtMs
                                                )}{" "}
                                                ·{" "}
                                                {credentialStatus(
                                                    credential,
                                                    credentials.dataUpdatedAt
                                                )}
                                            </p>
                                            {!principal.disabled && usable && (
                                                <div className="mt-3 flex flex-wrap gap-2">
                                                    <Button
                                                        aria-label={`Create replacement access token for ${credential.label}`}
                                                        busy={action.busy}
                                                        busyLabel="Creating…"
                                                        disabled={
                                                            credentialLabel.length === 0
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
                                                        Create replacement
                                                    </Button>
                                                    <Button
                                                        aria-label={`Revoke access token ${credential.label}`}
                                                        busy={action.busy}
                                                        busyLabel="Revoking…"
                                                        onClick={() =>
                                                            setCredentialConfirmation({
                                                                credentialId:
                                                                    credential.id,
                                                                label: credential.label,
                                                            })
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
                                        </div>
                                    );
                                }}
                            />
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
                                            description="This name is used for a new token or a replacement created above."
                                            error={firstFormFieldError(
                                                field.state.meta.errors
                                            )}
                                            label="New token name"
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
                                                placeholder="August rotation"
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
                                    Create access token
                                </Button>
                            </Form>
                        )}
                    </>
                )}
            </credentialForm.Subscribe>
            <ConfirmModal
                busy={action.busy}
                confirmLabel="Revoke access token"
                danger
                description={`Revoke “${credentialConfirmation?.label ?? ""}”. Any script using this token will lose access immediately.`}
                onCancel={() => setCredentialConfirmation(undefined)}
                onConfirm={() => void confirmCredentialRevocation()}
                open={credentialConfirmation !== undefined}
                title="Revoke access token?"
            />
        </div>
    );
}
