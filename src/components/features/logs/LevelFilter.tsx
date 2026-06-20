import { Button } from "../../../components/ui/Button";
import { cn } from "../../../utils/cn";
import { getLevelColor } from "../../../utils/logUtilities";

/** Provides props for level filter. */
interface LevelFilterProperties {
    levels: readonly string[];
    activeLevels: Set<string>;
    onToggle: (level: string) => void;
}

/** Renders the level filter UI. */
export function LevelFilter({ levels, activeLevels, onToggle }: LevelFilterProperties) {
    return (
        <div className="flex flex-wrap items-center gap-1">
            {levels.map((level) => (
                <Button
                    key={level}
                    variant="ghost"
                    size="sm"
                    aria-pressed={activeLevels.has(level)}
                    onClick={() => onToggle(level)}
                    className={cn(
                        "rounded px-2 py-0.5 text-xs",
                        activeLevels.has(level)
                            ? getLevelColor(level)
                            : "bg-primary-700 text-primary-500"
                    )}
                >
                    {level}
                </Button>
            ))}
        </div>
    );
}
