-- Check the required initialization objects without writing a marker. This is
-- not a substitute for migration, password, schema or full privilege testing.
WITH services(suffix) AS (
  VALUES ('identity'), ('prepaid_access'), ('network'), ('notification'), ('assistant')
)
SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM services s
  LEFT JOIN pg_roles owner_role ON owner_role.rolname = 'pamofi_' || s.suffix || '_owner'
  LEFT JOIN pg_roles migration_role ON migration_role.rolname = 'pamofi_' || s.suffix || '_migrate'
  LEFT JOIN pg_roles runtime_role ON runtime_role.rolname = 'pamofi_' || s.suffix || '_runtime'
  LEFT JOIN pg_database db ON db.datname = 'pamofi_' || s.suffix
  WHERE owner_role.oid IS NULL OR owner_role.rolcanlogin OR owner_role.rolsuper
     OR migration_role.oid IS NULL OR NOT migration_role.rolcanlogin OR migration_role.rolsuper
     OR runtime_role.oid IS NULL OR NOT runtime_role.rolcanlogin OR runtime_role.rolsuper
     OR db.oid IS NULL OR NOT db.datallowconn OR db.datdba IS DISTINCT FROM owner_role.oid
     OR NOT COALESCE(pg_has_role(migration_role.oid, owner_role.oid, 'MEMBER'), false)
     OR NOT COALESCE(has_database_privilege(migration_role.oid, db.oid, 'CONNECT'), false)
     OR NOT COALESCE(has_database_privilege(runtime_role.oid, db.oid, 'CONNECT'), false)
) AND NOT EXISTS (
  -- The last init step removes PUBLIC privileges on these maintenance
  -- databases. Service databases must also retain their private grants.
  SELECT 1 FROM pg_database db
  CROSS JOIN LATERAL aclexplode(COALESCE(db.datacl, acldefault('d', db.datdba))) permission
  WHERE (db.datname IN ('postgres', 'template1')
         OR db.datname IN (SELECT 'pamofi_' || suffix FROM services))
    AND permission.grantee = 0
) THEN 'ready' ELSE 'incomplete' END;
