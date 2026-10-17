-- Steps may carry a short clip (steps[].video) beside their photo. Clips are recipe media like
-- step photos: the janitor keeps them while a recipe shows them, and the triggers from
-- 021_engagement.sql queue one for deletion when its recipe stops showing it.
CREATE OR REPLACE FUNCTION recipe_media(p_image text, p_video text, p_photos jsonb, p_steps jsonb) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(array_agg(DISTINCT u), '{}') FROM (
    SELECT p_image AS u
    UNION ALL SELECT p_video
    UNION ALL SELECT p FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_photos) = 'array' THEN p_photos ELSE '[]' END) p
    UNION ALL SELECT s->>'image' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_steps) = 'array' THEN p_steps ELSE '[]' END) s WHERE jsonb_typeof(s) = 'object'
    UNION ALL SELECT s->>'video' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_steps) = 'array' THEN p_steps ELSE '[]' END) s WHERE jsonb_typeof(s) = 'object'
  ) x WHERE u IS NOT NULL AND u <> ''
$$;
