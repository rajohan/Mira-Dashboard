\set ON_ERROR_STOP 1

-- Explicit activation rotates the approval after the bounded runner has
-- applied and verified the current catalog. It may verify that the retained
-- credential is usable as a login boundary, but must finish closed.
\ir verify-cluster.sql
\ir verify-control-database-capability.sql
\ir verify-control-database.sql

ALTER ROLE mira_dashboard_observer LOGIN
  VALID UNTIL '1970-01-01 00:00:00+00';

DO $verify_activation$
DECLARE
  observer pg_catalog.pg_authid%ROWTYPE;
BEGIN
  SELECT * INTO observer
  FROM pg_catalog.pg_authid
  WHERE rolname = 'mira_dashboard_observer';
  IF observer.oid IS NULL
    OR NOT observer.rolcanlogin
    OR NOT observer.rolinherit
    OR observer.rolsuper
    OR observer.rolcreatedb
    OR observer.rolcreaterole
    OR observer.rolreplication
    OR observer.rolbypassrls
    OR observer.rolconnlimit IS DISTINCT FROM 64
    OR observer.rolpassword IS NULL
    OR observer.rolpassword NOT LIKE 'SCRAM-SHA-256$%'
    OR observer.rolvaliduntil IS DISTINCT FROM
      '1970-01-01 00:00:00+00'::timestamp with time zone
  THEN
    RAISE EXCEPTION 'Activated database observability observer role is invalid';
  END IF;
END
$verify_activation$;

ALTER ROLE mira_dashboard_observer NOLOGIN
  VALID UNTIL '1970-01-01 00:00:00+00';
\ir verify-cluster.sql
\ir apply-reconciliation-approval.sql
\ir verify-reconciliation-approval.sql
