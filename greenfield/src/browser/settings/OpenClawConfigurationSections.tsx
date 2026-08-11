import { useId, useState, type ReactNode } from "react";
import * as v from "valibot";

import {
    type OpenClawConfigurationSnapshot,
    type OpenClawConfigurationUpdate,
    updateOpenClawConfigurationInputSchema,
} from "../../contracts/openClawSettings.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { Form } from "../ui/Form.tsx";
import { FormField } from "../ui/FormField.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Input } from "../ui/Input.tsx";
import { Select, type SelectOption } from "../ui/Select.tsx";
import { Switch } from "../ui/Switch.tsx";
import { Text } from "../ui/Text.tsx";
import { Textarea } from "../ui/Textarea.tsx";

interface OpenClawConfigurationSectionsProps {
    readonly busy: boolean;
    readonly configuration: OpenClawConfigurationSnapshot;
    readonly disabled: boolean;
    readonly onSave: (update: OpenClawConfigurationUpdate) => Promise<void>;
}

interface SettingsSectionProps {
    readonly children: ReactNode;
    readonly description: string;
    readonly id: string;
    readonly title: string;
}

function SettingsSection({ children, description, id, title }: SettingsSectionProps) {
    return (
        <Card aria-labelledby={id}>
            <Heading id={id} level={2}>
                {title}
            </Heading>
            <Text className="mt-2" tone="muted">
                {description}
            </Text>
            <div className="mt-5">{children}</div>
        </Card>
    );
}

function focusFirstInvalid(formId: string): void {
    setTimeout(() => {
        document
            .querySelector<HTMLElement>(`[id="${formId}"]`)
            ?.querySelector<HTMLElement>("[data-invalid]:is(button, input, textarea)")
            ?.focus();
    }, 0);
}

function reviewedUpdate(
    baseHash: string,
    update: unknown
): OpenClawConfigurationUpdate | undefined {
    const parsed = v.safeParse(
        updateOpenClawConfigurationInputSchema,
        {
            baseHash,
            confirmation: "apply-reviewed-settings",
            update,
        },
        { abortEarly: true }
    );
    return parsed.success ? parsed.output.update : undefined;
}

function optionalTrimmed(value: string): string | undefined {
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
}

function positiveInteger(value: string): number | undefined {
    if (!/^[1-9]\d*$/u.test(value)) return;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function arraysMatch(left: readonly string[], right: readonly string[]): boolean {
    return (
        left.length === right.length &&
        left.every((value, index) => value === right[index])
    );
}

interface SectionSaveButtonProps {
    readonly busy: boolean;
    readonly disabled: boolean;
    readonly label: string;
}

function SectionSaveButton({ busy, disabled, label }: SectionSaveButtonProps) {
    return (
        <div className="mt-5 flex justify-end">
            <Button busy={busy} busyLabel="Saving…" disabled={disabled} type="submit">
                {label}
            </Button>
        </div>
    );
}

interface ModelsFormProps {
    readonly baseHash: string;
    readonly busy: boolean;
    readonly disabled: boolean;
    readonly models: OpenClawConfigurationSnapshot["models"];
    readonly onSave: OpenClawConfigurationSectionsProps["onSave"];
}

function ModelsForm({ baseHash, busy, disabled, models, onSave }: ModelsFormProps) {
    const formId = useId();
    const [primary, setPrimary] = useState(models.primary ?? "");
    const [fallbacksText, setFallbacksText] = useState(models.fallbacks.join("\n"));
    const [error, setError] = useState<string>();
    const fallbacks = fallbacksText
        .split(/\r?\n/u)
        .map((fallback) => fallback.trim())
        .filter((fallback) => fallback.length > 0);
    const update = reviewedUpdate(baseHash, {
        fallbacks,
        primary: primary.trim(),
        section: "models",
    });
    const changed =
        primary.trim() !== (models.primary ?? "") ||
        !arraysMatch(fallbacks, models.fallbacks);

    async function submit(): Promise<void> {
        if (update === undefined) {
            setError(
                "Enter a primary model and up to 16 unique fallback model IDs, one per line."
            );
            focusFirstInvalid(formId);
            return;
        }
        setError(undefined);
        await onSave(update);
    }

    return (
        <SettingsSection
            description="Choose the default model and the ordered fallback chain used by OpenClaw. Secret provider credentials are never shown here."
            id="openclaw-model-settings"
            title="Models"
        >
            <Form className="grid gap-4" id={formId} onSubmit={submit}>
                <FormField disabled={disabled} error={error} label="Primary model">
                    <Input
                        className="mt-2 font-mono"
                        disabled={disabled}
                        maxLength={200}
                        onChange={(event) => setPrimary(event.currentTarget.value)}
                        placeholder="provider/model"
                        required
                        value={primary}
                    />
                </FormField>
                <FormField
                    description="One model ID per line, in failover order."
                    disabled={disabled}
                    label="Fallback models"
                >
                    <Textarea
                        className="mt-2 min-h-32 font-mono text-sm"
                        disabled={disabled}
                        maxLength={3216}
                        onChange={(event) => setFallbacksText(event.currentTarget.value)}
                        placeholder="provider/fallback-one"
                        value={fallbacksText}
                    />
                </FormField>
                <SectionSaveButton
                    busy={busy}
                    disabled={disabled || !changed}
                    label="Save model settings"
                />
            </Form>
        </SettingsSection>
    );
}

interface ChannelsFormProps {
    readonly baseHash: string;
    readonly busy: boolean;
    readonly channels: OpenClawConfigurationSnapshot["channels"];
    readonly disabled: boolean;
    readonly onSave: OpenClawConfigurationSectionsProps["onSave"];
}

function ChannelsForm({ baseHash, busy, channels, disabled, onSave }: ChannelsFormProps) {
    const [draft, setDraft] = useState(channels);
    const [error, setError] = useState<string>();
    const update = reviewedUpdate(baseHash, { channels: draft, section: "channels" });
    const changed = draft.some(
        (channel, index) => channel.enabled !== channels[index]?.enabled
    );

    async function submit(): Promise<void> {
        if (update === undefined) {
            setError("The reviewed OpenClaw channel selection is invalid.");
            return;
        }
        setError(undefined);
        await onSave(update);
    }

    return (
        <SettingsSection
            description="Enable or disable only channels already present in the reviewed OpenClaw configuration. Channel credentials and allowlists stay hidden."
            id="openclaw-channel-settings"
            title="Channels"
        >
            <Form onSubmit={submit}>
                <Alert className="mb-4" message={error} />
                {draft.length === 0 ? (
                    <Text tone="muted">No configured channels were reported.</Text>
                ) : (
                    <div className="divide-primary-700 divide-y">
                        {draft.map((channel) => (
                            <Switch
                                checked={channel.enabled}
                                className="py-3 first:pt-0 last:pb-0"
                                description="Changes only this channel's enabled state."
                                disabled={disabled}
                                key={channel.id}
                                label={channel.id}
                                onChange={(enabled) =>
                                    setDraft((current) =>
                                        current.map((candidate) =>
                                            candidate.id === channel.id
                                                ? { ...candidate, enabled }
                                                : candidate
                                        )
                                    )
                                }
                            />
                        ))}
                    </div>
                )}
                <SectionSaveButton
                    busy={busy}
                    disabled={disabled || !changed || draft.length === 0}
                    label="Save channel settings"
                />
            </Form>
        </SettingsSection>
    );
}

type ExecAsk = OpenClawConfigurationSnapshot["tools"]["execAsk"];
type ExecSecurity = OpenClawConfigurationSnapshot["tools"]["execSecurity"];
type VisibilitySelection =
    | "default"
    | NonNullable<OpenClawConfigurationSnapshot["tools"]["sessionsVisibility"]>;

const execAskOptions = Object.freeze([
    { label: "Off", value: "off" },
    { label: "Ask when not allowlisted", value: "on-miss" },
    { label: "Always ask", value: "always" },
] satisfies readonly SelectOption<ExecAsk>[]);
const execSecurityOptions = Object.freeze([
    { label: "Allowlist", value: "allowlist" },
    { label: "Deny", value: "deny" },
    { label: "Full", value: "full" },
] satisfies readonly SelectOption<ExecSecurity>[]);
const visibilityOptions = Object.freeze([
    { label: "OpenClaw default", value: "default" },
    { label: "Current agent", value: "agent" },
    { label: "All sessions", value: "all" },
    { label: "Current session", value: "self" },
    { label: "Session tree", value: "tree" },
] satisfies readonly SelectOption<VisibilitySelection>[]);

function toolsMatch(
    left: OpenClawConfigurationSnapshot["tools"],
    right: OpenClawConfigurationSnapshot["tools"]
): boolean {
    return (
        left.agentToAgentEnabled === right.agentToAgentEnabled &&
        left.elevatedEnabled === right.elevatedEnabled &&
        left.execAsk === right.execAsk &&
        left.execSecurity === right.execSecurity &&
        left.profile === right.profile &&
        left.sessionsVisibility === right.sessionsVisibility &&
        left.webFetchEnabled === right.webFetchEnabled &&
        left.webSearchEnabled === right.webSearchEnabled &&
        left.webSearchProvider === right.webSearchProvider
    );
}

interface ToolsFormProps {
    readonly baseHash: string;
    readonly busy: boolean;
    readonly disabled: boolean;
    readonly onSave: OpenClawConfigurationSectionsProps["onSave"];
    readonly tools: OpenClawConfigurationSnapshot["tools"];
}

function ToolsForm({ baseHash, busy, disabled, onSave, tools }: ToolsFormProps) {
    const formId = useId();
    const [draft, setDraft] = useState(tools);
    const [error, setError] = useState<string>();
    const normalized = {
        ...draft,
        profile: optionalTrimmed(draft.profile ?? ""),
        webSearchProvider: optionalTrimmed(draft.webSearchProvider ?? ""),
    };
    const update = reviewedUpdate(baseHash, {
        section: "tools",
        settings: normalized,
    });
    const changed = !toolsMatch(normalized, tools);

    async function submit(): Promise<void> {
        if (update === undefined) {
            setError("Review the tool profile and provider values, then try again.");
            focusFirstInvalid(formId);
            return;
        }
        setError(undefined);
        await onSave(update);
    }

    return (
        <SettingsSection
            description="Control only the reviewed OpenClaw tool switches and policy labels. Command allowlists, credentials, and executable content are not exposed."
            id="openclaw-tool-settings"
            title="Tools"
        >
            <Form className="grid gap-5" id={formId} onSubmit={submit}>
                <Alert message={error} />
                <div className="grid gap-4 lg:grid-cols-2">
                    <Switch
                        checked={draft.agentToAgentEnabled}
                        description="Allow agents to address other configured agents."
                        disabled={disabled}
                        label="Agent-to-agent tools"
                        onChange={(agentToAgentEnabled) =>
                            setDraft((current) => ({
                                ...current,
                                agentToAgentEnabled,
                            }))
                        }
                    />
                    <Switch
                        checked={draft.elevatedEnabled}
                        description="Allow OpenClaw's elevated tool capability where separately authorized."
                        disabled={disabled}
                        label="Elevated tools"
                        onChange={(elevatedEnabled) =>
                            setDraft((current) => ({ ...current, elevatedEnabled }))
                        }
                    />
                    <Switch
                        checked={draft.webFetchEnabled}
                        description="Allow the configured web-fetch tool."
                        disabled={disabled}
                        label="Web fetch"
                        onChange={(webFetchEnabled) =>
                            setDraft((current) => ({ ...current, webFetchEnabled }))
                        }
                    />
                    <Switch
                        checked={draft.webSearchEnabled}
                        description="Allow the configured web-search provider."
                        disabled={disabled}
                        label="Web search"
                        onChange={(webSearchEnabled) =>
                            setDraft((current) => ({ ...current, webSearchEnabled }))
                        }
                    />
                </div>
                <div className="grid gap-4 lg:grid-cols-2">
                    <FormField disabled={disabled} label="Exec approval policy">
                        <Select
                            className="mt-2"
                            disabled={disabled}
                            onChange={(execAsk) =>
                                setDraft((current) => ({ ...current, execAsk }))
                            }
                            options={execAskOptions}
                            value={draft.execAsk}
                        />
                    </FormField>
                    <FormField disabled={disabled} label="Exec security mode">
                        <Select
                            className="mt-2"
                            disabled={disabled}
                            onChange={(execSecurity) =>
                                setDraft((current) => ({ ...current, execSecurity }))
                            }
                            options={execSecurityOptions}
                            value={draft.execSecurity}
                        />
                    </FormField>
                    <FormField
                        description="Leave blank to keep OpenClaw's default profile."
                        disabled={disabled}
                        label="Tool profile"
                    >
                        <Input
                            className="mt-2 font-mono"
                            disabled={disabled}
                            maxLength={64}
                            onChange={(event) =>
                                setDraft((current) => ({
                                    ...current,
                                    profile: event.currentTarget.value,
                                }))
                            }
                            value={draft.profile ?? ""}
                        />
                    </FormField>
                    <FormField disabled={disabled} label="Session visibility">
                        <Select
                            className="mt-2"
                            disabled={disabled}
                            onChange={(selection) =>
                                setDraft((current) => ({
                                    ...current,
                                    sessionsVisibility:
                                        selection === "default" ? undefined : selection,
                                }))
                            }
                            options={visibilityOptions}
                            value={draft.sessionsVisibility ?? "default"}
                        />
                    </FormField>
                    <FormField
                        description="Leave blank to use OpenClaw's default provider."
                        disabled={disabled || !draft.webSearchEnabled}
                        label="Web-search provider"
                    >
                        <Input
                            className="mt-2 font-mono"
                            disabled={disabled || !draft.webSearchEnabled}
                            maxLength={64}
                            onChange={(event) =>
                                setDraft((current) => ({
                                    ...current,
                                    webSearchProvider: event.currentTarget.value,
                                }))
                            }
                            value={draft.webSearchProvider ?? ""}
                        />
                    </FormField>
                </div>
                <SectionSaveButton
                    busy={busy}
                    disabled={disabled || !changed}
                    label="Save tool settings"
                />
            </Form>
        </SettingsSection>
    );
}

interface SessionResetFormProps {
    readonly baseHash: string;
    readonly busy: boolean;
    readonly disabled: boolean;
    readonly onSave: OpenClawConfigurationSectionsProps["onSave"];
    readonly sessionReset: OpenClawConfigurationSnapshot["sessionReset"];
}

function SessionResetForm({
    baseHash,
    busy,
    disabled,
    onSave,
    sessionReset,
}: SessionResetFormProps) {
    const formId = useId();
    const initial = sessionReset.idleMinutes?.toString() ?? "";
    const [idleMinutes, setIdleMinutes] = useState(initial);
    const [error, setError] = useState<string>();
    const parsedMinutes = positiveInteger(idleMinutes);
    const update = reviewedUpdate(baseHash, {
        idleMinutes: parsedMinutes,
        section: "session-reset",
    });

    async function submit(): Promise<void> {
        if (update === undefined) {
            setError("Enter a whole number from 1 to 10,080 minutes.");
            focusFirstInvalid(formId);
            return;
        }
        setError(undefined);
        await onSave(update);
    }

    return (
        <SettingsSection
            description="Set how long an inactive OpenClaw session may remain before its configured reset boundary."
            id="openclaw-session-reset-settings"
            title="Session reset"
        >
            <Form id={formId} onSubmit={submit}>
                <FormField
                    disabled={disabled}
                    error={error}
                    label="Idle timeout (minutes)"
                >
                    <Input
                        className="mt-2"
                        disabled={disabled}
                        inputMode="numeric"
                        max="10080"
                        min="1"
                        onChange={(event) => setIdleMinutes(event.currentTarget.value)}
                        required
                        step="1"
                        type="number"
                        value={idleMinutes}
                    />
                </FormField>
                <SectionSaveButton
                    busy={busy}
                    disabled={disabled || idleMinutes === initial}
                    label="Save session reset"
                />
            </Form>
        </SettingsSection>
    );
}

interface HeartbeatFormProps {
    readonly baseHash: string;
    readonly busy: boolean;
    readonly disabled: boolean;
    readonly heartbeat: OpenClawConfigurationSnapshot["heartbeat"];
    readonly onSave: OpenClawConfigurationSectionsProps["onSave"];
}

function HeartbeatForm({
    baseHash,
    busy,
    disabled,
    heartbeat,
    onSave,
}: HeartbeatFormProps) {
    const formId = useId();
    const initialInterval = heartbeat.everySeconds?.toString() ?? "";
    const initialTarget = heartbeat.target ?? "";
    const [everySeconds, setEverySeconds] = useState(initialInterval);
    const [target, setTarget] = useState(initialTarget);
    const [error, setError] = useState<string>();
    const parsedSeconds = positiveInteger(everySeconds);
    const normalizedTarget = optionalTrimmed(target) ?? null;
    const update = reviewedUpdate(baseHash, {
        everySeconds: parsedSeconds,
        section: "heartbeat",
        target: normalizedTarget,
    });

    async function submit(): Promise<void> {
        if (update === undefined) {
            setError(
                "Enter a whole interval from 10 to 86,400 seconds and a valid optional target."
            );
            focusFirstInvalid(formId);
            return;
        }
        setError(undefined);
        await onSave(update);
    }

    return (
        <SettingsSection
            description="Configure OpenClaw's heartbeat cadence and optional reviewed target label. Heartbeat instructions and payloads are not exposed."
            id="openclaw-heartbeat-settings"
            title="Heartbeat"
        >
            <Form
                className="grid gap-4 sm:grid-cols-2 sm:items-start"
                id={formId}
                onSubmit={submit}
            >
                <FormField disabled={disabled} error={error} label="Interval (seconds)">
                    <Input
                        className="mt-2"
                        disabled={disabled}
                        inputMode="numeric"
                        max="86400"
                        min="10"
                        onChange={(event) => setEverySeconds(event.currentTarget.value)}
                        required
                        step="1"
                        type="number"
                        value={everySeconds}
                    />
                </FormField>
                <FormField
                    description="Leave blank to remove the explicit target."
                    disabled={disabled}
                    label="Target"
                >
                    <Input
                        className="mt-2 font-mono"
                        disabled={disabled}
                        maxLength={128}
                        onChange={(event) => setTarget(event.currentTarget.value)}
                        value={target}
                    />
                </FormField>
                <div className="sm:col-span-2">
                    <SectionSaveButton
                        busy={busy}
                        disabled={
                            disabled ||
                            (everySeconds === initialInterval && target === initialTarget)
                        }
                        label="Save heartbeat settings"
                    />
                </div>
            </Form>
        </SettingsSection>
    );
}

function SecuritySummary({
    security,
}: {
    readonly security: OpenClawConfigurationSnapshot["security"];
}) {
    const rows = [
        ["Authentication profiles", security.authProfileCount.toString()],
        ["Owner allowlist entries", security.ownerAllowFromCount.toString()],
        ["Command restart", security.commandRestartEnabled ? "Enabled" : "Disabled"],
        ["Redaction mode", security.redactionMode ?? "OpenClaw default"],
    ] as const;
    return (
        <SettingsSection
            description="Secret-free counts and security modes reported by OpenClaw. Credential values and allowlist members remain hidden."
            id="openclaw-security-summary"
            title="Security summary"
        >
            <dl className="grid gap-3 sm:grid-cols-2">
                {rows.map(([label, value]) => (
                    <div
                        className="border-primary-700 bg-primary-900/45 rounded-lg border p-3"
                        key={label}
                    >
                        <dt className="text-primary-400 text-xs font-medium tracking-wide uppercase">
                            {label}
                        </dt>
                        <dd className="text-primary-100 mt-1 text-sm font-medium wrap-anywhere">
                            {value}
                        </dd>
                    </div>
                ))}
            </dl>
        </SettingsSection>
    );
}

function ConfigurationSummary({
    configuration,
}: {
    readonly configuration: OpenClawConfigurationSnapshot;
}) {
    return (
        <Card aria-labelledby="openclaw-configuration-status">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <Heading id="openclaw-configuration-status" level={2}>
                        Configuration status
                    </Heading>
                    <Text className="mt-2" tone="muted">
                        This is a bounded, secret-free projection. Raw configuration and
                        secret values are not available on this page.
                    </Text>
                </div>
                <Badge variant={configuration.valid ? "success" : "warning"}>
                    {configuration.valid ? "Valid" : "Needs attention"}
                </Badge>
            </div>
            <dl className="mt-5 grid gap-3 sm:grid-cols-3">
                <div>
                    <dt className="text-primary-400 text-xs">Reported issues</dt>
                    <dd className="text-primary-100 mt-1 text-sm font-medium">
                        {configuration.issueCount}
                    </dd>
                </div>
                <div>
                    <dt className="text-primary-400 text-xs">Last touched version</dt>
                    <dd className="text-primary-100 mt-1 text-sm wrap-anywhere">
                        {configuration.lastTouchedVersion ?? "Not reported"}
                    </dd>
                </div>
                <div>
                    <dt className="text-primary-400 text-xs">Last touched</dt>
                    <dd className="text-primary-100 mt-1 text-sm wrap-anywhere">
                        {configuration.lastTouchedAt ?? "Not reported"}
                    </dd>
                </div>
            </dl>
        </Card>
    );
}

/** @returns Exact reviewed OpenClaw configuration summaries and section editors. */
export function OpenClawConfigurationSections({
    busy,
    configuration,
    disabled,
    onSave,
}: OpenClawConfigurationSectionsProps) {
    const controlsDisabled = disabled || !configuration.valid;
    return (
        <div className="grid gap-6">
            <ConfigurationSummary configuration={configuration} />
            {!configuration.valid && (
                <Alert
                    focusOnError={false}
                    message="OpenClaw reports invalid configuration. Reviewed settings controls stay disabled until the configuration is repaired outside this narrow editor."
                />
            )}
            <ModelsForm
                baseHash={configuration.hash}
                busy={busy}
                disabled={controlsDisabled}
                models={configuration.models}
                onSave={onSave}
            />
            <ChannelsForm
                baseHash={configuration.hash}
                busy={busy}
                channels={configuration.channels}
                disabled={controlsDisabled}
                onSave={onSave}
            />
            <ToolsForm
                baseHash={configuration.hash}
                busy={busy}
                disabled={controlsDisabled}
                onSave={onSave}
                tools={configuration.tools}
            />
            <SecuritySummary security={configuration.security} />
            <SessionResetForm
                baseHash={configuration.hash}
                busy={busy}
                disabled={controlsDisabled}
                onSave={onSave}
                sessionReset={configuration.sessionReset}
            />
            <HeartbeatForm
                baseHash={configuration.hash}
                busy={busy}
                disabled={controlsDisabled}
                heartbeat={configuration.heartbeat}
                onSave={onSave}
            />
        </div>
    );
}
