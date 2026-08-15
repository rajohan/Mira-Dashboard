# Operator runbooks

## Forgotten Dashboard password

Use this host-local recovery path only when the Dashboard account cannot authenticate normally.
It operates on the active production release and never accepts a password through arguments or
environment variables.

1. Open an interactive terminal on the Dashboard host as the Dashboard operator.
2. Run the password-only recovery command:

    ```bash
    cd /home/ubuntu/projects/mira-dashboard/production/checkout
    bun run auth:reset-password -- --username <username>
    ```

3. Enter the new password twice at the hidden prompts.
4. Confirm the command reports that the password was reset and every session was revoked.
5. Sign in again with the new password. Existing MFA remains required.

If the user has also lost every MFA factor and recovery code, use the explicit break-glass mode:

```bash
cd /home/ubuntu/projects/mira-dashboard/production/checkout
bun run auth:reset-password -- --username <username> --reset-mfa
```

`--reset-mfa` removes registered authenticator apps, security keys, and recovery codes in the same
transaction as the password reset. Both modes revoke all sessions and pending login ceremonies,
discard unconfirmed authenticator enrollment, clear only that user's account-password and
account-MFA cooldowns, advance the authentication version, and append an `auth.password.reset`
security-audit event. A failure rolls back the complete transaction; rerun only after resolving
the reported host or release problem.

Do not use a source checkout entrypoint, an unpinned Bun binary, a copied database, or a password
provided through `--password`, stdin redirection, an environment variable, or a message.
