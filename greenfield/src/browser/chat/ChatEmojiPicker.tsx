import { Popover, PopoverButton, PopoverPanel } from "@headlessui/react";
import { Smile } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef } from "react";

import { buttonClassNames } from "../ui/buttonStyles.ts";
import { Icon } from "../ui/Icon.tsx";

const emojis = Object.freeze([
    ["😀", "Grinning face"],
    ["😄", "Smiling face with open mouth"],
    ["😂", "Face with tears of joy"],
    ["😊", "Smiling face"],
    ["😍", "Smiling face with heart eyes"],
    ["🥳", "Partying face"],
    ["😎", "Smiling face with sunglasses"],
    ["🤔", "Thinking face"],
    ["😅", "Smiling face with sweat"],
    ["😭", "Loudly crying face"],
    ["👍", "Thumbs up"],
    ["👎", "Thumbs down"],
    ["🙏", "Folded hands"],
    ["🙌", "Raising hands"],
    ["👏", "Clapping hands"],
    ["💪", "Flexed biceps"],
    ["🔥", "Fire"],
    ["✨", "Sparkles"],
    ["💡", "Light bulb"],
    ["✅", "Check mark"],
    ["❌", "Cross mark"],
    ["⚠️", "Warning"],
    ["❤️", "Red heart"],
    ["🚀", "Rocket"],
    ["👀", "Eyes"],
    ["🧠", "Brain"],
    ["🛠️", "Hammer and wrench"],
    ["📎", "Paperclip"],
    ["📝", "Memo"],
    ["📌", "Pushpin"],
    ["🔍", "Magnifying glass"],
    ["💬", "Speech balloon"],
    ["⭐", "Star"],
    ["🌟", "Glowing star"],
    ["🎯", "Bullseye"],
    ["🏁", "Chequered flag"],
    ["🎉", "Party popper"],
    ["🎊", "Confetti ball"],
    ["💯", "Hundred points"],
    ["🤝", "Handshake"],
    ["🫡", "Saluting face"],
    ["🙈", "See no evil monkey"],
] as const);

const columnCount = 6;

interface EmojiGridProps {
    readonly close: () => void;
    readonly onSelect: (emoji: string) => void;
}

function EmojiGrid({ close, onSelect }: EmojiGridProps) {
    const buttons = useRef<(HTMLButtonElement | null)[]>([]);

    useEffect(() => buttons.current[0]?.focus(), []);

    function moveFocus(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
        let nextIndex: number | undefined;
        if (event.key === "ArrowRight") nextIndex = (index + 1) % emojis.length;
        if (event.key === "ArrowLeft") {
            nextIndex = (index - 1 + emojis.length) % emojis.length;
        }
        if (event.key === "ArrowDown") {
            nextIndex = Math.min(index + columnCount, emojis.length - 1);
        }
        if (event.key === "ArrowUp") nextIndex = Math.max(index - columnCount, 0);
        if (event.key === "Home") nextIndex = 0;
        if (event.key === "End") nextIndex = emojis.length - 1;
        if (nextIndex === undefined) return;
        event.preventDefault();
        buttons.current[nextIndex]?.focus();
    }

    return (
        <table
            aria-label="Emoji picker"
            className="border-separate border-spacing-1"
            role="grid"
        >
            <tbody>
                {Array.from(
                    { length: Math.ceil(emojis.length / columnCount) },
                    (_, rowIndex) => (
                        <tr key={rowIndex}>
                            {emojis
                                .slice(
                                    rowIndex * columnCount,
                                    (rowIndex + 1) * columnCount
                                )
                                .map(([emoji, label], columnIndex) => {
                                    const index = rowIndex * columnCount + columnIndex;
                                    return (
                                        <td key={emoji}>
                                            <button
                                                aria-label={label}
                                                className="hover:bg-primary-700 focus-visible:ring-accent-400 flex size-10 items-center justify-center rounded-lg text-xl outline-none focus-visible:ring-2"
                                                onClick={() => {
                                                    onSelect(emoji);
                                                    close();
                                                }}
                                                onKeyDown={(event) =>
                                                    moveFocus(event, index)
                                                }
                                                ref={(element) => {
                                                    buttons.current[index] = element;
                                                }}
                                                title={label}
                                                type="button"
                                            >
                                                <span aria-hidden="true">{emoji}</span>
                                            </button>
                                        </td>
                                    );
                                })}
                        </tr>
                    )
                )}
            </tbody>
        </table>
    );
}

interface ChatEmojiPickerProps {
    readonly disabled?: boolean;
    readonly onSelect: (emoji: string) => void;
}

/**
 * Renders a keyboard-navigable emoji insertion popover.
 * @returns Icon trigger and managed emoji grid.
 */
export function ChatEmojiPicker({ disabled = false, onSelect }: ChatEmojiPickerProps) {
    return (
        <Popover className="relative shrink-0">
            {({ close }) => (
                <>
                    <PopoverButton
                        aria-label="Insert emoji"
                        className={buttonClassNames({
                            className: "min-h-10 min-w-10 px-0 sm:min-h-9 sm:min-w-9",
                            size: "sm",
                            variant: "ghost",
                        })}
                        disabled={disabled}
                        title="Insert emoji"
                    >
                        <Icon icon={Smile} size="sm" tone="inherit" />
                    </PopoverButton>
                    <PopoverPanel
                        anchor={{ gap: 8, to: "top start" }}
                        className="border-primary-500 bg-primary-800 z-50 max-h-64 w-[min(18rem,calc(100vw-1rem))] overflow-y-auto rounded-xl border p-2 shadow-2xl shadow-black/60"
                    >
                        <EmojiGrid close={close} onSelect={onSelect} />
                    </PopoverPanel>
                </>
            )}
        </Popover>
    );
}
