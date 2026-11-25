ALTER TABLE public.policy_snippets
  ADD COLUMN topic text,
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  ADD CHECK (topic IS NULL OR topic IN ('shipping_delay','returns','warranty'));
CREATE UNIQUE INDEX policy_snippets_org_topic ON public.policy_snippets(org_id, topic) WHERE topic IS NOT NULL;

CREATE TABLE public.tool_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES public.organizations ON DELETE CASCADE,
  actor_id uuid NOT NULL,
  tool_name text CHECK (tool_name IN ('list_low_stock_products','get_order_status','get_policy_snippet')),
  decision text NOT NULL CHECK (decision IN ('allowed','denied')),
  status text NOT NULL CHECK (status IN ('ok','not_found','invalid_input','unknown_tool','forbidden','rate_limited','timeout','error')),
  error_code text CHECK (length(error_code) <= 64),
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tool_audit_events_org_created ON public.tool_audit_events(org_id, created_at);
ALTER TABLE public.tool_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tool_audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_append ON public.tool_audit_events FOR INSERT TO productops_app
  WITH CHECK (org_id = public.app_current_org());
REVOKE ALL ON public.tool_audit_events FROM productops_app;
GRANT INSERT ON public.tool_audit_events TO productops_app;
-- Dedicated non-runtime identity: FORCE RLS stays on; this is NOT BYPASSRLS.
CREATE POLICY bootstrap_access ON public.tool_audit_events FOR ALL TO productops_bootstrap USING(true) WITH CHECK(true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tool_audit_events TO productops_bootstrap;
