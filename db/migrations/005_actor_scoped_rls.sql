CREATE FUNCTION public.app_current_actor() RETURNS uuid LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('productops.actor_id', true), '')::uuid $$;

DROP POLICY tenant_select ON public.agent_runs;
CREATE POLICY tenant_select ON public.agent_runs FOR SELECT TO productops_app
  USING (org_id = public.app_current_org() AND actor_id = public.app_current_actor());

DROP POLICY tenant_insert ON public.agent_runs;
CREATE POLICY tenant_insert ON public.agent_runs FOR INSERT TO productops_app
  WITH CHECK (org_id = public.app_current_org() AND actor_id = public.app_current_actor() AND status = 'running');

DROP POLICY tenant_finish ON public.agent_runs;
CREATE POLICY tenant_finish ON public.agent_runs FOR UPDATE TO productops_app
  USING (org_id = public.app_current_org() AND actor_id = public.app_current_actor() AND status = 'running')
  WITH CHECK (org_id = public.app_current_org() AND actor_id = public.app_current_actor());

DROP POLICY tenant_append ON public.tool_audit_events;
CREATE POLICY tenant_append ON public.tool_audit_events FOR INSERT TO productops_app
  WITH CHECK (org_id = public.app_current_org() AND actor_id = public.app_current_actor());
