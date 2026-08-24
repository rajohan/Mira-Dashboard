import {
    type ApplicationCapability,
    applicationCapabilities,
} from "../../contracts/security.ts";
import { Checkbox } from "../ui/Checkbox.tsx";
import { Fieldset } from "../ui/Fieldset.tsx";

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
        <Fieldset className="mt-4" disabled={disabled} legend="Capabilities">
            <div className="mt-2 flex flex-wrap gap-4">
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
