import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

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
    const [activeAgentId, setActiveAgentId] = useState("");
    const configuration = configurationQuery.data;
    const configurationMutationBusy = mutations.configuration.isPending;
    const configurationWritesSupported =
        configuration !== undefined &&
        !configuration.includesPresent &&
        configuration.modelNormalizationState === "clean";
    const configurationControlsDisabled =
        mutations.isBusy ||
        mutations.reconciliationRequired ||
        configurationQuery.isFetching ||
        configurationQuery.isError ||
        configuration === undefined ||
        !configuration.valid ||
        !configurationWritesSupported;
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
                baseRevisionHash: current.revisionHash,
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
                baseRevisionHash: current.revisionHash,
                enabled,
                skillKey: skill.key,
            })
            .catch(() => {});
    }

    return (
        <div>
            <PageHeader
                description="Review and change only the bounded, secret-free OpenClaw settings supported by this Dashboard. Configuration writes are root-hash-fenced with a revision preflight; skill changes update one freshly verified leaf on the latest configuration. Every change is audited and requires recent multi-factor authentication."
                eyebrow="Settings"
                title="OpenClaw settings"
            />
            <div className="mt-6 grid gap-3">
                {configuration?.valid && (
                    <Alert
                        focusOnError={false}
                        message="Saving a reviewed setting makes OpenClaw rewrite the touched JSON5 config source; comments may be removed and existing formatting may be changed."
                        variant="info"
                    />
                )}
                {configuration?.valid && configuration.includesPresent && (
                    <Alert
                        focusOnError={false}
                        message="Configuration changes are locked because this OpenClaw configuration uses included files. Edit the owning source in OpenClaw so an included value cannot change between review and persistence."
                        variant="info"
                    />
                )}
                {configuration?.valid &&
                    configuration.modelNormalizationState !== "clean" && (
                        <Alert
                            focusOnError={false}
                            message={
                                configuration.modelNormalizationState === "pending"
                                    ? "Configuration changes are locked because OpenClaw would canonicalize existing model references outside the requested setting. Save those references canonically in OpenClaw before editing here."
                                    : "Configuration changes are locked because the existing model-reference normalization state could not be verified safely. Review and save the configuration in OpenClaw before editing here."
                            }
                            variant="info"
                        />
                    )}
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
                            key={`${configuration.hash}:${configuration.revisionHash}:${configuration.modelNormalizationState}:${mutations.snapshotGeneration}`}
                        >
                            <OpenClawConfigurationSections
                                busy={configurationMutationBusy}
                                configuration={configuration}
                                disabled={configurationControlsDisabled}
                                onSave={saveConfiguration}
                            />
                            {configuration.valid && (
                                <div className="mt-8">
                                    <OpenClawAgentAccessSection
                                        activeAgentId={activeAgentId}
                                        agents={configuration.agentAccess}
                                        busy={configurationMutationBusy}
                                        disabled={configurationControlsDisabled}
                                        onSave={saveConfiguration}
                                        onSelectAgent={setActiveAgentId}
                                        truncated={configuration.agentAccessTruncated}
                                    />
                                </div>
                            )}
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
