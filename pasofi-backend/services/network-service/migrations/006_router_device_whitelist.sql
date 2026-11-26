ALTER TABLE router_fleet_changes DROP CONSTRAINT router_fleet_changes_target_kind_check;
ALTER TABLE router_fleet_changes ADD CONSTRAINT router_fleet_changes_target_kind_check
 CHECK (target_kind IN ('identity','interface','wireless','wifi','hotspot-profile','device-whitelist'));
