ALTER TABLE voice_projects ADD COLUMN auto_media boolean NOT NULL DEFAULT true;
CREATE UNIQUE INDEX voice_action_one_running ON voice_actions(project_id) WHERE status='running';
CREATE TABLE source_deletions(object_key text PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION queue_source_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO source_deletions(object_key) VALUES(OLD.object_key) ON CONFLICT DO NOTHING;
 RETURN OLD;
END $$;
CREATE TRIGGER source_deleted AFTER DELETE ON voice_sources FOR EACH ROW EXECUTE FUNCTION queue_source_deletion();
