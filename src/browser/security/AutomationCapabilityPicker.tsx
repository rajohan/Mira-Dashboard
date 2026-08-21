import { CheckCheck, X } from "lucide-react";

import {
    type ApplicationCapability,
    applicationCapabilities,
} from "../../contracts/security.ts";
import { Button } from "../ui/Button.tsx";
import { Checkbox } from "../ui/Checkbox.tsx";
import { Fieldset } from "../ui/Fieldset.tsx";
import { Icon } from "../ui/Icon.tsx";

interface AutomationCapabilityPickerProps {
    readonly disabled?: boolean;
    readonly onChange: (capabilities: ApplicationCapability[]) => void;
    readonly value: readonly ApplicationCapability[];
}

/**
 * Renders the shared capability selector for automation-principal forms.
 * @returns An accessible checkbox fieldset for the supported capabilities.
 */
export function AutomationCapabilityPicker({
    disabled,
    onChange,
    value,
}: AutomationCapabilityPickerProps) {
    return (
        <Fieldset
            className="mt-4"
            description="Choose exactly what this automation account can access."
            disabled={disabled}
            legend="Permissions"
        >
            <div className="mt-3 flex flex-wrap gap-2">
                <Button
                    disabled={disabled || value.length === applicationCapabilities.length}
                    onClick={() => onChange([...applicationCapabilities])}
                    size="sm"
                    type="button"
                    variant="secondary"
                >
                    <Icon icon={CheckCheck} size="sm" tone="inherit" />
                    Add all
                </Button>
                <Button
                    disabled={disabled || value.length === 0}
                    onClick={() => onChange([])}
                    size="sm"
                    type="button"
                    variant="ghost"
                >
                    <Icon icon={X} size="sm" tone="inherit" />
                    Remove all
                </Button>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {applicationCapabilities.map((capability) => (
                    <Checkbox
                        checked={value.includes(capability)}
                        key={capability}
                        label={capability}
                        onChange={(checked) =>
                            onChange(
                                checked
                                    ? [...value, capability].toSorted()
                                    : value.filter((item) => item !== capability)
                            )
                        }
                    />
                ))}
            </div>
        </Fieldset>
    );
}
