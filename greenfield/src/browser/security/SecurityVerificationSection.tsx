import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, ShieldCheck } from "lucide-react";
import { useState } from "react";

import type { AccountSecuritySummary } from "../../contracts/accountSecurity.ts";
import { useExclusiveDashboardAction } from "../hooks/useExclusiveDashboardAction.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Modal } from "../ui/Modal.tsx";
import { PasswordChangeForm } from "./PasswordChangeForm.tsx";
import { SecurityProofControls } from "./SecurityProofControls.tsx";
import { refreshSecurityQueries } from "./securityQueries.ts";
import { SecuritySection } from "./SecurityUi.tsx";

interface SecurityVerificationSectionProps {
    readonly summary: AccountSecuritySummary;
}

function useSecurityActionCompletion() {
    const action = useExclusiveDashboardAction();
    const queryClient = useQueryClient();
    const [notice, setNotice] = useState<string>();

    async function complete(
        operation: () => Promise<unknown>,
        successMessage: string
    ): Promise<boolean> {
        setNotice(undefined);
        const result = await action.run(async () => {
            await operation();
            await refreshSecurityQueries(queryClient);
        });
        if (result.status !== "success") return false;
        setNotice(successMessage);
        return true;
    }

    return { action, complete, notice };
}

/**
 * Shows account verification status and opens the appropriate proof in a modal.
 * @returns The compact two-step-login status section.
 */
export function SecurityVerificationSection({
    summary,
}: SecurityVerificationSectionProps) {
    const { action, complete, notice } = useSecurityActionCompletion();
    const [verificationMode, setVerificationMode] = useState<"mfa" | "password">();
    let verificationAction;
    if (summary.mfa.enabled) {
        verificationAction = (
            <Button
                disabled={action.busy}
                onClick={() => setVerificationMode("mfa")}
                variant="secondary"
            >
                Verify now
            </Button>
        );
    } else if (!summary.recentAuth.password.recent) {
        verificationAction = (
            <Button
                disabled={action.busy}
                onClick={() => setVerificationMode("password")}
                variant="secondary"
            >
                Verify password
            </Button>
        );
    }

    return (
        <div className="contents">
            <Heading className="sr-only" id="security-verification-heading" level={2}>
                Verification and password
            </Heading>
            <Alert message={notice} variant="success" />
            <SecuritySection
                actions={verificationAction}
                badge={
                    <Badge variant={summary.mfa.enabled ? "success" : "warning"}>
                        {summary.mfa.enabled ? "Enabled" : "Not enabled"}
                    </Badge>
                }
                description="Security keys are phishing-resistant. Authenticator apps are supported as an alternative."
                id="two-step-login-heading"
                icon={ShieldCheck}
                title="Two-step login"
            />
            <Modal
                description={
                    verificationMode === "password"
                        ? "Confirm your current Dashboard password."
                        : "Use one of your registered second-factor methods."
                }
                dismissible={!action.busy}
                onClose={() => setVerificationMode(undefined)}
                open={verificationMode !== undefined}
                size="sm"
                title={
                    verificationMode === "password"
                        ? "Verify current password"
                        : "Verify second factor"
                }
            >
                <Alert className="mb-4" message={action.error} />
                {verificationMode !== undefined && (
                    <SecurityProofControls
                        action={action}
                        complete={complete}
                        methods={summary.mfa.methods}
                        mode={verificationMode}
                        onVerified={() => setVerificationMode(undefined)}
                    />
                )}
            </Modal>
        </div>
    );
}

/**
 * Keeps password rotation compact until the user explicitly opens its modal.
 * @returns The Dashboard-password management section.
 */
export function DashboardPasswordSection() {
    const { action, complete, notice } = useSecurityActionCompletion();
    const [open, setOpen] = useState(false);

    return (
        <div className="contents">
            <Alert message={notice} variant="success" />
            <SecuritySection
                actions={
                    <Button
                        disabled={action.busy}
                        onClick={() => setOpen(true)}
                        variant="secondary"
                    >
                        Change password
                    </Button>
                }
                description="Changing it signs every other Dashboard browser out. Forgotten passwords require the host-local recovery command."
                id="dashboard-password-heading"
                icon={KeyRound}
                title="Dashboard password"
            />
            <PasswordChangeForm
                action={action}
                complete={complete}
                onClose={() => setOpen(false)}
                open={open}
            />
        </div>
    );
}
