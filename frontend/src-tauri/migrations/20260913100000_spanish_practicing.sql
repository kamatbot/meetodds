ALTER TABLE spanish_profiles ADD COLUMN practicing TEXT NOT NULL DEFAULT '[]';
ALTER TABLE spanish_profiles ADD COLUMN allow_cloud INTEGER NOT NULL DEFAULT 0;
