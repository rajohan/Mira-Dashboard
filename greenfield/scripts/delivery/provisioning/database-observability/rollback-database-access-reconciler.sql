\set ON_ERROR_STOP 1

BEGIN;
DROP FUNCTION mira_dashboard_database_access.reconcile();
DROP SCHEMA mira_dashboard_database_access RESTRICT;
COMMIT;
