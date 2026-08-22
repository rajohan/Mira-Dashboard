# Authentication and trust boundaries

## Email verification and password recovery

Bootstrap requires one canonical, validated account email and creates a usable but initially
unverified account. The operator can sign in and correct or resend that address before
verification. Password-recovery delivery is unavailable until an address is verified. A change
from a verified address is staged separately: the old address remains the sole active recovery
destination until the new address consumes its verification token, when one transaction replaces
the address and removes the pending state.

Verification and reset requests cross the public HTTP/tRPC boundary and therefore use generic
responses, durable source/global rate limits, short-lived single-use opaque tokens, and validators
stored only as purpose-separated hashes. Tokens expire after 15 minutes. Resend configuration is
server-only and paired; link origins come only from the validated public Dashboard origin. Mail
tracking is unnecessary and should remain disabled.

A successful password reset compare-and-swaps the current authentication state, preserves enrolled
MFA, revokes all browser sessions and pending login ceremonies, and consumes the token atomically.
The former host-local reset executable and its independent break-glass authority were removed; a
deployment must repair Resend/DNS configuration rather than expose a second password mutation path.
