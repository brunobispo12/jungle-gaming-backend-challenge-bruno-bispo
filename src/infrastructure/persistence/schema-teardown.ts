// Reverting a migration that widened a rule cannot restore the narrower one over
// rows the wider rule allowed, so recreating a disposable database drops instead
// of walking down. Never point this at a database anyone depends on.
export const DROP_SCHEMA_OBJECTS = `
  DO $$
  DECLARE target record;
  BEGIN
    FOR target IN
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    LOOP
      EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', target.tablename);
    END LOOP;

    FOR target IN
      SELECT p.oid::regprocedure AS signature
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
    LOOP
      EXECUTE format('DROP FUNCTION IF EXISTS %s CASCADE', target.signature);
    END LOOP;

    FOR target IN
      SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typtype = 'e'
    LOOP
      EXECUTE format('DROP TYPE IF EXISTS public.%I CASCADE', target.typname);
    END LOOP;
  END $$;
`;
