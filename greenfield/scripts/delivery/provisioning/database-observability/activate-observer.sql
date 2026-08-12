\set ON_ERROR_STOP 1

-- Activation is the only artifact allowed to enable LOGIN. Re-run every
-- PostgreSQL database and view verifier in this same approval-gated psql
-- session before the final cluster check and transactional role transition.
\ir verify-cluster.sql

\connect aiomanager
\ir verify-database.sql

\connect aiometadata
\ir verify-database.sql

\connect aiostreams
\ir verify-database.sql

\connect authelia
\ir verify-database.sql

\connect bitmagnet
\ir verify-database.sql
\ir verify-torrent-view.sql

\connect comet
\ir verify-database.sql
\ir verify-torrent-view.sql

\connect crowdsec
\ir verify-database.sql

\connect metabase
\ir verify-database.sql

\connect postgres
\ir verify-database.sql

\connect speedtest_tracker
\ir verify-database.sql

\connect postgres
BEGIN;
\ir verify-cluster.sql
ALTER ROLE mira_dashboard_observer LOGIN;

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
    OR observer.rolconnlimit IS DISTINCT FROM 1
    OR observer.rolpassword IS NULL
    OR observer.rolpassword NOT LIKE 'SCRAM-SHA-256$%'
  THEN
    RAISE EXCEPTION 'Activated database observability observer role is invalid';
  END IF;
END
$verify_activation$;
COMMIT;
