import {
    Combobox as HeadlessCombobox,
    ComboboxButton,
    ComboboxInput,
    ComboboxOption,
    ComboboxOptions,
} from "@headlessui/react";
import { ChevronsUpDown, Plus, X } from "lucide-react";
import { useRef, useState, type FocusEventHandler, type KeyboardEvent } from "react";

import { cn } from "../lib/classNames.ts";
import { Badge } from "./Badge.tsx";
import { useFormFieldInvalid } from "./formFieldContext.ts";
import { Icon } from "./Icon.tsx";
import { IconOnlyButton } from "./IconOnlyButton.tsx";

export interface TagInputProps {
    readonly ariaLabel?: string;
    readonly className?: string;
    readonly disabled?: boolean;
    readonly invalid?: boolean;
    readonly maxTags?: number;
    readonly name?: string;
    readonly onBlur?: FocusEventHandler<HTMLDivElement>;
    readonly onChange: (value: readonly string[]) => void;
    readonly placeholder?: string;
    readonly suggestions?: readonly string[];
    readonly value: readonly string[];
}

/**
 * Renders a controlled collection of removable tags above one compact text input.
 * @returns A fixed-height creatable combobox with a separate wrapping tag row.
 */
export function TagInput({
    ariaLabel,
    className,
    disabled = false,
    invalid,
    maxTags,
    name,
    onBlur,
    onChange,
    placeholder,
    suggestions = [],
    value,
}: TagInputProps) {
    const inheritedInvalid = useFormFieldInvalid();
    const resolvedInvalid = invalid ?? inheritedInvalid;
    const [draft, setDraft] = useState("");
    const composingReference = useRef(false);
    const atTagLimit = maxTags !== undefined && value.length >= maxTags;
    const normalizedQuery = draft.trim().toLocaleLowerCase("en-US");
    const selectableSuggestions = [...new Set(suggestions)].filter(
        (suggestion) => !value.includes(suggestion)
    );
    const availableSuggestions = selectableSuggestions
        .filter(
            (suggestion) =>
                normalizedQuery.length === 0 ||
                suggestion.toLocaleLowerCase("en-US").includes(normalizedQuery)
        )
        .toSorted((left, right) => left.localeCompare(right));

    function commitDraft(nextDraft: string): void {
        const tag = nextDraft.trim();
        if (tag.length === 0 || atTagLimit) return;
        if (value.includes(tag)) {
            setDraft("");
            return;
        }

        onChange([...value, tag]);
        setDraft("");
    }

    function handleKeyDown(
        event: KeyboardEvent<HTMLInputElement>,
        activeSuggestion: string | null
    ): void {
        if (event.nativeEvent.isComposing || composingReference.current) return;

        if (event.key === "Enter" && activeSuggestion !== null) return;

        if (event.key === "Enter") {
            event.preventDefault();
            commitDraft(event.currentTarget.value);
            return;
        }

        if (event.key === "Backspace" && event.currentTarget.value.length === 0) {
            const lastTagIndex = value.length - 1;
            if (lastTagIndex < 0) return;

            event.preventDefault();
            onChange(value.slice(0, lastTagIndex));
        }
    }

    return (
        <HeadlessCombobox<string | null>
            disabled={disabled}
            invalid={resolvedInvalid}
            onChange={(suggestion) => {
                if (suggestion !== null) commitDraft(suggestion);
            }}
            value={null}
        >
            {({ activeOption, open }) => (
                <div
                    className={cn("relative max-w-full min-w-0", className)}
                    onBlur={(event) => {
                        const nextFocusedElement = event.relatedTarget;
                        if (
                            nextFocusedElement instanceof Node &&
                            (event.currentTarget.contains(nextFocusedElement) ||
                                (nextFocusedElement instanceof HTMLElement &&
                                    nextFocusedElement.getAttribute("role") === "option"))
                        )
                            return;

                        if (!composingReference.current) commitDraft(draft);
                        onBlur?.(event);
                    }}
                >
                    {value.length > 0 && (
                        <div className="mb-2 flex max-w-full min-w-0 flex-wrap gap-1.5">
                            {value.map((tag, index) => (
                                <Badge
                                    className="max-w-full min-w-0 shrink-0 gap-1 py-0.5 pr-0.5 pl-2"
                                    key={`${tag}-${index}`}
                                >
                                    <span className="min-w-0 wrap-anywhere">{tag}</span>
                                    <IconOnlyButton
                                        className="size-6 min-h-6 shrink-0 rounded-full p-0"
                                        disabled={disabled}
                                        icon={X}
                                        label={
                                            tag.trim().length === 0
                                                ? `Remove tag ${index + 1}`
                                                : `Remove ${tag}`
                                        }
                                        onClick={() =>
                                            onChange(
                                                value.filter(
                                                    (_value, valueIndex) =>
                                                        valueIndex !== index
                                                )
                                            )
                                        }
                                        size="sm"
                                        variant="ghost"
                                    />
                                </Badge>
                            ))}
                        </div>
                    )}
                    <div className="relative max-w-full min-w-0">
                        <ComboboxInput<string>
                            aria-label={ariaLabel}
                            autoComplete="off"
                            className={cn(
                                "border-primary-500 bg-primary-950 text-primary-50 placeholder:text-primary-400 min-h-10 w-full max-w-full min-w-0 rounded-lg border py-2 pr-12 pl-3 shadow-sm transition-colors",
                                "data-hover:border-accent-400 data-focus:border-accent-400 data-focus:ring-accent-400 data-focus:ring-2 data-focus:outline-none",
                                "data-disabled:cursor-not-allowed data-disabled:opacity-60 data-invalid:border-red-500 data-invalid:ring-red-500",
                                atTagLimit && "cursor-default"
                            )}
                            name={name}
                            onChange={(event) => setDraft(event.currentTarget.value)}
                            onCompositionEnd={() => {
                                composingReference.current = false;
                            }}
                            onCompositionStart={() => {
                                composingReference.current = true;
                            }}
                            onKeyDown={(event) => handleKeyDown(event, activeOption)}
                            placeholder={atTagLimit ? undefined : placeholder}
                            readOnly={atTagLimit}
                            value={draft}
                        />
                        <ComboboxButton
                            as={IconOnlyButton}
                            className="absolute inset-y-1 right-1"
                            disabled={atTagLimit || selectableSuggestions.length === 0}
                            icon={ChevronsUpDown}
                            label="Show existing labels"
                            size="sm"
                            variant="ghost"
                        />
                    </div>
                    {(availableSuggestions.length > 0 || draft.trim().length > 0) && (
                        <ComboboxOptions
                            anchor={{ gap: 6, padding: 8, to: "bottom start" }}
                            aria-hidden={open ? undefined : true}
                            className={cn(
                                "border-primary-600 bg-primary-900 z-80 max-h-64 w-(--input-width) max-w-[calc(100vw-1rem)] overflow-auto rounded-lg border p-1 shadow-xl shadow-black/35",
                                "transition duration-100 focus:outline-none data-closed:scale-95 data-closed:opacity-0 motion-reduce:transition-none"
                            )}
                            inert={open ? undefined : true}
                            modal={false}
                            transition
                        >
                            {availableSuggestions.length === 0 ? (
                                <ComboboxOption
                                    className="text-primary-400 px-3 py-2 text-sm"
                                    disabled
                                    value=""
                                >
                                    Press Enter to create “{draft.trim()}”
                                </ComboboxOption>
                            ) : (
                                availableSuggestions.map((suggestion) => (
                                    <ComboboxOption
                                        className={cn(
                                            "group text-primary-200 relative flex cursor-pointer items-start gap-2 rounded-md py-2 pr-3 pl-9 text-sm select-none",
                                            "data-focus:bg-primary-700 data-focus:text-primary-50"
                                        )}
                                        key={suggestion}
                                        value={suggestion}
                                    >
                                        <Icon
                                            className="text-accent-300 absolute top-2.5 left-3"
                                            icon={Plus}
                                            size="sm"
                                            tone="inherit"
                                        />
                                        <span className="min-w-0 truncate font-medium">
                                            {suggestion}
                                        </span>
                                    </ComboboxOption>
                                ))
                            )}
                        </ComboboxOptions>
                    )}
                </div>
            )}
        </HeadlessCombobox>
    );
}
