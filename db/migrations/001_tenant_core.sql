CREATE TABLE public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz DEFAULT now()
);
CREATE TABLE public.memberships (
  org_id uuid REFERENCES public.organizations ON DELETE CASCADE,
  user_id uuid REFERENCES public.users ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  PRIMARY KEY (org_id, user_id)
);
CREATE TABLE public.projects (
  id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES public.organizations ON DELETE CASCADE,
  name text NOT NULL
);
CREATE FUNCTION public.app_current_org() RETURNS uuid LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('productops.org_id', true), '')::uuid $$;

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects FORCE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_org ON public.organizations FOR ALL TO productops_app
  USING (id = public.app_current_org()) WITH CHECK (id = public.app_current_org());
CREATE POLICY tenant_membership ON public.memberships FOR ALL TO productops_app
  USING (org_id = public.app_current_org()) WITH CHECK (org_id = public.app_current_org());
CREATE POLICY tenant_project ON public.projects FOR ALL TO productops_app
  USING (org_id = public.app_current_org()) WITH CHECK (org_id = public.app_current_org());
-- Users have no tenant column or PII. Visibility requires a current-org membership;
-- context permits creating an opaque identity, but never changing/deleting identities.
REVOKE ALL ON public.users FROM productops_app;
GRANT SELECT, INSERT ON public.users TO productops_app;
CREATE POLICY user_visibility ON public.users FOR SELECT TO productops_app
  USING (EXISTS (SELECT 1 FROM public.memberships m
    WHERE m.user_id = users.id AND m.org_id = public.app_current_org()));
CREATE POLICY user_creation ON public.users FOR INSERT TO productops_app
  WITH CHECK (public.app_current_org() IS NOT NULL);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organizations, public.memberships, public.projects TO productops_app;
