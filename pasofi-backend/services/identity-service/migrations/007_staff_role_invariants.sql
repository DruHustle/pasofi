-- PostgreSQL CHECK accepts NULL, so the approved-role requirement must be
-- explicit even though route validation also rejects an omitted role.
ALTER TABLE staff_users ADD CONSTRAINT staff_approved_role_required
  CHECK (status <> 'approved' OR role IS NOT NULL);
ALTER TABLE staff_users ADD CONSTRAINT staff_site_ids_not_null
  CHECK (array_position(site_ids, NULL) IS NULL);
