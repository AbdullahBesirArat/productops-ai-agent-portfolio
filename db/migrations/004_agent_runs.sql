-- T4: agent run records (idempotency + run-level audit) and run correlation for tool audit rows. Additive only.
ALTER TABLE public.tool_audit_events
  ADD COLUMN run_id uuid,
  ADD COLUMN step smallint CHECK (step IS NULL OR step BETWEEN 0 AND 20);
CREATE INDEX tool_audit_events_run ON public.tool_audit_events(run_id) WHERE run_id IS NOT NULL;

-- One row per agent run. It stores NO raw user request (only a SHA-256 of the normalised text), no model prompt,
-- no token and no credential. `response` holds the sanitised HTTP body that was returned (tenant business data that the
-- caller already received); it exists only so an idempotent replay never re-executes tools.
CREATE TABLE public.agent_runs (
  id uuid PRIMARY KEY,
  trace_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES public.organizations ON DELETE CASCADE,
  actor_id uuid NOT NULL,
  idempotency_key text CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9_-]{8,64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('running','completed','unverified','refused','budget_exceeded',
    'invalid_model_output','rejected_tool_call','forbidden','timeout','model_error','error')),
  error_code text CHECK (error_code IS NULL OR length(error_code) <= 64),
  tool_calls smallint NOT NULL DEFAULT 0 CHECK (tool_calls BETWEEN 0 AND 20),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX agent_runs_idempotency ON public.agent_runs(org_id, actor_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX agent_runs_org_created ON public.agent_runs(org_id, created_at);
ALTER TABLE public.agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_runs FORCE ROW LEVEL SECURITY;

-- Runtime: may create a run, read runs of the current tenant (the code additionally filters by actor), and finish a run
-- exactly once: UPDATE is limited to the outcome columns and, by policy, only while the row is still 'running'.
REVOKE ALL ON public.agent_runs FROM productops_app;
GRANT SELECT, INSERT ON public.agent_runs TO productops_app;
GRANT UPDATE (status, error_code, tool_calls, duration_ms, response) ON public.agent_runs TO productops_app;
CREATE POLICY tenant_select ON public.agent_runs FOR SELECT TO productops_app USING (org_id = public.app_current_org());
CREATE POLICY tenant_insert ON public.agent_runs FOR INSERT TO productops_app
  WITH CHECK (org_id = public.app_current_org() AND status = 'running');
CREATE POLICY tenant_finish ON public.agent_runs FOR UPDATE TO productops_app
  USING (org_id = public.app_current_org() AND status = 'running') WITH CHECK (org_id = public.app_current_org());
-- Dedicated non-runtime identity (fixtures/tests); FORCE RLS stays on and this role is NOT BYPASSRLS.
CREATE POLICY bootstrap_access ON public.agent_runs FOR ALL TO productops_bootstrap USING(true) WITH CHECK(true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_runs TO productops_bootstrap;
