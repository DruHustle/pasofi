ALTER TABLE invoice_jobs
 DROP CONSTRAINT invoice_jobs_invoice_id_key,
 ADD COLUMN resend_request_id uuid UNIQUE,
 ADD COLUMN resend_actor_id uuid,
 ADD COLUMN resend_actor_scope text CHECK(resend_actor_scope IN ('customer','staff')),
 ADD COLUMN resend_channel text CHECK(resend_channel IN ('email','sms')),
 ADD CONSTRAINT invoice_resend_audit CHECK(
   ((resend_request_id IS NOT NULL) = (resend_actor_id IS NOT NULL))
   AND ((resend_request_id IS NOT NULL) = (resend_actor_scope IS NOT NULL))
   AND ((resend_request_id IS NOT NULL) = (resend_channel IS NOT NULL))
 );
CREATE UNIQUE INDEX invoice_first_job ON invoice_jobs(invoice_id) WHERE resend_request_id IS NULL;
CREATE INDEX invoice_job_history ON invoice_jobs(invoice_id,created_at DESC,id DESC);
