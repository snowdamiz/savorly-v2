-- An admin's unpublish holds a recipe out of public view until an admin restores it. The hold is
-- on the row, so Restore follows the recipe rather than the last line of the audit log, and no
-- write path can publish a held recipe; its author can still edit it as a draft.
ALTER TABLE recipes
  ADD COLUMN unpublished_by_admin_at timestamptz,
  ADD COLUMN unpublished_by text NOT NULL DEFAULT '',
  ADD CONSTRAINT recipes_moderation_hold CHECK (NOT (published AND unpublished_by_admin_at IS NOT NULL));

-- Recipes an admin unpublished before the hold existed, if nothing has changed them since.
UPDATE recipes r SET unpublished_by_admin_at = x.created_at, unpublished_by = x.admin_email
FROM (SELECT DISTINCT ON (target_id) target_id, action, admin_email, created_at
      FROM admin_actions WHERE target_type = 'recipe' ORDER BY target_id, id DESC) x
WHERE x.target_id = r.id AND x.action = 'recipe.unpublish' AND NOT r.published AND r.updated_at <= x.created_at;

-- Complimentary plans no longer keep an ended subscription's id: a late webhook about that
-- subscription matched it and undid the plan, and deleting the account tried to cancel it again.
UPDATE users SET stripe_subscription_id = ''
WHERE plan <> 'free' AND plan_status = 'active' AND plan_interval = '' AND stripe_subscription_id <> '';
