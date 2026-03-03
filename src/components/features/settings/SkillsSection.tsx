import { Users } from "lucide-react";

import { ExpandableCard } from "../../ui/ExpandableCard";
import { Switch } from "../../ui/Switch";
import { type Skill } from "../../../types/settings";

interface SkillsSectionProps {
    skills: Skill[];
    onToggle: (skillName: string, enabled: boolean) => void;
}

export function SkillsSection({ skills, onToggle }: SkillsSectionProps) {
    return (
        <ExpandableCard title="Skills" icon={Users}>
            <div className="space-y-2">
                {skills.length === 0 ? (
                    <p className="text-sm text-slate-400">No skills configured</p>
                ) : (
                    skills.map((skill) => (
                        <div key={skill.name} className="flex items-center justify-between py-2">
                            <div>
                                <p className="text-sm font-medium text-slate-200">{skill.name}</p>
                                {skill.description && (
                                    <p className="text-xs text-slate-400">{skill.description}</p>
                                )}
                            </div>
                            <Switch
                                checked={skill.enabled}
                                onChange={(e) => onToggle(skill.name, e.target.checked)}
                            />
                        </div>
                    ))
                )}
            </div>
        </ExpandableCard>
    );
}