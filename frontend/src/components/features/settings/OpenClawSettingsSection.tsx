import { Download, Loader2, RefreshCw, Server } from "lucide-react";

import { Alert } from "../../ui/Alert";
import { Button } from "../../ui/Button";
import { LoadingState } from "../../ui/LoadingState";
import { Modal } from "../../ui/Modal";
import { AgentAccessSection } from "./AgentAccessSection";
import { ChannelSection } from "./ChannelSection";
import { HeartbeatSection } from "./HeartbeatSection";
import { ModelSection } from "./ModelSection";
import { SecuritySection } from "./SecuritySection";
import { SessionSection } from "./SessionSection";
import { SkillsSection } from "./SkillsSection";
import { ToolSection } from "./ToolSection";
import { useOpenClawSettingsController } from "./useOpenClawSettingsController";

export function OpenClawSettingsSection() {
    const controller = useOpenClawSettingsController();
    if (controller.isLoading) return <LoadingState size="lg" />;

    return (
        <>
            <div className="flex justify-end">
                <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
                    <Button
                        disabled={controller.backupPending}
                        onClick={() => void controller.handleBackup()}
                        variant="secondary"
                    >
                        {controller.backupPending ? (
                            <>
                                <Loader2 className="size-4 animate-spin" />
                                Backing up...
                            </>
                        ) : (
                            <>
                                <Download className="size-4" />
                                Backup
                            </>
                        )}
                    </Button>
                    <Button onClick={controller.openRestartModal} variant="danger">
                        <RefreshCw className="size-4" />
                        Restart
                    </Button>
                </div>
            </div>

            {controller.error && (
                <Alert variant="error">
                    {controller.error}
                    <Button
                        className="ml-auto"
                        onClick={controller.dismissError}
                        size="sm"
                        variant="ghost"
                    >
                        ×
                    </Button>
                </Alert>
            )}
            {controller.success && <Alert variant="success">{controller.success}</Alert>}

            <ModelSection
                key={`models:${controller.config?.__hash || "empty"}`}
                {...controller.modelInfo}
                onSave={controller.handleModelSave}
                saving={controller.updatePending}
            />
            <ChannelSection
                key={`channels:${controller.config?.__hash || "empty"}`}
                channels={controller.channels}
                onSave={controller.handleChannelsSave}
                saving={controller.updatePending}
            />
            <ToolSection
                key={`tools:${controller.config?.__hash || "empty"}`}
                {...controller.toolInfo}
                onSave={controller.handleToolSave}
                saving={controller.updatePending}
            />
            <SecuritySection {...controller.securityInfo} />
            <SessionSection
                idleMinutes={controller.sessionInfo.idleMinutes}
                onSave={controller.handleSessionSave}
                saving={controller.updatePending}
            />
            <HeartbeatSection
                {...controller.heartbeatInfo}
                onSave={controller.handleHeartbeatSave}
                saving={controller.updatePending}
            />
            <SkillsSection
                onToggle={(skillName, isEnabled) =>
                    void controller.handleSkillToggle(skillName, isEnabled)
                }
                skills={controller.skills}
            />
            <AgentAccessSection
                key={`agents:${controller.config?.__hash || "empty"}`}
                agents={controller.config?.agents?.list || []}
                onSave={controller.handleAgentAccessSave}
                saving={controller.updatePending}
            />

            <div className="rounded-lg border border-primary-700 bg-primary-800/50 p-3 sm:p-4">
                <div className="mb-2 flex items-center gap-2">
                    <Server className="size-4 text-accent-400" />
                    <h3 className="text-sm font-medium text-primary-200">Server</h3>
                </div>
                <div className="space-y-2">
                    <ServerInfoRow
                        label="Version"
                        value={controller.serverInfo.version}
                    />
                    <ServerInfoRow
                        label="Config hash"
                        value={controller.serverInfo.configHash}
                    />
                    <ServerInfoRow
                        label="Last touched"
                        value={controller.serverInfo.lastTouched}
                    />
                </div>
            </div>

            <Modal
                isOpen={controller.showRestartModal}
                onClose={controller.closeRestartModal}
                size="sm"
                title="Restart Gateway"
            >
                <div className="space-y-4">
                    <p className="text-sm text-primary-300">
                        Are you sure you want to restart the gateway? This will
                        temporarily disconnect all sessions.
                    </p>
                    <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
                        <Button
                            disabled={controller.restartPending}
                            onClick={controller.closeRestartModal}
                            variant="secondary"
                        >
                            Cancel
                        </Button>
                        <Button
                            disabled={controller.restartPending}
                            onClick={() => void controller.handleRestart()}
                            variant="danger"
                        >
                            {controller.restartPending ? (
                                <>
                                    <Loader2 className="size-4 animate-spin" />
                                    Restarting...
                                </>
                            ) : (
                                "Restart"
                            )}
                        </Button>
                    </div>
                </div>
            </Modal>
        </>
    );
}

function ServerInfoRow({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex flex-col gap-1 py-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <span className="text-sm text-primary-400">{label}</span>
            <span className="font-mono text-sm break-all text-primary-100 sm:text-right">
                {value}
            </span>
        </div>
    );
}
