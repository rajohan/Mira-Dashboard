import { CheckCheck, X } from "lucide-react";

import { cn } from "../lib/classNames.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import {
    allLogLevels,
    type FilterableLogLevel,
    filterableLogLevels,
} from "./logLevelFiltering.ts";

const levelClasses: Readonly<Record<FilterableLogLevel, string>> = Object.freeze({
    debug: "aria-pressed:border-primary-400/50 aria-pressed:bg-primary-500/20 aria-pressed:text-primary-100",
    error: "aria-pressed:border-red-400/50 aria-pressed:bg-red-500/20 aria-pressed:text-red-200",
    fatal: "aria-pressed:border-red-300/60 aria-pressed:bg-red-600/30 aria-pressed:text-red-100",
    info: "aria-pressed:border-sky-400/50 aria-pressed:bg-sky-500/20 aria-pressed:text-sky-200",
    trace: "aria-pressed:border-violet-400/50 aria-pressed:bg-violet-500/20 aria-pressed:text-violet-200",
    warn: "aria-pressed:border-amber-400/50 aria-pressed:bg-amber-500/20 aria-pressed:text-amber-200",
});

interface LogLevelFilterProps {
    readonly activeLevels: ReadonlySet<FilterableLogLevel>;
    readonly disabled?: boolean;
    readonly onChange: (levels: ReadonlySet<FilterableLogLevel>) => void;
}

/** @returns Fast multi-select level chips over only the currently loaded snapshot. */
export function LogLevelFilter({
    activeLevels,
    disabled = false,
    onChange,
}: LogLevelFilterProps) {
    const allSelected = activeLevels.size === filterableLogLevels.length;
    return (
        <div>
            <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-1.5 border-0 p-0">
                <legend className="sr-only">Log levels in current snapshot</legend>
                {filterableLogLevels.map((level) => {
                    const pressed = activeLevels.has(level);
                    return (
                        <Button
                            aria-pressed={pressed}
                            className={cn(
                                "border-primary-600 bg-primary-900/80 text-primary-300 min-h-8 rounded-full border px-2.5 py-1 font-mono text-xs lowercase",
                                levelClasses[level]
                            )}
                            disabled={disabled}
                            key={level}
                            onClick={() => {
                                const next = new Set(activeLevels);
                                if (pressed) next.delete(level);
                                else next.add(level);
                                onChange(next);
                            }}
                            size="sm"
                            variant="ghost"
                        >
                            {level}
                        </Button>
                    );
                })}
                <Button
                    aria-label="Select all log levels"
                    className="min-h-8 rounded-full px-2.5 py-1 text-xs"
                    disabled={disabled || allSelected}
                    onClick={() => onChange(allLogLevels())}
                    size="sm"
                    variant="secondary"
                >
                    <Icon icon={CheckCheck} size="sm" tone="inherit" />
                    All
                </Button>
                <Button
                    aria-label="Clear all log levels"
                    className="min-h-8 rounded-full px-2.5 py-1 text-xs"
                    disabled={disabled || activeLevels.size === 0}
                    onClick={() => onChange(new Set())}
                    size="sm"
                    variant="ghost"
                >
                    <Icon icon={X} size="sm" tone="inherit" />
                    Clear
                </Button>
            </fieldset>
            <p className="text-primary-400 mt-1.5 text-xs">
                Filters only this loaded snapshot. Unclassified lines appear only when all
                six levels are selected.
            </p>
        </div>
    );
}
