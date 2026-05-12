import { Users } from "lucide-react";
import { useState } from "react";

import { type Skill } from "../../../types/settings";
import { cn } from "../../../utils/cn";
import { ExpandableCard } from "../../ui/ExpandableCard";
import { Input } from "../../ui/Input";
import { Switch } from "../../ui/Switch";

/** Defines skill status filter. */
type SkillStatusFilter = "all" | "enabled" | "disabled";
/** Defines skill source filter. */
type SkillSourceFilter = "all" | "workspace" | "builtin" | "extra";

/** Provides props for skills section. */
interface SkillsSectionProps {
    skills: Skill[];
    onToggle: (skillName: string, enabled: boolean) => void;
}

const sourceLabels: Record<Exclude<SkillSourceFilter, "all">, string> = {
    workspace: "Workspace",
    builtin: "Built-in",
    extra: "Extra",
};

/** Renders the skills section UI. */
export function SkillsSection({ skills, onToggle }: SkillsSectionProps) {
    const [statusFilter, setStatusFilter] = useState<SkillStatusFilter>("all");
    const [sourceFilter, setSourceFilter] = useState<SkillSourceFilter>("all");
    const [search, setSearch] = useState("");

    const filteredSkills = skills.filter((skill) => {
        if (statusFilter === "enabled" && !skill.enabled) return false;
        if (statusFilter === "disabled" && skill.enabled) return false;
        if (sourceFilter !== "all" && skill.source !== sourceFilter) return false;
        if (search.trim()) {
            return `${skill.name} ${skill.description || ""}`
                .toLowerCase()
                .includes(search.toLowerCase());
        }
        return true;
    });

    const enabledCount = skills.filter((skill) => skill.enabled).length;
    const sourceCounts: Record<Exclude<SkillSourceFilter, "all">, number> = {
        workspace: 0,
        builtin: 0,
        extra: 0,
    };
    for (const skill of skills) {
        const source = skill.source || "extra";
        sourceCounts[source] += 1;
    }

    return (
        <ExpandableCard title="Skills" icon={Users}>
            <div className="space-y-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div className="text-primary-400 text-sm">
                        {enabledCount}/{skills.length} enabled
                    </div>
                    <Input
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="Search skills..."
                        className="lg:w-80"
                    />
                </div>

                <div className="flex flex-wrap gap-2">
                    {(["all", "enabled", "disabled"] as SkillStatusFilter[]).map(
                        (filter) => (
                            <button
                                key={filter}
                                type="button"
                                onClick={() => setStatusFilter(filter)}
                                className={cn(
                                    "rounded-full border px-3 py-1 text-sm capitalize",
                                    statusFilter === filter
                                        ? "border-accent-500 bg-accent-500/10 text-accent-200"
                                        : "border-primary-700 text-primary-400 hover:border-primary-600"
                                )}
                            >
                                {filter}
                            </button>
                        )
                    )}
                </div>

                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                    {(
                        ["all", "workspace", "builtin", "extra"] as SkillSourceFilter[]
                    ).map((filter) => (
                        <button
                            key={filter}
                            type="button"
                            onClick={() => setSourceFilter(filter)}
                            className={cn(
                                "rounded-xl border px-4 py-3 text-left transition",
                                sourceFilter === filter
                                    ? "border-accent-500 bg-accent-500/10 text-accent-200"
                                    : "border-primary-700 bg-primary-900/40 text-primary-300 hover:border-primary-600"
                            )}
                        >
                            <div className="font-medium">
                                {filter === "all" ? "All" : sourceLabels[filter]}
                            </div>
                            <div className="mt-1 text-xs opacity-75">
                                {filter === "all" ? skills.length : sourceCounts[filter]}{" "}
                                skills
                            </div>
                        </button>
                    ))}
                </div>

                <div className="space-y-2">
                    {filteredSkills.length === 0 ? (
                        <p className="text-primary-400 text-sm">No skills found</p>
                    ) : (
                        filteredSkills.map((skill) => (
                            <div
                                key={skill.name}
                                className="border-primary-800 bg-primary-900/40 flex flex-col gap-3 rounded-lg border px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                            >
                                <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <p className="text-primary-200 text-sm font-medium break-all sm:truncate">
                                            {skill.name}
                                        </p>
                                        <span className="bg-primary-800 text-primary-400 rounded-full px-2 py-0.5 text-xs">
                                            {sourceLabels[
                                                (skill.source || "extra") as Exclude<
                                                    SkillSourceFilter,
                                                    "all"
                                                >
                                            ] || "Extra"}
                                        </span>
                                    </div>
                                    {skill.description && (
                                        <p className="text-primary-400 mt-0.5 line-clamp-2 text-xs">
                                            {skill.description}
                                        </p>
                                    )}
                                </div>
                                <Switch
                                    checked={skill.enabled}
                                    onChange={(checked) => onToggle(skill.name, checked)}
                                    className="self-end sm:self-auto"
                                />
                            </div>
                        ))
                    )}
                </div>
            </div>
        </ExpandableCard>
    );
}
