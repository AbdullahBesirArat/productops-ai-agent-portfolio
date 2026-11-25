REVOKE EXECUTE ON FUNCTION public.app_current_org(), public.app_current_actor() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_current_org(), public.app_current_actor() TO productops_app;
-- The existing review trigger evaluates actor context on bootstrap writes.
GRANT EXECUTE ON FUNCTION public.app_current_actor() TO productops_bootstrap;
