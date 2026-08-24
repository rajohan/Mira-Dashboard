import { Users } from "lucide-react";
import { useState } from "react";

import type { ListOpenClawSkillsResult } from "../../contracts/openClawSettings.ts";
import { cn } from "../lib/classNames.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { ExpandableCard } from "../ui/ExpandableCard.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Input } from "../ui/Input.tsx";
import { Switch } from "../ui/Switch.tsx";

type OpenClawSkill = ListOpenClawSkillsResult["skills"][number];
type SkillSourceFilter = "all" | "builtin" | "extra" | "workspace";
type SkillStatusFilter = "all" | "disabled" | "enabled";

const sourceLabels = Object.freeze({
    builtin: "Built-in",
    extra: "Extra",
    workspace: "Workspace",
} satisfies Readonly<Record<Exclude<SkillSourceFilter, "all">, string>>);

function sourceFilterFor(skill: OpenClawSkill): Exclude<SkillSourceFilter, "all"> {
    if (skill.source === "openclaw-bundled") return "builtin";
    if (
        skill.source === "openclaw-workspace" ||
        skill.source === "agents-skills-personal" ||
        skill.source === "agents-skills-project"
    ) {
        return "workspace";
    }
    return "extra";
}

interface OpenClawSkillsSectionProps {
    readonly busy: boolean;
    readonly enabled: boolean;
    readonly onToggle: (skill: OpenClawSkill, enabled: boolean) => Promise<void>;
    readonly result: ListOpenClawSkillsResult;
}

/** @returns Path-free OpenClaw skill inventory with exact enabled-only controls. */
export function OpenClawSkillsSection({
    busy,
    enabled,
    onToggle,
    result,
}: OpenClawSkillsSectionProps) {
    const [search, setSearch] = useState("");
    const [sourceFilter, setSourceFilter] = useState<SkillSourceFilter>("all");
    const [statusFilter, setStatusFilter] = useState<SkillStatusFilter>("all");
    const controlsDisabled = busy || !enabled;
    const normalizedSearch = search.trim().toLocaleLowerCase();
    const filteredSkills = result.skills.filter((skill) => {
        if (statusFilter === "enabled" && !skill.enabled) return false;
        if (statusFilter === "disabled" && skill.enabled) return false;
        if (sourceFilter !== "all" && sourceFilterFor(skill) !== sourceFilter) {
            return false;
        }
        return (
            normalizedSearch.length === 0 ||
            `${skill.name} ${skill.description ?? ""}`
                .toLocaleLowerCase()
                .includes(normalizedSearch)
        );
    });
    const enabledCount = result.skills.filter((skill) => skill.enabled).length;
    const sourceCounts = { builtin: 0, extra: 0, workspace: 0 };
    for (const skill of result.skills) sourceCounts[sourceFilterFor(skill)] += 1;

    return (
        <section aria-busy={busy || undefined} aria-label="Skills">
            <ExpandableCard
                compact
                icon={Users}
                title={
                    <Heading id="openclaw-skills-heading" level={2} size="subsection">
                        Skills
                    </Heading>
                }
                trailing={busy ? <Badge variant="info">Saving skill…</Badge> : undefined}
            >
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
                    <div className="mt-4 space-y-4">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                            <div className="text-primary-400 text-sm">
                                {enabledCount}/{result.skills.length} enabled
                            </div>
                            <Input
                                aria-label="Search skills"
                                className="lg:w-80"
                                onChange={(event) => setSearch(event.target.value)}
                                placeholder="Search skills..."
                                type="search"
                                value={search}
                            />
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {(["all", "enabled", "disabled"] as const).map((filter) => (
                                <button
                                    aria-pressed={statusFilter === filter}
                                    className={cn(
                                        "rounded-full border px-3 py-1 text-sm capitalize",
                                        statusFilter === filter
                                            ? "border-accent-500 bg-accent-500/10 text-accent-200"
                                            : "border-primary-700 text-primary-400 hover:border-primary-600"
                                    )}
                                    key={filter}
                                    onClick={() => setStatusFilter(filter)}
                                    type="button"
                                >
                                    {filter}
                                </button>
                            ))}
                        </div>
                        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                            {(["all", "workspace", "builtin", "extra"] as const).map(
                                (filter) => (
                                    <button
                                        aria-pressed={sourceFilter === filter}
                                        className={cn(
                                            "rounded-xl border px-4 py-3 text-left transition",
                                            sourceFilter === filter
                                                ? "border-accent-500 bg-accent-500/10 text-accent-200"
                                                : "border-primary-700 bg-primary-900/40 text-primary-300 hover:border-primary-600"
                                        )}
                                        key={filter}
                                        onClick={() => setSourceFilter(filter)}
                                        type="button"
                                    >
                                        <div className="font-medium">
                                            {filter === "all"
                                                ? "All"
                                                : sourceLabels[filter]}
                                        </div>
                                        <div className="mt-1 text-xs opacity-75">
                                            {filter === "all"
                                                ? result.skills.length
                                                : sourceCounts[filter]}{" "}
                                            skills
                                        </div>
                                    </button>
                                )
                            )}
                        </div>
                        {filteredSkills.length === 0 ? (
                            <p className="text-primary-400 text-sm">No skills found</p>
                        ) : (
                            <ul className="space-y-2">
                                {filteredSkills.map((skill) => (
                                    <li
                                        className="border-primary-800 bg-primary-900/40 grid gap-3 rounded-lg border px-3 py-2 sm:grid-cols-[minmax(0,1fr)_2.75rem] sm:items-center"
                                        key={skill.key}
                                    >
                                        <div className="min-w-0">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <span className="text-primary-200 text-sm font-medium wrap-anywhere sm:truncate">
                                                    {skill.name}
                                                </span>
                                                <Badge>
                                                    {sourceLabels[sourceFilterFor(skill)]}
                                                </Badge>
                                                {!skill.installed && (
                                                    <Badge variant="warning">
                                                        Configured only
                                                    </Badge>
                                                )}
                                            </div>
                                            {skill.description !== undefined && (
                                                <p className="text-primary-400 mt-0.5 line-clamp-2 text-xs">
                                                    {skill.description}
                                                </p>
                                            )}
                                        </div>
                                        <Switch
                                            checked={skill.enabled}
                                            className="w-11 justify-self-end"
                                            disabled={controlsDisabled}
                                            hideLabel
                                            label={`Enable ${skill.name}`}
                                            onChange={(nextEnabled) =>
                                                void onToggle(skill, nextEnabled)
                                            }
                                        />
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                )}
            </ExpandableCard>
        </section>
    );
}
