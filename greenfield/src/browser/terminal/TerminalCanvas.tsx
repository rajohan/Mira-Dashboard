import { useEffect, useEffectEvent, useRef } from "react";

import type { TerminalDimensions } from "../../contracts/terminal.ts";
import { cn } from "../lib/classNames.ts";
import {
    createXtermTerminalEmulator,
    type TerminalEmulator,
    type TerminalEmulatorFactory,
} from "./terminalEmulator.ts";

interface TerminalCanvasProps {
    readonly className?: string;
    readonly createEmulator?: TerminalEmulatorFactory;
    readonly inputEnabled: boolean;
    readonly onDimensions: (dimensions: TerminalDimensions) => void;
    readonly onEmulator: (emulator: TerminalEmulator | undefined) => void;
    readonly onInput: (data: Uint8Array) => void;
}

/**
 * Mounts xterm onto one full-size canvas and coalesces container resizes to one
 * animation frame. PTY data stays inside xterm and the active socket callback.
 * @returns The semantic host element xterm owns for its lifetime.
 */
export function TerminalCanvas({
    className,
    createEmulator = createXtermTerminalEmulator,
    inputEnabled,
    onDimensions,
    onEmulator,
    onInput,
}: TerminalCanvasProps) {
    const container = useRef<HTMLDivElement>(null);
    const emulator = useRef<TerminalEmulator | undefined>(undefined);
    const inputEnabledEvent = useEffectEvent(() => inputEnabled);
    const publishDimensions = useEffectEvent(onDimensions);
    const publishEmulator = useEffectEvent(onEmulator);
    const publishInput = useEffectEvent(onInput);

    useEffect(() => {
        const host = container.current;
        if (host === null) return;
        const instance = createEmulator();
        emulator.current = instance;
        instance.open(host);
        instance.setInputEnabled(inputEnabledEvent());
        const releaseInput = instance.onInput((data) => publishInput(data));
        publishEmulator(instance);
        let frame: number | undefined;
        const fit = () => {
            frame = undefined;
            publishDimensions(instance.fit());
        };
        const scheduleFit = () => {
            if (frame !== undefined) return;
            frame = globalThis.requestAnimationFrame(fit);
        };
        scheduleFit();
        const observer =
            typeof ResizeObserver === "undefined"
                ? undefined
                : new ResizeObserver(scheduleFit);
        observer?.observe(host);

        return () => {
            observer?.disconnect();
            if (frame !== undefined) globalThis.cancelAnimationFrame(frame);
            releaseInput();
            publishEmulator(undefined);
            emulator.current = undefined;
            instance.dispose();
        };
    }, [createEmulator]);

    useEffect(() => {
        emulator.current?.setInputEnabled(inputEnabled);
    }, [inputEnabled]);

    return (
        <section
            aria-label="Interactive terminal"
            className={cn(
                "size-full min-h-72 overflow-hidden bg-[#0b0b0c] p-2 sm:min-h-96",
                className
            )}
            ref={container}
        />
    );
}
