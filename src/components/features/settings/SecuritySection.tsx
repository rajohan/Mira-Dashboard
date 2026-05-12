import { Shield } from "lucide-react";

import { ExpandableCard, ReadOnlyField } from "../../ui/ExpandableCard";

/** Provides props for security section. */
interface SecuritySectionProps {
    authProfiles: number;
    commandRestartEnabled: boolean;
    ownerAllowFrom: string;
    elevatedEnabled: boolean;
    execSecurity: string;
    execAsk: string;
    redactionMode?: string;
}

/** Renders the security section UI. */
export function SecuritySection({
    authProfiles,
    commandRestartEnabled,
    ownerAllowFrom,
    elevatedEnabled,
    execSecurity,
    execAsk,
    redactionMode,
}: SecuritySectionProps) {
    return (
        <ExpandableCard title="Security" icon={Shield}>
            <div className="space-y-2">
                <ReadOnlyField label="Auth profiles" value={authProfiles} />
                <ReadOnlyField
                    label="Command restart"
                    value={commandRestartEnabled ? "Enabled" : "Disabled"}
                />
                <ReadOnlyField
                    label="Owner allow from"
                    value={ownerAllowFrom || "None"}
                />
                <ReadOnlyField
                    label="Elevated tools"
                    value={elevatedEnabled ? "Enabled" : "Disabled"}
                />
                <ReadOnlyField label="Exec security" value={execSecurity} />
                <ReadOnlyField label="Exec approval" value={execAsk} />
                <ReadOnlyField label="Log redaction" value={redactionMode || "default"} />
            </div>
        </ExpandableCard>
    );
}
