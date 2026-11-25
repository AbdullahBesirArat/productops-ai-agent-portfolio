REVOKE EXECUTE ON FUNCTION public.auth_login_lookup(text, text) FROM PUBLIC, productops_app;
GRANT EXECUTE ON FUNCTION public.auth_login_lookup(text, text) TO productops_authsvc;

CREATE FUNCTION public.auth_membership_exists(p_org_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships AS m
    WHERE m.org_id = p_org_id AND m.user_id = p_user_id
      AND m.role IN ('owner', 'member', 'viewer')
  )
$$;
ALTER FUNCTION public.auth_membership_exists(uuid, uuid) OWNER TO productops_auth;
REVOKE ALL ON FUNCTION public.auth_membership_exists(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_membership_exists(uuid, uuid) TO productops_authsvc;
