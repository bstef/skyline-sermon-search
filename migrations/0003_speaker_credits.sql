ALTER TABLE episodes ADD COLUMN speaker TEXT NOT NULL DEFAULT '';
ALTER TABLE episodes ADD COLUMN speaker_source TEXT NOT NULL DEFAULT '';
-- Explicit podcast description credits only; publisher names are not speaker names.
UPDATE episodes SET speaker='Pastor Chris & church elders',speaker_source='description' WHERE id='2edd9539404857bb7d5f';
UPDATE episodes SET speaker='Pastor Chris & Janaïs Mia',speaker_source='description' WHERE id='95fd052142a43bdae825';
