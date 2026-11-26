-- Only creates an unprivileged applicant and binds the new record. Existing
-- staff are never adopted by email or overwritten by a sign-in.
CREATE FUNCTION public.create_managed_staff_applicant(record_issuer text, account_id uuid, verified_email text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  new_staff_id uuid;
BEGIN
  IF record_issuer IS NULL OR account_id IS NULL OR verified_email IS NULL OR
     verified_email <> lower(verified_email) OR length(verified_email) > 254 OR
     verified_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    RETURN false;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(record_issuer || ':' || account_id::text, 0));
  IF EXISTS (SELECT 1 FROM public.staff_onesa_bindings WHERE issuer=record_issuer AND subject=account_id) THEN
    RETURN false;
  END IF;
  INSERT INTO public.staff_users(id,email,display_name,password_hash)
  VALUES (gen_random_uuid(), verified_email, left(verified_email,80), 'disabled')
  ON CONFLICT(email) DO NOTHING RETURNING id INTO new_staff_id;
  IF new_staff_id IS NULL THEN RETURN false; END IF;
  INSERT INTO public.staff_onesa_bindings(issuer,subject,staff_id)
  VALUES(record_issuer,account_id,new_staff_id);
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.create_managed_staff_applicant(text,uuid,text) FROM PUBLIC;
