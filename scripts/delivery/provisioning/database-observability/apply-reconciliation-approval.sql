\set ON_ERROR_STOP 1

BEGIN;

SET LOCAL mira_dashboard.current_policy_digest
  TO :'current_policy_digest';

DO $approval_structure_preflight$
DECLARE
  administrator_oid oid;
  approval_oid oid;
  approval_schema_oid oid;
  expected_digest text := pg_catalog.current_setting(
    'mira_dashboard.current_policy_digest'
  );
BEGIN
  SELECT databases.datdba INTO administrator_oid
  FROM pg_catalog.pg_database AS databases
  JOIN pg_catalog.pg_roles AS owners ON owners.oid = databases.datdba
  WHERE databases.datname = pg_catalog.current_database()
    AND databases.datname = 'mira_dashboard_observability'
    AND NOT databases.datistemplate
    AND databases.datallowconn
    AND owners.rolname = CURRENT_USER
    AND owners.rolsuper;
  IF administrator_oid IS NULL
    OR expected_digest !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'Database observability reconciliation approval preflight failed';
  END IF;

  SELECT namespaces.oid INTO approval_schema_oid
  FROM pg_catalog.pg_namespace AS namespaces
  WHERE namespaces.nspname = 'mira_dashboard_observability_control';
  IF approval_schema_oid IS NULL THEN
    EXECUTE 'CREATE SCHEMA mira_dashboard_observability_control AUTHORIZATION '
      || pg_catalog.quote_ident(CURRENT_USER);
    SELECT namespaces.oid INTO STRICT approval_schema_oid
    FROM pg_catalog.pg_namespace AS namespaces
    WHERE namespaces.nspname = 'mira_dashboard_observability_control';
  ELSIF (SELECT namespaces.nspowner
         FROM pg_catalog.pg_namespace AS namespaces
         WHERE namespaces.oid = approval_schema_oid) <> administrator_oid
    OR COALESCE(
      (SELECT namespaces.nspacl
       FROM pg_catalog.pg_namespace AS namespaces
       WHERE namespaces.oid = approval_schema_oid),
      pg_catalog.acldefault('n', administrator_oid)
    ) <> pg_catalog.acldefault('n', administrator_oid)
  THEN
    RAISE EXCEPTION 'Database observability reconciliation approval schema is invalid';
  END IF;

  SELECT classes.oid INTO approval_oid
  FROM pg_catalog.pg_class AS classes
  WHERE classes.relnamespace = approval_schema_oid
    AND classes.relname = 'reconciliation_approval'
    AND classes.relkind = 'r';
  IF approval_oid IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_class AS classes
      WHERE classes.relnamespace = approval_schema_oid
    ) OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc AS routines
      WHERE routines.pronamespace = approval_schema_oid
    ) OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_type AS types
      WHERE types.typnamespace = approval_schema_oid
    )
    THEN
      RAISE EXCEPTION 'Database observability reconciliation approval namespace is occupied';
    END IF;
    EXECUTE $create_approval$
      CREATE TABLE mira_dashboard_observability_control.reconciliation_approval (
        singleton boolean NOT NULL,
        policy_version text NOT NULL,
        system_identifier numeric NOT NULL,
        current_policy_digest text NOT NULL,
        previous_policy_digest text,
        CONSTRAINT reconciliation_approval_primary_key
          PRIMARY KEY (singleton),
        CONSTRAINT reconciliation_approval_singleton_true
          CHECK (singleton),
        CONSTRAINT reconciliation_approval_policy_version
          CHECK (policy_version = 'sanitized-capabilities-v1'),
        CONSTRAINT reconciliation_approval_system_identifier
          CHECK (system_identifier > 0),
        CONSTRAINT reconciliation_approval_current_digest
          CHECK (current_policy_digest ~ '^[0-9a-f]{64}$'),
        CONSTRAINT reconciliation_approval_previous_digest
          CHECK (
            previous_policy_digest IS NULL
            OR previous_policy_digest ~ '^[0-9a-f]{64}$'
          )
      )
    $create_approval$;
  END IF;
END
$approval_structure_preflight$;

DO $approval_exact_boundary$
DECLARE
  administrator_oid oid;
  approval_oid oid;
  approval_schema_oid oid;
BEGIN
  SELECT databases.datdba INTO administrator_oid
  FROM pg_catalog.pg_database AS databases
  WHERE databases.datname = pg_catalog.current_database();
  SELECT namespaces.oid INTO approval_schema_oid
  FROM pg_catalog.pg_namespace AS namespaces
  WHERE namespaces.nspname = 'mira_dashboard_observability_control';
  SELECT classes.oid INTO approval_oid
  FROM pg_catalog.pg_class AS classes
  WHERE classes.relnamespace = approval_schema_oid
    AND classes.relname = 'reconciliation_approval'
    AND classes.relkind = 'r';

  IF administrator_oid IS NULL
    OR approval_schema_oid IS NULL
    OR approval_oid IS NULL
    OR (SELECT classes.relowner FROM pg_catalog.pg_class AS classes
        WHERE classes.oid = approval_oid) <> administrator_oid
    OR (SELECT classes.relpersistence FROM pg_catalog.pg_class AS classes
        WHERE classes.oid = approval_oid) <> 'p'
    OR (SELECT classes.relrowsecurity OR classes.relforcerowsecurity
        FROM pg_catalog.pg_class AS classes
        WHERE classes.oid = approval_oid)
    OR (SELECT classes.relreplident FROM pg_catalog.pg_class AS classes
        WHERE classes.oid = approval_oid) <> 'd'
    OR (SELECT classes.relispartition FROM pg_catalog.pg_class AS classes
        WHERE classes.oid = approval_oid)
    OR (SELECT classes.reloptions FROM pg_catalog.pg_class AS classes
        WHERE classes.oid = approval_oid) IS NOT NULL
    OR COALESCE(
      (SELECT classes.relacl FROM pg_catalog.pg_class AS classes
       WHERE classes.oid = approval_oid),
      pg_catalog.acldefault('r', administrator_oid)
    ) <> pg_catalog.acldefault('r', administrator_oid)
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_class AS classes
        WHERE classes.relnamespace = approval_schema_oid) <> 2
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_class AS classes
      WHERE classes.relnamespace = approval_schema_oid
        AND classes.oid <> approval_oid
        AND NOT (
          classes.relkind = 'i'
          AND EXISTS (
            SELECT 1 FROM pg_catalog.pg_index AS indexes
            WHERE indexes.indexrelid = classes.oid
              AND indexes.indrelid = approval_oid
              AND indexes.indisprimary
              AND indexes.indisunique
              AND indexes.indisvalid
              AND indexes.indisready
              AND indexes.indislive
              AND indexes.indimmediate
              AND NOT indexes.indisreplident
              AND indexes.indnkeyatts = 1
              AND indexes.indnatts = 1
              AND indexes.indkey = '1'::pg_catalog.int2vector
              AND indexes.indexprs IS NULL
              AND indexes.indpred IS NULL
          )
        )
    )
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_index AS indexes
        WHERE indexes.indrelid = approval_oid) <> 1
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_attribute AS attributes
        WHERE attributes.attrelid = approval_oid
          AND attributes.attnum > 0
          AND NOT attributes.attisdropped) <> 5
    OR EXISTS (
      SELECT 1
      FROM (VALUES
        (1, 'singleton'::name, 'pg_catalog.bool'::pg_catalog.regtype, true),
        (2, 'policy_version'::name, 'pg_catalog.text'::pg_catalog.regtype, true),
        (3, 'system_identifier'::name, 'pg_catalog.numeric'::pg_catalog.regtype, true),
        (4, 'current_policy_digest'::name, 'pg_catalog.text'::pg_catalog.regtype, true),
        (5, 'previous_policy_digest'::name, 'pg_catalog.text'::pg_catalog.regtype, false)
      ) AS expected(attnum, attname, atttypid, attnotnull)
      LEFT JOIN pg_catalog.pg_attribute AS attributes
        ON attributes.attrelid = approval_oid
       AND attributes.attnum = expected.attnum
       AND NOT attributes.attisdropped
      WHERE attributes.attname IS DISTINCT FROM expected.attname
         OR attributes.atttypid IS DISTINCT FROM expected.atttypid
         OR attributes.attnotnull IS DISTINCT FROM expected.attnotnull
         OR attributes.atthasdef
         OR attributes.attidentity <> ''
         OR attributes.attgenerated <> ''
    )
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint AS constraints
        WHERE constraints.conrelid = approval_oid) <> 10
    OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint AS constraints
      WHERE constraints.conrelid = approval_oid
        AND constraints.conname = 'reconciliation_approval_primary_key'
        AND constraints.contype = 'p'
        AND constraints.conkey = ARRAY[1]::smallint[]
        AND NOT constraints.condeferrable
        AND NOT constraints.condeferred
        AND constraints.convalidated
        AND constraints.connoinherit
    )
    OR EXISTS (
      SELECT 1
      FROM (VALUES
        ('reconciliation_approval_singleton_not_null'::name, ARRAY[1]::smallint[]),
        ('reconciliation_approval_policy_version_not_null'::name, ARRAY[2]::smallint[]),
        ('reconciliation_approval_system_identifier_not_null'::name, ARRAY[3]::smallint[]),
        ('reconciliation_approval_current_policy_digest_not_null'::name, ARRAY[4]::smallint[])
      ) AS expected(constraint_name, constrained_columns)
      LEFT JOIN pg_catalog.pg_constraint AS constraints
        ON constraints.conrelid = approval_oid
       AND constraints.conname = expected.constraint_name
       AND constraints.contype = 'n'
      WHERE constraints.oid IS NULL
         OR constraints.conkey IS DISTINCT FROM expected.constrained_columns
         OR NOT constraints.convalidated
         OR constraints.connoinherit
    )
    OR EXISTS (
      SELECT 1
      FROM (VALUES
        ('reconciliation_approval_singleton_true'::name, 'CHECK (singleton)'::text),
        ('reconciliation_approval_policy_version'::name, 'CHECK ((policy_version = ''sanitized-capabilities-v1''::text))'::text),
        ('reconciliation_approval_system_identifier'::name, 'CHECK ((system_identifier > (0)::numeric))'::text),
        ('reconciliation_approval_current_digest'::name, 'CHECK ((current_policy_digest ~ ''^[0-9a-f]{64}$''::text))'::text),
        ('reconciliation_approval_previous_digest'::name, 'CHECK (((previous_policy_digest IS NULL) OR (previous_policy_digest ~ ''^[0-9a-f]{64}$''::text)))'::text)
      ) AS expected(constraint_name, definition)
      LEFT JOIN pg_catalog.pg_constraint AS constraints
        ON constraints.conrelid = approval_oid
       AND constraints.conname = expected.constraint_name
       AND constraints.contype = 'c'
      WHERE constraints.oid IS NULL
         OR NOT constraints.convalidated
         OR constraints.connoinherit
         OR pg_catalog.pg_get_constraintdef(constraints.oid, false)
              IS DISTINCT FROM expected.definition
    )
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_trigger AS triggers
      WHERE triggers.tgrelid = approval_oid AND NOT triggers.tgisinternal
    )
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_rewrite AS rules
      WHERE rules.ev_class = approval_oid
    )
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_policy AS policies
      WHERE policies.polrelid = approval_oid
    )
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_inherits AS inheritance
      WHERE inheritance.inhrelid = approval_oid
         OR inheritance.inhparent = approval_oid
    )
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc AS routines
      WHERE routines.pronamespace = approval_schema_oid
    )
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_type AS types
        WHERE types.typnamespace = approval_schema_oid) <> 2
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_type AS types
      WHERE types.typnamespace = approval_schema_oid
        AND (
          types.typowner <> administrator_oid
          OR types.oid NOT IN (
            (SELECT classes.reltype FROM pg_catalog.pg_class AS classes
             WHERE classes.oid = approval_oid),
            (SELECT row_types.typarray FROM pg_catalog.pg_type AS row_types
             WHERE row_types.oid = (
               SELECT classes.reltype FROM pg_catalog.pg_class AS classes
               WHERE classes.oid = approval_oid
             ))
          )
        )
    )
  THEN
    RAISE EXCEPTION 'Database observability reconciliation approval boundary is invalid';
  END IF;
END
$approval_exact_boundary$;

INSERT INTO mira_dashboard_observability_control.reconciliation_approval (
  singleton,
  policy_version,
  system_identifier,
  current_policy_digest,
  previous_policy_digest
)
SELECT true,
       'sanitized-capabilities-v1',
       controls.system_identifier,
       pg_catalog.current_setting('mira_dashboard.current_policy_digest'),
       NULL
FROM pg_catalog.pg_control_system() AS controls
ON CONFLICT (singleton) DO UPDATE
SET policy_version = EXCLUDED.policy_version,
    system_identifier = EXCLUDED.system_identifier,
    previous_policy_digest = CASE
      WHEN mira_dashboard_observability_control.reconciliation_approval
             .current_policy_digest = EXCLUDED.current_policy_digest
      THEN mira_dashboard_observability_control.reconciliation_approval
             .previous_policy_digest
      ELSE mira_dashboard_observability_control.reconciliation_approval
             .current_policy_digest
    END,
    current_policy_digest = EXCLUDED.current_policy_digest;

COMMIT;

\set approved_policy_digest :current_policy_digest
\ir verify-reconciliation-approval.sql
