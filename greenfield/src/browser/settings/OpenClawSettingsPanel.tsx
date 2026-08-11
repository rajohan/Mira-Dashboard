import { useQuery } from "@tanstack/react-query";

import type {
    ListOpenClawSkillsResult,
    OpenClawConfigurationUpdate,
} from "../../contracts/openClawSettings.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { LoadingState } from "../ui/LoadingState.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { OpenClawAgentAccessSection } from "./OpenClawAgentAccessSection.tsx";
import { OpenClawConfigurationSections } from "./OpenClawConfigurationSections.tsx";
import { useOpenClawSettingsMutations } from "./openClawSettingsMutations.ts";
import {
    openClawConfigurationQueryOptions,
    openClawSkillsQueryOptions,
} from "./openClawSettingsQueries.ts";
import { OpenClawSkillsSection } from "./OpenClawSkillsSection.tsx";

type OpenClawSkill = ListOpenClawSkillsResult["skills"][number];

interface QueryFailureProps {
    readonly busy: boolean;
    readonly error: unknown;
    readonly label: string;
    readonly onRetry: () => void;
}

function QueryFailure({ busy, error, label, onRetry }: QueryFailureProps) {
    return (
        <div>
            <Alert
                focusOnError={false}
                message={`${label}: ${dashboardBrowserFailureMessage(error)}`}
            />
            <Button
                busy={busy}
                busyLabel="Refreshing…"
                className="mt-3"
                onClick={onRetry}
                variant="secondary"
            >
                Try again
            </Button>
        </div>
    );
}

/** @returns Independent secret-free OpenClaw configuration and skill settings. */
export function OpenClawSettingsPanel() {
    const client = useDashboardTrpcClient();
    const configurationQuery = useQuery(openClawConfigurationQueryOptions(client));
    const skillsQuery = useQuery(openClawSkillsQueryOptions(client));
    const mutations = useOpenClawSettingsMutations();
    const configuration = configurationQuery.data;
    const configurationMutationBusy = mutations.configuration.isPending;
    const configurationControlsDisabled =
        mutations.isBusy ||
        mutations.reconciliationRequired ||
        configurationQuery.isFetching ||
        configurationQuery.isError ||
        configuration === undefined ||
        !configuration.valid;
    const skillControlsEnabled =
        configuration !== undefined &&
        configuration.valid &&
        !configurationQuery.isFetching &&
        !configurationQuery.isError &&
        !skillsQuery.isFetching &&
        !skillsQuery.isError &&
        !mutations.reconciliationRequired;

    async function saveConfiguration(update: OpenClawConfigurationUpdate): Promise<void> {
        const current = configurationQuery.data;
        if (current === undefined || !current.valid || configurationControlsDisabled) {
            return;
        }
        await mutations.configuration
            .mutateAsync({
                baseHash: current.hash,
                confirmation: "apply-reviewed-settings",
                update,
            })
            .catch(() => {});
    }

    async function toggleSkill(skill: OpenClawSkill, enabled: boolean): Promise<void> {
        const current = configurationQuery.data;
        if (current === undefined || !skillControlsEnabled || mutations.isBusy) {
            return;
        }
        await mutations.skill
            .mutateAsync({
                baseHash: current.hash,
                enabled,
                skillKey: skill.key,
            })
            .catch(() => {});
    }

    return (
        <div>
            <PageHeader
                description="Review and change only the bounded, secret-free OpenClaw settings supported by this Dashboard. Configuration writes are hash-fenced; skill changes are freshly verified. Every change is audited and requires recent multi-factor authentication."
                eyebrow="Settings"
                title="OpenClaw settings"
            />
            <div className="mt-6 grid gap-3">
                <Alert
                    dismissLabel="Dismiss settings error"
                    message={mutations.error}
                    onDismiss={mutations.clearError}
                />
                <Alert
                    dismissLabel="Dismiss settings confirmation"
                    message={mutations.notice}
                    onDismiss={mutations.clearNotice}
                    variant="success"
                />
                {mutations.reconciliationRequired && (
                    <div>
                        <Button
                            busy={mutations.reconciliationBusy}
                            busyLabel="Refreshing…"
                            onClick={() => void mutations.reconcile()}
                            variant="secondary"
                        >
                            Refresh current OpenClaw status
                        </Button>
                    </div>
                )}
            </div>

            <div className="mt-8 grid gap-8">
                <section aria-label="OpenClaw configuration">
                    {configurationQuery.isPending && (
                        <LoadingState label="Loading OpenClaw configuration…" />
                    )}
                    {configurationQuery.isError && configuration === undefined && (
                        <QueryFailure
                            busy={configurationQuery.isFetching}
                            error={configurationQuery.error}
                            label="OpenClaw configuration is unavailable"
                            onRetry={() => void configurationQuery.refetch()}
                        />
                    )}
                    {configurationQuery.isError && configuration !== undefined && (
                        <QueryFailure
                            busy={configurationQuery.isFetching}
                            error={configurationQuery.error}
                            label="Current OpenClaw configuration could not be refreshed"
                            onRetry={() => void configurationQuery.refetch()}
                        />
                    )}
                    {configuration !== undefined && (
                        <div
                            className={configurationQuery.isError ? "mt-6" : undefined}
                            key={`${configuration.hash}:${mutations.snapshotGeneration}`}
                        >
                            <OpenClawConfigurationSections
                                busy={configurationMutationBusy}
                                configuration={configuration}
                                disabled={configurationControlsDisabled}
                                onSave={saveConfiguration}
                            />
                            <div className="mt-8">
                                <OpenClawAgentAccessSection
                                    agents={configuration.agentAccess}
                                    busy={configurationMutationBusy}
                                    disabled={configurationControlsDisabled}
                                    onSave={saveConfiguration}
                                    truncated={configuration.agentAccessTruncated}
                                />
                            </div>
                        </div>
                    )}
                </section>

                <section aria-label="OpenClaw skills">
                    {skillsQuery.isPending && (
                        <LoadingState label="Loading OpenClaw skills…" />
                    )}
                    {skillsQuery.isError && skillsQuery.data === undefined && (
                        <QueryFailure
                            busy={skillsQuery.isFetching}
                            error={skillsQuery.error}
                            label="OpenClaw skills are unavailable"
                            onRetry={() => void skillsQuery.refetch()}
                        />
                    )}
                    {skillsQuery.isError && skillsQuery.data !== undefined && (
                        <QueryFailure
                            busy={skillsQuery.isFetching}
                            error={skillsQuery.error}
                            label="Current OpenClaw skills could not be refreshed"
                            onRetry={() => void skillsQuery.refetch()}
                        />
                    )}
                    {skillsQuery.data !== undefined && (
                        <div className={skillsQuery.isError ? "mt-6" : undefined}>
                            <OpenClawSkillsSection
                                baseHash={configuration?.hash}
                                busy={mutations.isBusy}
                                enabled={skillControlsEnabled}
                                onToggle={toggleSkill}
                                result={skillsQuery.data}
                            />
                        </div>
                    )}
                </section>
            </div>
        </div>
    );
}
