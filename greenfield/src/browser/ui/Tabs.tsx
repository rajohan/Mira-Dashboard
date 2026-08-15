import { Tab, TabGroup, TabList, TabPanel, TabPanels } from "@headlessui/react";
import { useId, type ReactNode } from "react";

import { cn } from "../lib/classNames.ts";
import { interactiveTapClassName } from "./interactionStyles.ts";

export interface TabDefinition<TValue extends string> {
    readonly disabled?: boolean;
    readonly label: ReactNode;
    readonly panel: ReactNode;
    readonly value: TValue;
}

interface TabsProps<TValue extends string> {
    readonly ariaLabel: string;
    readonly className?: string;
    readonly description?: ReactNode;
    readonly manual?: boolean;
    readonly onChange: (value: TValue) => void;
    readonly tabs: readonly TabDefinition<TValue>[];
    readonly value: TValue;
    readonly vertical?: boolean;
}

/**
 * Renders one controlled set of keyboard-navigable content views.
 * @returns Responsive Headless UI tabs with value-safe change events.
 */
export function Tabs<TValue extends string>({
    ariaLabel,
    className,
    description,
    manual = false,
    onChange,
    tabs,
    value,
    vertical = false,
}: TabsProps<TValue>) {
    const descriptionId = useId();
    const selectedIndex = tabs.findIndex((tab) => tab.value === value);
    if (selectedIndex === -1) {
        throw new RangeError("Tabs value must match one tab definition");
    }

    return (
        <TabGroup
            className={cn("max-w-full min-w-0", className)}
            manual={manual}
            onChange={(index) => {
                const selected = tabs[index];
                if (selected !== undefined) onChange(selected.value);
            }}
            selectedIndex={selectedIndex}
            vertical={vertical}
        >
            {description !== undefined && (
                <p className="text-primary-400 mb-2 text-xs leading-5" id={descriptionId}>
                    {description}
                </p>
            )}
            <div
                className={cn(
                    "max-w-full min-w-0",
                    vertical &&
                        "grid gap-3 sm:grid-cols-[minmax(10rem,0.32fr)_minmax(0,1fr)]"
                )}
            >
                <TabList
                    aria-describedby={
                        description === undefined ? undefined : descriptionId
                    }
                    aria-label={ariaLabel}
                    className={cn(
                        "border-primary-700 bg-primary-800/80 max-w-full min-w-0 gap-1 rounded-lg border p-1 shadow-sm shadow-black/10",
                        vertical ? "flex flex-col" : "flex w-full flex-wrap"
                    )}
                >
                    {tabs.map((tab) => (
                        <Tab
                            className={cn(
                                interactiveTapClassName,
                                "text-primary-300 min-h-10 min-w-0 rounded-md px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors",
                                "not-data-selected:not-data-disabled:data-hover:bg-primary-800 not-data-selected:not-data-disabled:data-hover:text-primary-50 hover:not-data-selected:not-data-disabled:bg-primary-800 hover:not-data-selected:not-data-disabled:text-primary-50",
                                "data-selected:bg-accent-500 data-selected:text-primary-950",
                                "data-focus:ring-accent-300 data-focus:ring-2 data-focus:outline-none data-focus:ring-inset",
                                "data-disabled:cursor-not-allowed data-disabled:opacity-45",
                                vertical
                                    ? "w-full max-w-full text-left"
                                    : "min-w-0 grow basis-28"
                            )}
                            disabled={tab.disabled}
                            key={tab.value}
                        >
                            <span className="block max-w-full min-w-0 truncate">
                                {tab.label}
                            </span>
                        </Tab>
                    ))}
                </TabList>
                <TabPanels className={cn("max-w-full min-w-0", !vertical && "mt-3")}>
                    {tabs.map((tab) => (
                        <TabPanel
                            className="text-primary-200 focus-visible:ring-accent-300 max-w-full min-w-0 rounded-lg wrap-break-word focus-visible:ring-2 focus-visible:outline-none"
                            key={tab.value}
                        >
                            {tab.panel}
                        </TabPanel>
                    ))}
                </TabPanels>
            </div>
        </TabGroup>
    );
}
