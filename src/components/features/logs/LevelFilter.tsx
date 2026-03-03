import { Button } from "../../../components/ui/Button";
import { cn } from "../../../utils/cn";
import { getLevelColor } from "../../../utils/logUtils";

interface LevelFilterProps {
    levels: readonly string[];
    activeLevels: Set<string>;
    onToggle: (level: string) => void;
}

export function LevelFilter({ levels, activeLevels, onToggle }: LevelFilterProps) {
    return (
        <div className="flex items-center gap-1">
            {levels.map((level) => (
                <Button
                    key={level}
                    variant="ghost"
                    size="sm"
                    onClick={() => onToggle(level)}
                    className={cn(
                        "rounded px-2 py-0.5 text-xs",
                        activeLevels.has(level)
                            ? getLevelColor(level)
                            : "bg-slate-700 text-slate-500"
                    )}
                >
                    {level}
                </Button>
            ))}
        </div>
    );
}
