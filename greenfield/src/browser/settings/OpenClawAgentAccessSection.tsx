import type {
    OpenClawAgentAccessValue,
    OpenClawAgentToolAccessValue,
    OpenClawConfigurationUpdate,
} from "../../contracts/openClawSettings.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Card } from "../ui/Card.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { FormField } from "../ui/FormField.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Select, type SelectOption } from "../ui/Select.tsx";
import { Text } from "../ui/Text.tsx";

type AgentToolId = OpenClawAgentToolAccessValue["id"];
type AgentToolOverride = OpenClawAgentToolAccessValue["override"];

interface ToolPresentation {
    readonly description: string;
    readonly label: string;
}

const toolPresentation = Object.freeze({
    automations: {
        description: "Create and manage OpenClaw automations and schedules.",
        label: "Automations",
    },
    browser: {
        description: "Control browser pages and inspect web interfaces.",
        label: "Browser automation",
    },
    edit: { description: "Apply precise edits to existing files.", label: "File edit" },
    exec: { description: "Execute commands in an authorized runtime.", label: "Exec" },
    gateway: {
        description:
            "Read or change OpenClaw Gateway configuration and lifecycle controls, including restart-capable operations.",
        label: "Gateway",
    },
    image: { description: "Analyze images and screenshots.", label: "Image analysis" },
    image_generate: {
        description: "Generate or edit images through configured providers.",
        label: "Image generation",
    },
    memory_search: {
        description: "Search the agent's configured memory sources.",
        label: "Memory search",
    },
    message: {
        description: "Send messages through configured communication providers.",
        label: "Messaging",
    },
    music_generate: {
        description: "Generate music through configured providers.",
        label: "Music generation",
    },
    nodes: { description: "Interact with paired devices and nodes.", label: "Nodes" },
    read: { description: "Read files in authorized workspaces.", label: "File read" },
    sessions_history: {
        description: "Read sanitized history from visible sessions.",
        label: "Session history",
    },
    sessions_list: {
        description: "List sessions visible to the selected agent.",
        label: "Session list",
    },
    tts: { description: "Generate speech audio from text.", label: "Text to speech" },
    video_generate: {
        description: "Generate video through configured providers.",
        label: "Video generation",
    },
    web_fetch: { description: "Fetch bounded content from URLs.", label: "Web fetch" },
    web_search: {
        description: "Search the web through configured providers.",
        label: "Web search",
    },
    write: { description: "Create or overwrite authorized files.", label: "File write" },
} satisfies Readonly<Record<AgentToolId, ToolPresentation>>);

const overrideOptions = Object.freeze([
    {
        description: "Remove the agent-level allow or deny override.",
        label: "Inherit",
        value: "inherit",
    },
    {
        description:
            "Allow at the agent policy layer; stricter contextual policy may still deny it.",
        label: "Allow",
        value: "allow",
    },
    {
        description: "Deny at the agent policy layer.",
        label: "Deny",
        value: "deny",
    },
] satisfies readonly SelectOption<AgentToolOverride>[]);

interface OpenClawAgentAccessSectionProps {
    readonly activeAgentId: string;
    readonly agents: readonly OpenClawAgentAccessValue[];
    readonly busy: boolean;
    readonly disabled: boolean;
    readonly onSave: (update: OpenClawConfigurationUpdate) => Promise<void>;
    readonly onSelectAgent: (agentId: string) => void;
    readonly truncated: boolean;
}

function agentLabel({ id, name }: OpenClawAgentAccessValue): string {
    return name === undefined || name === id ? id : `${name} (${id})`;
}

/** @returns One-intent controls for exact agent-level core-tool overrides. */
export function OpenClawAgentAccessSection({
    activeAgentId,
    agents,
    busy,
    disabled,
    onSave,
    onSelectAgent,
    truncated,
}: OpenClawAgentAccessSectionProps) {
    const activeAgent = agents.find(({ id }) => id === activeAgentId) ?? agents[0];

    return (
        <Card
            aria-busy={busy || undefined}
            aria-labelledby="openclaw-agent-access-heading"
        >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <Heading id="openclaw-agent-access-heading" level={2}>
                        Agent access
                    </Heading>
                    <Text className="mt-2" tone="muted">
                        Set one exact agent-level override at a time. Inherited, provider,
                        sender, sandbox, and runtime policy can still further restrict a
                        tool, so Allow is not a guarantee of effective access.
                    </Text>
                </div>
                {busy ? (
                    <output>
                        <Badge variant="info">Saving override…</Badge>
                    </output>
                ) : (
                    <Badge variant="info">{agents.length} agents</Badge>
                )}
            </div>

            {truncated && (
                <Alert
                    className="mt-4"
                    focusOnError={false}
                    message="Some OpenClaw agent entries could not enter this canonical bounded view. Only the reported rows can be changed here."
                    variant="info"
                />
            )}

            {agents.length === 0 || activeAgent === undefined ? (
                <EmptyState
                    className="bg-primary-900/45 mt-5 border-0 shadow-none"
                    description="No canonical configured OpenClaw agents were available for this bounded view."
                    headingLevel={3}
                    title="No agent access reported"
                />
            ) : (
                <div className="mt-5 grid gap-5">
                    <FormField
                        className="max-w-md"
                        disabled={disabled || busy}
                        label="Selected OpenClaw agent"
                    >
                        <Select
                            className="mt-2"
                            disabled={disabled || busy}
                            onChange={onSelectAgent}
                            options={agents.map((agent) => ({
                                label: agentLabel(agent),
                                value: agent.id,
                            }))}
                            value={activeAgent.id}
                        />
                    </FormField>

                    <ul className="divide-primary-700 divide-y">
                        {activeAgent.tools.map((tool) => {
                            const presentation = toolPresentation[tool.id];
                            return (
                                <li
                                    className="grid gap-3 py-4 first:pt-0 last:pb-0 lg:grid-cols-[minmax(0,1fr)_15rem] lg:items-center"
                                    key={tool.id}
                                >
                                    <div className="min-w-0">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="text-primary-100 font-medium">
                                                {presentation.label}
                                            </span>
                                            {!tool.editable && (
                                                <Badge variant="warning">Locked</Badge>
                                            )}
                                        </div>
                                        <Text className="mt-1" tone="muted">
                                            {presentation.description}
                                            {!tool.editable &&
                                                " This policy uses an explicit or ambiguous rule that this narrow control will not rewrite."}
                                        </Text>
                                    </div>
                                    <Select
                                        ariaLabel={`${presentation.label} override for ${agentLabel(activeAgent)}`}
                                        disabled={disabled || busy || !tool.editable}
                                        onChange={(override) =>
                                            void onSave({
                                                agentId: activeAgent.id,
                                                override,
                                                section: "agent-tool-access",
                                                toolId: tool.id,
                                            })
                                        }
                                        options={overrideOptions}
                                        value={tool.override}
                                    />
                                </li>
                            );
                        })}
                    </ul>
                </div>
            )}
        </Card>
    );
}
