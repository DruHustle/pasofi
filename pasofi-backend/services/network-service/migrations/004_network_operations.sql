ALTER TABLE radius_nas ADD COLUMN site_name text NOT NULL DEFAULT 'PamoFi site' CHECK (char_length(site_name) BETWEEN 1 AND 100);
ALTER TABLE radius_nas ADD COLUMN login_url text;
CREATE TABLE router_reconciliation_status (
 grant_id uuid PRIMARY KEY,
 nas_id uuid NOT NULL REFERENCES radius_nas(id),
 generation uuid NOT NULL,
 session_id text NOT NULL,
 result text NOT NULL CHECK (result IN ('absent','present','unavailable')),
 observed_at timestamptz NOT NULL DEFAULT now()
);
