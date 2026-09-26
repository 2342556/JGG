-- Supabase security advisor 0011: pin search_path on functions.
ALTER FUNCTION jgg.current_user_id() SET search_path = '';
ALTER FUNCTION jgg.check_journal_balanced() SET search_path = '';
