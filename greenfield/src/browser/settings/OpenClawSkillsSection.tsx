import type { ListOpenClawSkillsResult } from "../../contracts/openClawSettings.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Card } from "../ui/Card.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Switch } from "../ui/Switch.tsx";
import { Text } from "../ui/Text.tsx";

type OpenClawSkill = ListOpenClawSkillsResult["skills"][number];

interface OpenClawSkillsSectionProps {
    readonly baseHash: string | undefined;
    readonly busy: boolean;
    readonly enabled: boolean;
    readonly onToggle: (skill: OpenClawSkill, enabled: boolean) => Promise<void>;
    readonly result: ListOpenClawSkillsResult;
}

/** @returns Path-free OpenClaw skill inventory with exact enabled-only controls. */
export function OpenClawSkillsSection({
    baseHash,
    busy,
    enabled,
    onToggle,
    result,
}: OpenClawSkillsSectionProps) {
    const controlsDisabled = busy || !enabled || baseHash === undefined;
    return (
        <Card aria-labelledby="openclaw-skills-heading">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <Heading id="openclaw-skills-heading" level={2}>
                        Skills
                    </Heading>
                    <Text className="mt-2" tone="muted">
                        Enable or disable discovered and configured-only skills by their
                        exact OpenClaw key. Paths, environment values, API keys, install
                        controls, and skill source files are not exposed.
                    </Text>
                </div>
                <Badge variant="info">{result.skills.length} reported</Badge>
            </div>
            {result.truncated && (
                <Alert
                    className="mt-4"
                    focusOnError={false}
                    message="OpenClaw reported more skills than this bounded view can retain. Only the reviewed prefix is shown."
                    variant="info"
                />
            )}
            {result.skills.length === 0 ? (
                <EmptyState
                    className="bg-primary-900/45 mt-5 border-0 shadow-none"
                    description="No discovered or configured-only skills were reported for this workspace."
                    headingLevel={3}
                    title="No skills reported"
                />
            ) : (
                <ul className="divide-primary-700 mt-5 divide-y">
                    {result.skills.map((skill) => (
                        <li className="py-4 first:pt-0 last:pb-0" key={skill.key}>
                            <div className="mb-3 flex min-w-0 flex-wrap items-center gap-2">
                                <span className="text-primary-100 min-w-0 font-medium wrap-anywhere">
                                    {skill.name}
                                </span>
                                <Badge>{skill.source}</Badge>
                                {skill.bundled && <Badge variant="info">Bundled</Badge>}
                                {!skill.installed && (
                                    <Badge variant="warning">Configured only</Badge>
                                )}
                                {!skill.eligible && (
                                    <Badge variant="warning">Unavailable</Badge>
                                )}
                            </div>
                            <Switch
                                checked={skill.enabled}
                                description={
                                    skill.description ??
                                    "No bounded skill description was reported."
                                }
                                disabled={controlsDisabled}
                                label={`Enable ${skill.name}`}
                                onChange={(nextEnabled) =>
                                    void onToggle(skill, nextEnabled)
                                }
                            />
                        </li>
                    ))}
                </ul>
            )}
        </Card>
    );
}
