import { useForm } from "@tanstack/react-form";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fingerprint, KeyRound, LifeBuoy, ShieldCheck, Smartphone } from "lucide-react";
import {
    type ReactNode,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    useSyncExternalStore,
} from "react";

import {
    type AccountSecuritySummary,
    passwordReauthenticationInputSchema,
    recoveryStepUpInputSchema,
    totpStepUpInputSchema,
} from "../../contracts/accountSecurity.ts";
import type { AuthStatus } from "../../contracts/auth.ts";
import type { MultiFactorAuthenticationMethod } from "../../contracts/security.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { useObservedQueryData } from "../api/useObservedQueryState.ts";
import {
    authStatusCacheIdentity,
    authStatusQueryKey,
    holdAuthenticationStatusPublication,
    publishAuthenticationStatusIfCurrent,
} from "../auth/authQueries.ts";
import type { DashboardRouter } from "../router.tsx";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { Form } from "../ui/Form.tsx";
import { firstFormFieldError } from "../ui/formErrors.ts";
import { FormField } from "../ui/FormField.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Input } from "../ui/Input.tsx";
import { LoadingState } from "../ui/LoadingState.tsx";
import { Modal } from "../ui/Modal.tsx";
import { Text } from "../ui/Text.tsx";
import { accountSecuritySummaryQueryOptions } from "./securityQueries.ts";
import type { SecurityVerificationCoordinator } from "./securityVerificationCoordinator.ts";
import { useDashboardWebAuthnClient } from "./webauthn/webauthnContextValue.ts";

interface GlobalSecurityVerificationProps {
    readonly coordinator: SecurityVerificationCoordinator;
    readonly router: DashboardRouter;
}

interface PasswordProofFormProps {
    readonly busy: boolean;
    readonly onVerify: (password: string) => Promise<void>;
}

interface CodeProofFormProps {
    readonly busy: boolean;
    readonly method: "recovery" | "totp";
    readonly onChooseAnotherMethod: () => void;
    readonly onVerify: (code: string) => Promise<void>;
    readonly showMethodChooser: boolean;
}

type AuthenticationPublicationRelease = (reconciled?: boolean) => Promise<void>;

interface GenerationValue<TValue> {
    readonly generation: number;
    readonly value: TValue;
}

const maximumBrowserTimeoutMs = 2_147_483_647;
const doNothing = () => {};

function verificationFingerprint(
    identity: string,
    summary: AccountSecuritySummary
): string {
    const verification = summary.recentAuth.mfa;
    return verification.recent
        ? `${identity}:mfa:${verification.verifiedAtMs}:${verification.expiresAtMs}`
        : `${identity}:mfa:stale`;
}

async function waitForMutationCallbacks(queryClient: QueryClient): Promise<void> {
    if (queryClient.isMutating() === 0) return;
    await new Promise<void>((resolve) => {
        let unsubscribe = doNothing;
        const resolveWhenSettled = () => {
            if (queryClient.isMutating() !== 0) return;
            unsubscribe();
            resolve();
        };
        unsubscribe = queryClient.getMutationCache().subscribe(() => {
            queueMicrotask(resolveWhenSettled);
        });
        resolveWhenSettled();
    });
}

function PasswordProofForm({ busy, onVerify }: PasswordProofFormProps) {
    const form = useForm({
        defaultValues: { password: "" },
        onSubmit: async ({ formApi, value }) => {
            try {
                await onVerify(value.password);
            } finally {
                formApi.reset();
            }
        },
        validators: { onSubmit: passwordReauthenticationInputSchema },
    });

    return (
        <Form className="space-y-3" onSubmit={() => form.handleSubmit()}>
            <form.Field name="password">
                {(field) => (
                    <FormField
                        disabled={busy}
                        error={firstFormFieldError(field.state.meta.errors)}
                        label="Current password"
                    >
                        <Input
                            autoComplete="current-password"
                            className="mt-2"
                            data-autofocus
                            name={field.name}
                            onBlur={field.handleBlur}
                            onChange={(event) =>
                                field.handleChange(event.currentTarget.value)
                            }
                            placeholder="Enter your current password"
                            required
                            type="password"
                            value={field.state.value}
                        />
                    </FormField>
                )}
            </form.Field>
            <form.Subscribe
                selector={(state) => [state.canSubmit, state.isSubmitting] as const}
            >
                {([canSubmit, isSubmitting]) => (
                    <Button
                        busy={busy || isSubmitting}
                        busyLabel="Verifying…"
                        disabled={!canSubmit}
                        fullWidth
                        type="submit"
                    >
                        <Icon icon={KeyRound} size="sm" tone="inherit" />
                        Verify password
                    </Button>
                )}
            </form.Subscribe>
        </Form>
    );
}

function CodeProofForm({
    busy,
    method,
    onChooseAnotherMethod,
    onVerify,
    showMethodChooser,
}: CodeProofFormProps) {
    const validationSchema =
        method === "totp"
            ? totpStepUpInputSchema
            : (recoveryStepUpInputSchema as unknown as typeof totpStepUpInputSchema);
    const form = useForm({
        defaultValues: { code: "" },
        onSubmit: async ({ formApi, value }) => {
            try {
                await onVerify(value.code);
            } finally {
                formApi.reset();
            }
        },
        validators: { onSubmit: validationSchema },
    });
    const authenticator = method === "totp";

    return (
        <Form className="space-y-3" onSubmit={() => form.handleSubmit()}>
            <form.Field name="code">
                {(field) => (
                    <FormField
                        disabled={busy}
                        error={firstFormFieldError(field.state.meta.errors)}
                        label={authenticator ? "Authenticator code" : "Recovery code"}
                    >
                        <Input
                            autoComplete={authenticator ? "one-time-code" : "off"}
                            className="mt-2"
                            data-autofocus
                            inputMode={authenticator ? "numeric" : undefined}
                            name={field.name}
                            onBlur={field.handleBlur}
                            onChange={(event) =>
                                field.handleChange(event.currentTarget.value)
                            }
                            placeholder={
                                authenticator
                                    ? "Enter the 6-digit code"
                                    : "Paste a recovery code"
                            }
                            required
                            spellCheck={false}
                            type={authenticator ? "text" : "password"}
                            value={field.state.value}
                        />
                    </FormField>
                )}
            </form.Field>
            <form.Subscribe
                selector={(state) => [state.canSubmit, state.isSubmitting] as const}
            >
                {([canSubmit, isSubmitting]) => (
                    <Button
                        busy={busy || isSubmitting}
                        busyLabel="Verifying…"
                        disabled={!canSubmit}
                        fullWidth
                        type="submit"
                    >
                        <Icon
                            icon={authenticator ? Smartphone : LifeBuoy}
                            size="sm"
                            tone="inherit"
                        />
                        {authenticator ? "Verify authenticator" : "Use recovery code"}
                    </Button>
                )}
            </form.Subscribe>
            {showMethodChooser && (
                <Button
                    disabled={busy}
                    fullWidth
                    onClick={onChooseAnotherMethod}
                    variant="ghost"
                >
                    Choose another method
                </Button>
            )}
        </Form>
    );
}

function EnrollmentPrompt({ coordinator, router }: GlobalSecurityVerificationProps) {
    return (
        <div className="space-y-4">
            <Text>
                Register a security key or authenticator app before changing sensitive
                configuration or running privileged operations.
            </Text>
            <Button
                fullWidth
                onClick={() => {
                    coordinator.dismiss();
                    void router.navigate({
                        search: { view: "dashboard" },
                        to: "/settings",
                    });
                }}
            >
                <Icon icon={ShieldCheck} size="sm" tone="inherit" />
                Open Dashboard security settings
            </Button>
        </div>
    );
}

/**
 * Presents and reconciles the one application-wide recent-auth verification flow.
 * @returns The global security prompt, or nothing while no flow is active.
 */
export function GlobalSecurityVerification({
    coordinator,
    router,
}: GlobalSecurityVerificationProps) {
    const client = useDashboardTrpcClient();
    const queryClient = useQueryClient();
    const webAuthn = useDashboardWebAuthnClient();
    const authentication = useObservedQueryData<AuthStatus>(authStatusQueryKey);
    const authenticatedIdentity =
        authentication?.state === "authenticated"
            ? authStatusCacheIdentity(authentication)
            : undefined;
    const snapshot = useSyncExternalStore(
        coordinator.subscribe,
        coordinator.getSnapshot,
        coordinator.getSnapshot
    );
    const summary = useQuery({
        ...accountSecuritySummaryQueryOptions(client),
        enabled: authenticatedIdentity !== undefined,
    });
    const publicationHolds = useRef(new Map<number, AuthenticationPublicationRelease>());
    const reconciliationStatus = useRef(new Map<number, AuthStatus>());
    const reconciliationInFlight = useRef<number | undefined>(undefined);
    const queuedReconciliation = useRef<(() => Promise<void>) | undefined>(undefined);
    const dismissedVerificationFingerprint = useRef<string | undefined>(undefined);
    const [codeSelection, setCodeSelection] = useState<
        GenerationValue<"recovery" | "totp"> | undefined
    >(undefined);
    const [proofFailureState, setProofFailureState] = useState<
        GenerationValue<string> | undefined
    >(undefined);
    const [presenterActive, setPresenterActive] = useState(false);
    const [reconciliationBusy, setReconciliationBusy] = useState(false);
    const [reconciliationFailureState, setReconciliationFailureState] = useState<
        GenerationValue<string> | undefined
    >(undefined);
    const activeGeneration = snapshot.phase === "idle" ? undefined : snapshot.generation;
    const codeMethod =
        codeSelection?.generation === snapshot.generation
            ? codeSelection.value
            : undefined;
    const proofFailure =
        proofFailureState?.generation === snapshot.generation
            ? proofFailureState.value
            : undefined;
    const reconciliationFailure =
        reconciliationFailureState?.generation === snapshot.generation
            ? reconciliationFailureState.value
            : undefined;
    const protectedInteractionContinuing =
        snapshot.protectedInteraction &&
        (snapshot.phase === "replaying" ||
            snapshot.phase === "reconciling" ||
            snapshot.phase === "cache-reset");
    useEffect(() => {
        let mounted = true;
        const releasePresenter = coordinator.acquirePresenter();
        queueMicrotask(() => {
            if (mounted) setPresenterActive(releasePresenter !== undefined);
        });
        return () => {
            mounted = false;
            releasePresenter?.();
        };
    }, [coordinator]);

    useLayoutEffect(() => {
        coordinator.setAuthenticationIdentity(authenticatedIdentity);
    }, [authenticatedIdentity, coordinator]);

    useLayoutEffect(() => {
        if (activeGeneration === undefined) return;
        const holds = publicationHolds.current;
        const release = holdAuthenticationStatusPublication(queryClient);
        holds.set(activeGeneration, release);
        return () => {
            setTimeout(() => {
                if (holds.get(activeGeneration) === release) {
                    holds.delete(activeGeneration);
                }
                void release(false);
            }, 0);
        };
    }, [activeGeneration, queryClient]);

    useEffect(() => {
        if (snapshot.phase === "idle") reconciliationStatus.current.clear();
    }, [snapshot.phase]);

    const verificationGenerationFingerprint =
        authenticatedIdentity !== undefined && summary.data !== undefined
            ? verificationFingerprint(authenticatedIdentity, summary.data)
            : undefined;

    useEffect(() => {
        if (
            !presenterActive ||
            authenticatedIdentity === undefined ||
            summary.data === undefined ||
            !summary.data.mfa.enabled ||
            snapshot.phase !== "idle"
        ) {
            return;
        }
        const fingerprint = verificationFingerprint(authenticatedIdentity, summary.data);
        if (dismissedVerificationFingerprint.current === fingerprint) return;

        const prompt = () => {
            if (dismissedVerificationFingerprint.current === fingerprint) return;
            if (coordinator.getSnapshot().phase !== "idle") return;
            coordinator.promptProactively("step_up_required", authenticatedIdentity);
        };
        const verification = summary.data.recentAuth.mfa;
        if (!verification.recent || verification.remainingMs === 0) {
            prompt();
            return;
        }
        const timeout = setTimeout(
            prompt,
            Math.min(verification.remainingMs + 1, maximumBrowserTimeoutMs)
        );
        return () => clearTimeout(timeout);
    }, [
        authenticatedIdentity,
        coordinator,
        presenterActive,
        snapshot.phase,
        summary.data,
    ]);

    async function releasePublicationHold(
        generation: number,
        reconciled: boolean
    ): Promise<void> {
        const release = publicationHolds.current.get(generation);
        if (release === undefined) return;
        publicationHolds.current.delete(generation);
        await release(reconciled);
    }

    async function reconcileAuthenticationStatus(generation: number): Promise<void> {
        if (reconciliationInFlight.current !== undefined) {
            const currentSnapshot = coordinator.getSnapshot();
            if (
                reconciliationInFlight.current !== generation &&
                currentSnapshot.generation === generation &&
                currentSnapshot.phase === "reconciling"
            ) {
                queuedReconciliation.current = () =>
                    reconcileAuthenticationStatus(generation);
            }
            return;
        }
        reconciliationInFlight.current = generation;
        setReconciliationBusy(true);
        setReconciliationFailureState(undefined);
        try {
            let status = reconciliationStatus.current.get(generation);
            const currentSnapshot = coordinator.getSnapshot();
            if (currentSnapshot.generation !== generation) return;
            if (currentSnapshot.phase === "reconciling") {
                status ??= await client.query("auth.status", {});
                if (
                    coordinator.getSnapshot().generation !== generation ||
                    coordinator.getSnapshot().phase !== "reconciling"
                ) {
                    return;
                }
                reconciliationStatus.current.set(generation, status);
                if (!coordinator.beginCacheReset(authStatusCacheIdentity(status))) return;
            }
            if (
                coordinator.getSnapshot().phase !== "cache-reset" ||
                status === undefined
            ) {
                return;
            }
            const statusPublished = await publishAuthenticationStatusIfCurrent(
                queryClient,
                status,
                () => {
                    const publicationSnapshot = coordinator.getSnapshot();
                    return (
                        publicationSnapshot.generation === generation &&
                        publicationSnapshot.phase === "cache-reset"
                    );
                },
                { bypassPublicationHold: true }
            );
            const publicationSnapshot = coordinator.getSnapshot();
            if (
                !statusPublished ||
                publicationSnapshot.generation !== generation ||
                publicationSnapshot.phase !== "cache-reset"
            ) {
                reconciliationStatus.current.delete(generation);
                await releasePublicationHold(generation, false);
                return;
            }
            const completion = await coordinator.waitForCacheReset();
            if (completion !== "completed") {
                await releasePublicationHold(generation, false);
                return;
            }
            if (verificationGenerationFingerprint !== undefined) {
                dismissedVerificationFingerprint.current =
                    verificationGenerationFingerprint;
            }
            reconciliationStatus.current.delete(generation);
            await releasePublicationHold(generation, true);
        } catch (error: unknown) {
            if (coordinator.getSnapshot().generation === generation) {
                setReconciliationFailureState({
                    generation,
                    value: dashboardBrowserFailureMessage(error),
                });
            }
        } finally {
            reconciliationInFlight.current = undefined;
            const reconcileQueuedGeneration = queuedReconciliation.current;
            queuedReconciliation.current = undefined;
            if (reconcileQueuedGeneration === undefined) {
                setReconciliationBusy(false);
            } else {
                void reconcileQueuedGeneration();
            }
        }
    }

    async function runProof(operation: () => Promise<unknown>): Promise<void> {
        const generation = coordinator.getSnapshot().generation;
        if (!coordinator.beginProof()) return;
        setProofFailureState(undefined);
        setReconciliationFailureState(undefined);
        try {
            await operation();
        } catch (error: unknown) {
            if (coordinator.getSnapshot().generation === generation) {
                setProofFailureState({
                    generation,
                    value: dashboardBrowserFailureMessage(error),
                });
                coordinator.failProof();
            }
            return;
        }

        const replayDrained = await coordinator.completeProof();
        if (!replayDrained || coordinator.getSnapshot().generation !== generation) return;
        await waitForMutationCallbacks(queryClient);
        if (
            coordinator.getSnapshot().generation === generation &&
            coordinator.getSnapshot().phase === "reconciling"
        ) {
            await reconcileAuthenticationStatus(generation);
        }
    }

    function dismiss(): void {
        if (snapshot.phase !== "prompting") return;
        if (verificationGenerationFingerprint !== undefined) {
            dismissedVerificationFingerprint.current = verificationGenerationFingerprint;
        }
        setCodeSelection(undefined);
        setProofFailureState(undefined);
        coordinator.dismiss();
    }

    function renderMfaProof(summary: AccountSecuritySummary): ReactNode {
        const methods: readonly MultiFactorAuthenticationMethod[] = summary.mfa.methods;
        const showMethodChooser = methods.length > 1;
        if (codeMethod !== undefined) {
            return (
                <CodeProofForm
                    busy={snapshot.phase !== "prompting"}
                    key={codeMethod}
                    method={codeMethod}
                    onChooseAnotherMethod={() => {
                        setCodeSelection(undefined);
                        setProofFailureState(undefined);
                    }}
                    onVerify={(code) =>
                        runProof(() =>
                            codeMethod === "totp"
                                ? client.mutation("accountSecurity.stepUpTotp", { code })
                                : client.mutation("accountSecurity.stepUpRecovery", {
                                      code,
                                  })
                        )
                    }
                    showMethodChooser={showMethodChooser}
                />
            );
        }
        return (
            <div className="space-y-3">
                {methods.includes("webauthn") && (
                    <Button
                        fullWidth
                        onClick={() => {
                            void runProof(async () => {
                                const challenge = await client.mutation(
                                    "accountSecurity.beginWebAuthnStepUp",
                                    {}
                                );
                                const response = await webAuthn.authenticate(
                                    challenge.options
                                );
                                await client.mutation("accountSecurity.stepUpWebAuthn", {
                                    response,
                                });
                            });
                        }}
                    >
                        <Icon icon={Fingerprint} size="sm" tone="inherit" />
                        Use security key
                    </Button>
                )}
                {methods.includes("totp") && (
                    <Button
                        fullWidth
                        onClick={() =>
                            setCodeSelection({
                                generation: snapshot.generation,
                                value: "totp",
                            })
                        }
                        variant={methods.includes("webauthn") ? "secondary" : "primary"}
                    >
                        <Icon icon={Smartphone} size="sm" tone="inherit" />
                        Use authenticator app
                    </Button>
                )}
                {methods.includes("recovery") && (
                    <Button
                        fullWidth
                        onClick={() =>
                            setCodeSelection({
                                generation: snapshot.generation,
                                value: "recovery",
                            })
                        }
                        variant="ghost"
                    >
                        <Icon icon={LifeBuoy} size="sm" tone="inherit" />
                        Use recovery code
                    </Button>
                )}
            </div>
        );
    }

    let title = "Verify your session";
    let description =
        "Confirm with a recently registered second factor. Verification remains valid for a short period.";
    if (snapshot.reason === "mfa_enrollment_required") {
        title = "Protect privileged actions";
        description =
            "Multi-factor authentication is required before this action can continue.";
    } else if (summary.data?.mfa.enabled === false) {
        title = "Verify current password";
        description =
            "Confirm your current Dashboard password. Verification remains valid for a short period.";
    }

    let content: ReactNode;
    if (snapshot.reason === "mfa_enrollment_required") {
        content = <EnrollmentPrompt coordinator={coordinator} router={router} />;
    } else if (snapshot.phase === "replaying") {
        content = <LoadingState label="Retrying the protected action…" size="sm" />;
    } else if (snapshot.phase === "cache-reset" || snapshot.phase === "reconciling") {
        content = reconciliationFailure ? (
            <div className="space-y-3">
                <Alert message={reconciliationFailure} />
                <Button
                    busy={reconciliationBusy}
                    busyLabel="Refreshing secure session…"
                    fullWidth
                    onClick={() =>
                        void reconcileAuthenticationStatus(snapshot.generation)
                    }
                >
                    Retry secure session refresh
                </Button>
            </div>
        ) : (
            <LoadingState label="Refreshing secure session…" size="sm" />
        );
    } else if (summary.isPending) {
        content = <LoadingState label="Loading verification methods…" size="sm" />;
    } else if (summary.isError) {
        content = (
            <div className="space-y-3">
                <Alert message={dashboardBrowserFailureMessage(summary.error)} />
                <Button
                    busy={summary.isFetching}
                    busyLabel="Loading verification methods…"
                    fullWidth
                    onClick={() => void summary.refetch()}
                >
                    Try again
                </Button>
            </div>
        );
    } else if (summary.data.mfa.enabled) {
        content = (
            <div className="space-y-3">
                <Alert message={proofFailure} />
                {renderMfaProof(summary.data)}
            </div>
        );
    } else {
        content = (
            <div className="space-y-3">
                <Alert message={proofFailure} />
                <PasswordProofForm
                    busy={snapshot.phase !== "prompting"}
                    onVerify={(password) =>
                        runProof(() =>
                            client.mutation("accountSecurity.reauthenticatePassword", {
                                password,
                            })
                        )
                    }
                />
            </div>
        );
    }

    return (
        <Modal
            description={description}
            dismissible={snapshot.phase === "prompting"}
            onClose={dismiss}
            open={
                presenterActive &&
                snapshot.phase !== "idle" &&
                !protectedInteractionContinuing
            }
            size="sm"
            title={title}
        >
            {content}
        </Modal>
    );
}
