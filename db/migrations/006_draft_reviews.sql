CREATE TABLE public.draft_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations ON DELETE CASCADE,
  created_by uuid NOT NULL,
  intent text NOT NULL CHECK (intent IN ('order_status','low_stock','shipping_delay','returns','warranty','general_question','unknown')),
  language text NOT NULL CHECK (language IN ('tr','en')),
  evidence_status text NOT NULL CHECK (evidence_status IN ('verified','not_found','unverified','contradictory','needs_information','not_required')),
  state text NOT NULL CHECK (state IN ('pending_review','edited','blocked','approved_internal','rejected')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  current_revision integer NOT NULL DEFAULT 1 CHECK (current_revision >= 1),
  approved_revision integer,
  ownership_status text NOT NULL DEFAULT 'unverified' CHECK (ownership_status = 'unverified'),
  customer_specific_details_allowed boolean NOT NULL DEFAULT false CHECK (customer_specific_details_allowed = false),
  send_enabled boolean NOT NULL DEFAULT false CHECK (send_enabled = false),
  internal_evidence jsonb NOT NULL CHECK (octet_length(internal_evidence::text) <= 20000),
  internal_operator_notes text[] NOT NULL DEFAULT '{}',
  disclosure jsonb NOT NULL CHECK (octet_length(disclosure::text) <= 4000),
  decided_by uuid,
  decided_at timestamptz,
  decision_reason_code text CHECK (decision_reason_code IN ('inaccurate','unsafe_disclosure','out_of_scope','duplicate','other')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  CHECK ((decided_by IS NOT NULL) = (state IN ('approved_internal','rejected'))),
  CHECK ((decided_at IS NOT NULL) = (state IN ('approved_internal','rejected'))),
  CHECK ((decision_reason_code IS NOT NULL) = (state = 'rejected')),
  CHECK ((approved_revision IS NOT NULL) = (state = 'approved_internal')),
  CHECK (approved_revision IS NULL OR approved_revision = current_revision)
);

CREATE TABLE public.draft_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id uuid NOT NULL,
  org_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  author_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('system','operator')),
  customer_text text NOT NULL CHECK (char_length(customer_text) BETWEEN 1 AND 1500),
  text_sha256 text NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
  check_status text NOT NULL CHECK (check_status IN ('passed','blocked')),
  check_codes text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (review_id, org_id) REFERENCES public.draft_reviews(id, org_id) ON DELETE CASCADE,
  UNIQUE (review_id, revision)
);

CREATE TABLE public.draft_review_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id uuid NOT NULL,
  org_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('created','edited','edit_blocked','approved_internal','rejected')),
  from_state text CHECK (from_state IN ('pending_review','edited','blocked')),
  to_state text NOT NULL CHECK (to_state IN ('pending_review','edited','blocked','approved_internal','rejected')),
  revision integer NOT NULL CHECK (revision >= 1),
  review_version integer NOT NULL CHECK (review_version >= 1),
  reason_code text CHECK (reason_code IN ('inaccurate','unsafe_disclosure','out_of_scope','duplicate','other')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (review_id, org_id) REFERENCES public.draft_reviews(id, org_id) ON DELETE CASCADE,
  CHECK ((event_type = 'rejected') = (reason_code IS NOT NULL)),
  CHECK ((event_type = 'created') = (from_state IS NULL)),
  CHECK (to_state = CASE event_type WHEN 'created' THEN 'pending_review' WHEN 'edit_blocked' THEN 'blocked' ELSE event_type END)
);

CREATE INDEX draft_reviews_org_state_created ON public.draft_reviews(org_id, state, created_at DESC, id);
CREATE INDEX draft_review_events_review_created ON public.draft_review_events(review_id, created_at);

ALTER TABLE public.draft_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.draft_reviews FORCE ROW LEVEL SECURITY;
ALTER TABLE public.draft_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.draft_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.draft_review_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.draft_review_events FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.draft_reviews, public.draft_revisions, public.draft_review_events FROM PUBLIC, productops_app;
GRANT SELECT, INSERT ON public.draft_reviews, public.draft_revisions, public.draft_review_events TO productops_app;
GRANT UPDATE (state, version, current_revision, approved_revision, decided_by, decided_at, decision_reason_code, updated_at)
  ON public.draft_reviews TO productops_app;

CREATE POLICY tenant_select ON public.draft_reviews FOR SELECT TO productops_app
  USING (org_id = public.app_current_org() AND public.app_current_actor() IS NOT NULL);
CREATE POLICY tenant_insert ON public.draft_reviews FOR INSERT TO productops_app
  WITH CHECK (org_id = public.app_current_org() AND created_by = public.app_current_actor()
    AND state = 'pending_review' AND version = 1 AND current_revision = 1);
CREATE POLICY tenant_transition ON public.draft_reviews FOR UPDATE TO productops_app
  USING (org_id = public.app_current_org() AND state IN ('pending_review','edited','blocked'))
  WITH CHECK (org_id = public.app_current_org());
CREATE POLICY tenant_select ON public.draft_revisions FOR SELECT TO productops_app
  USING (org_id = public.app_current_org() AND public.app_current_actor() IS NOT NULL);
CREATE POLICY tenant_insert ON public.draft_revisions FOR INSERT TO productops_app
  WITH CHECK (org_id = public.app_current_org() AND author_id = public.app_current_actor());
CREATE POLICY tenant_select ON public.draft_review_events FOR SELECT TO productops_app
  USING (org_id = public.app_current_org() AND public.app_current_actor() IS NOT NULL);
CREATE POLICY tenant_insert ON public.draft_review_events FOR INSERT TO productops_app
  WITH CHECK (org_id = public.app_current_org() AND actor_id = public.app_current_actor());

-- Dedicated test and fixture identity. FORCE RLS stays enabled. This role has no BYPASSRLS.
CREATE POLICY bootstrap_access ON public.draft_reviews FOR ALL TO productops_bootstrap USING (true) WITH CHECK (true);
CREATE POLICY bootstrap_access ON public.draft_revisions FOR ALL TO productops_bootstrap USING (true) WITH CHECK (true);
CREATE POLICY bootstrap_access ON public.draft_review_events FOR ALL TO productops_bootstrap USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.draft_reviews, public.draft_revisions, public.draft_review_events TO productops_bootstrap;

CREATE FUNCTION public.enforce_draft_review_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  actor uuid := public.app_current_actor();
  revision_row public.draft_revisions%ROWTYPE;
BEGIN
  IF ROW(NEW.id, NEW.org_id, NEW.created_by, NEW.intent, NEW.language, NEW.evidence_status, NEW.ownership_status,
         NEW.customer_specific_details_allowed, NEW.send_enabled, NEW.internal_evidence, NEW.internal_operator_notes,
         NEW.disclosure, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.org_id, OLD.created_by, OLD.intent, OLD.language, OLD.evidence_status, OLD.ownership_status,
         OLD.customer_specific_details_allowed, OLD.send_enabled, OLD.internal_evidence, OLD.internal_operator_notes,
         OLD.disclosure, OLD.created_at) THEN
    RAISE EXCEPTION 'immutable_review' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
    RAISE EXCEPTION 'stale_version' USING ERRCODE = 'P0001';
  END IF;
  IF NOT COALESCE(
    (OLD.state IN ('pending_review','edited') AND NEW.state IN ('edited','blocked','approved_internal','rejected'))
    OR (OLD.state = 'blocked' AND NEW.state IN ('edited','blocked','rejected')), false) THEN
    RAISE EXCEPTION 'illegal_transition' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.state IN ('edited','blocked') THEN
    IF NEW.current_revision IS DISTINCT FROM OLD.current_revision + 1 THEN
      RAISE EXCEPTION 'invalid_revision' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO revision_row FROM public.draft_revisions
      WHERE review_id = OLD.id AND org_id = OLD.org_id AND revision = NEW.current_revision;
    IF NOT FOUND OR actor IS NULL OR revision_row.author_id <> actor OR revision_row.kind <> 'operator'
      OR revision_row.check_status <> (CASE WHEN NEW.state = 'edited' THEN 'passed' ELSE 'blocked' END) THEN
      RAISE EXCEPTION 'invalid_revision' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    IF NEW.current_revision IS DISTINCT FROM OLD.current_revision OR actor IS NULL
      OR NEW.decided_by IS DISTINCT FROM actor OR NEW.decided_at IS NULL
      OR (NEW.state = 'rejected' AND NEW.decision_reason_code IS NULL) THEN
      RAISE EXCEPTION 'invalid_decision' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO revision_row FROM public.draft_revisions
      WHERE review_id = OLD.id AND org_id = OLD.org_id AND revision = NEW.current_revision;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invalid_revision' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.state = 'approved_internal' THEN
      IF actor = OLD.created_by OR actor = revision_row.author_id THEN
        RAISE EXCEPTION 'self_approval' USING ERRCODE = 'P0001';
      END IF;
      IF NEW.approved_revision IS DISTINCT FROM NEW.current_revision THEN
        RAISE EXCEPTION 'invalid_revision' USING ERRCODE = 'P0001';
      END IF;
      IF revision_row.check_status <> 'passed' THEN
        RAISE EXCEPTION 'blocked_for_customer_use' USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.enforce_draft_revision_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  review_row public.draft_reviews%ROWTYPE;
  next_revision integer;
BEGIN
  SELECT * INTO review_row FROM public.draft_reviews
    WHERE id = NEW.review_id AND org_id = NEW.org_id
      AND state IN ('pending_review','edited','blocked') FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'illegal_transition' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(max(revision), 0) + 1 INTO next_revision FROM public.draft_revisions
    WHERE review_id = NEW.review_id AND org_id = NEW.org_id;
  IF NEW.revision IS DISTINCT FROM next_revision OR NEW.revision > review_row.current_revision + 1 THEN
    RAISE EXCEPTION 'invalid_revision' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.revision = 1 AND (NEW.kind <> 'system' OR NEW.author_id <> review_row.created_by OR NEW.check_status <> 'passed'))
    OR (NEW.revision > 1 AND NEW.kind <> 'operator') THEN
    RAISE EXCEPTION 'invalid_revision' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_draft_review_transition(), public.enforce_draft_revision_insert() FROM PUBLIC;
CREATE TRIGGER draft_review_transition BEFORE UPDATE ON public.draft_reviews
  FOR EACH ROW EXECUTE FUNCTION public.enforce_draft_review_transition();
CREATE TRIGGER draft_revision_insert BEFORE INSERT ON public.draft_revisions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_draft_revision_insert();
