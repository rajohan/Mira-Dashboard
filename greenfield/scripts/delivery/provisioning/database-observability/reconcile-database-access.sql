\set ON_ERROR_STOP 1

-- This fixed call is shared by approval-gated activation and the periodic
-- executor. The function owns the transaction, advisory lock, bounds,
-- identifier quoting, catalog-race detection, and ACL mutation.
SELECT mira_dashboard_database_access.reconcile();
