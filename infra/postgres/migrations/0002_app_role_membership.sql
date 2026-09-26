-- Allow the migration/admin role to assume jgg_app (used for RLS verification and pooler setup).
DO $$ BEGIN EXECUTE format('GRANT jgg_app TO %I', current_user); END $$;
