-- Temporary policies let the non-bypass migrator backfill existing FORCE RLS rows.
CREATE POLICY migration_backfill ON public.organizations FOR ALL TO productops_migrator USING(true) WITH CHECK(true);
CREATE POLICY migration_backfill ON public.users FOR ALL TO productops_migrator USING(true) WITH CHECK(true);
CREATE POLICY migration_backfill ON public.memberships FOR ALL TO productops_migrator USING(true) WITH CHECK(true);
ALTER TABLE public.organizations ADD COLUMN slug text;
UPDATE public.organizations SET slug='org-' || substr(id::text,1,8);
ALTER TABLE public.organizations ALTER COLUMN slug SET NOT NULL;
ALTER TABLE public.organizations ADD UNIQUE(slug), ADD CHECK(slug ~ '^[a-z0-9-]{3,40}$');
ALTER TABLE public.users ADD COLUMN email text;
UPDATE public.users SET email='legacy-' || id || '@example.test';
ALTER TABLE public.users ALTER COLUMN email SET NOT NULL;
ALTER TABLE public.users ADD UNIQUE(email), ADD CHECK(email=lower(email) AND length(email)<=254);
ALTER TABLE public.memberships DROP CONSTRAINT memberships_role_check;
UPDATE public.memberships SET role='member' WHERE role='admin';
ALTER TABLE public.memberships ADD CHECK(role IN ('owner','member','viewer'));
CREATE TABLE public.user_credentials (
 user_id uuid PRIMARY KEY REFERENCES public.users ON DELETE CASCADE,
 password_hash text NOT NULL, updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.products (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES public.organizations ON DELETE CASCADE,
 sku text NOT NULL,name text NOT NULL,stock integer NOT NULL CHECK(stock>=0),
 reorder_level integer NOT NULL CHECK(reorder_level>=0),UNIQUE(org_id,sku)
);
CREATE TABLE public.orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL REFERENCES public.organizations ON DELETE CASCADE,
 order_code text NOT NULL,customer_ref text NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','paid','shipped','cancelled')),
 status_updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(org_id,order_code)
);
CREATE TABLE public.policy_snippets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL REFERENCES public.organizations ON DELETE CASCADE,
 slug text NOT NULL,title text NOT NULL,body text NOT NULL,UNIQUE(org_id,slug)
);
CREATE INDEX products_org_stock ON public.products(org_id,stock);
CREATE INDEX orders_org_status ON public.orders(org_id,status);
REVOKE INSERT,UPDATE,DELETE ON public.organizations,public.users,public.memberships FROM productops_app;
REVOKE ALL ON public.user_credentials,public.products,public.orders,public.policy_snippets FROM productops_app;
GRANT SELECT ON public.products,public.orders,public.policy_snippets TO productops_app;
ALTER TABLE public.user_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products FORCE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders FORCE ROW LEVEL SECURITY;
ALTER TABLE public.policy_snippets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.policy_snippets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON public.products FOR SELECT TO productops_app USING(org_id=public.app_current_org());
CREATE POLICY tenant_read ON public.orders FOR SELECT TO productops_app USING(org_id=public.app_current_org());
CREATE POLICY tenant_read ON public.policy_snippets FOR SELECT TO productops_app USING(org_id=public.app_current_org());
-- Dedicated non-runtime identity: FORCE RLS stays on; this is NOT BYPASSRLS.
CREATE POLICY bootstrap_access ON public.organizations FOR ALL TO productops_bootstrap USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.organizations TO productops_bootstrap;
CREATE POLICY bootstrap_access ON public.users FOR ALL TO productops_bootstrap USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.users TO productops_bootstrap;
CREATE POLICY bootstrap_access ON public.memberships FOR ALL TO productops_bootstrap USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.memberships TO productops_bootstrap;
CREATE POLICY bootstrap_access ON public.projects FOR ALL TO productops_bootstrap USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.projects TO productops_bootstrap;
CREATE POLICY bootstrap_access ON public.user_credentials FOR ALL TO productops_bootstrap USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.user_credentials TO productops_bootstrap;
CREATE POLICY bootstrap_access ON public.products FOR ALL TO productops_bootstrap USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.products TO productops_bootstrap;
CREATE POLICY bootstrap_access ON public.orders FOR ALL TO productops_bootstrap USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.orders TO productops_bootstrap;
CREATE POLICY bootstrap_access ON public.policy_snippets FOR ALL TO productops_bootstrap USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.policy_snippets TO productops_bootstrap;
CREATE POLICY auth_read ON public.organizations FOR SELECT TO productops_auth USING(true);
GRANT SELECT ON public.organizations TO productops_auth;
CREATE POLICY auth_read ON public.users FOR SELECT TO productops_auth USING(true);
GRANT SELECT ON public.users TO productops_auth;
CREATE POLICY auth_read ON public.memberships FOR SELECT TO productops_auth USING(true);
GRANT SELECT ON public.memberships TO productops_auth;
CREATE POLICY auth_read ON public.user_credentials FOR SELECT TO productops_auth USING(true);
GRANT SELECT ON public.user_credentials TO productops_auth;
-- Login has no tenant context: this definer is the only pre-auth read path.
-- Candidate (slug,email) must match a membership; output is minimal, avoiding
-- RLS/auth circularity. Later requests restore tenant context from the signed token.
-- Init grants migrator membership and auth schema CREATE for ownership transfer.
CREATE FUNCTION public.auth_login_lookup(p_org_slug text,p_email text)
RETURNS TABLE(user_id uuid,org_id uuid,password_hash text,role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
 SELECT u.id,o.id,c.password_hash,m.role FROM public.organizations o
 JOIN public.memberships m ON m.org_id=o.id
 JOIN public.users u ON u.id=m.user_id JOIN public.user_credentials c ON c.user_id=u.id
 WHERE o.slug=p_org_slug AND u.email=p_email AND p_email=pg_catalog.lower(p_email)
 LIMIT 1
$$;
ALTER FUNCTION public.auth_login_lookup(text,text) OWNER TO productops_auth;
REVOKE ALL ON FUNCTION public.auth_login_lookup(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_login_lookup(text,text) TO productops_app;

DROP POLICY migration_backfill ON public.organizations;
DROP POLICY migration_backfill ON public.users;
DROP POLICY migration_backfill ON public.memberships;
