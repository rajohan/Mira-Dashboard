# Preview Tailscale operator bootstrap

PR previews publish one fixed HTTPS Tailscale Serve route through the production worker. The
worker retains `NoNewPrivileges=true`, never invokes `sudo`, and therefore requires Tailscale's
native Unix operator delegation for the fixed local account `ubuntu`.

Apply this once on a new host, from the exact manifest-verified release artifact:

```bash
sudo /usr/local/bin/bun \
  /absolute/release/scripts/delivery/provisioning/preview-tailscale/operator.ts \
  --mode=apply
```

Verify without mutating the host:

```bash
/usr/local/bin/bun \
  /absolute/release/scripts/delivery/provisioning/preview-tailscale/operator.ts \
  --mode=verify
```

The apply path executes only `/usr/bin/tailscale set --operator=ubuntu`, then reads
`/usr/bin/tailscale debug prefs` and requires the exact persisted operator. Production cutover
performs the same read-only verification before stopping services. A missing or different
operator fails closed; the Dashboard does not disable `NoNewPrivileges`, use ambient `sudo`, or
change Tailscale configuration automatically during deployment.
