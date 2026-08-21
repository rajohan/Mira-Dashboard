import { Fingerprint, LifeBuoy, Smartphone } from "lucide-react";

import type { MultiFactorAuthenticationMethod } from "../../contracts/security.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";

interface MfaMethodChooserProps {
    readonly busy: boolean;
    readonly methods: readonly MultiFactorAuthenticationMethod[];
    readonly onChoose: (method: MultiFactorAuthenticationMethod) => void;
}

/**
 * Presents the common ordered list of available second-factor methods.
 * @returns Full-width method choices for the available MFA factors.
 */
export function MfaMethodChooser({ busy, methods, onChoose }: MfaMethodChooserProps) {
    return (
        <fieldset className="min-w-0">
            <legend className="sr-only">Choose a verification method</legend>
            <div className="space-y-3">
                {methods.includes("webauthn") && (
                    <Button
                        className="justify-start"
                        disabled={busy}
                        fullWidth
                        onClick={() => onChoose("webauthn")}
                    >
                        <Icon icon={Fingerprint} size="sm" tone="inherit" />
                        Use a security key
                    </Button>
                )}
                {methods.includes("totp") && (
                    <Button
                        className="justify-start"
                        disabled={busy}
                        fullWidth
                        onClick={() => onChoose("totp")}
                        variant="secondary"
                    >
                        <Icon icon={Smartphone} size="sm" tone="inherit" />
                        Use authenticator app
                    </Button>
                )}
                {methods.includes("recovery") && (
                    <Button
                        className="justify-start"
                        disabled={busy}
                        fullWidth
                        onClick={() => onChoose("recovery")}
                        variant="ghost"
                    >
                        <Icon icon={LifeBuoy} size="sm" tone="inherit" />
                        Use recovery code
                    </Button>
                )}
            </div>
        </fieldset>
    );
}
