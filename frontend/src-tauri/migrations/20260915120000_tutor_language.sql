-- Carry the target language on each practice profile.
--
-- Every profile that exists before this migration was created by the
-- Spanish-only tutor, so the default is 'es': existing learners keep their
-- language, their practicing phrases and their level untouched.
--
-- The value is a LanguageModule id from src/languages/mod.rs (nb, es, en, fr,
-- de, it, pt, zh). Ids are stable storage keys and must never be renamed.
ALTER TABLE spanish_profiles ADD COLUMN language TEXT NOT NULL DEFAULT 'es';
