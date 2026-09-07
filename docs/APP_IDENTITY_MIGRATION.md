# MeetOdds desktop identity migration

MeetOdds changed its Tauri bundle identifier from `com.meetily.ai` to `com.meetodds.app`.

Before database, model, onboarding, or settings initialization, the new app looks for the sibling legacy app-data directory and performs a copy-first migration.

Safety properties:

- `meeting_minutes.sqlite` plus WAL/SHM files are copied, never moved.
- Existing recording folders and stored absolute `folder_path` values are not renamed or rewritten.
- Models, settings, onboarding state, and other app-data files are copied when missing.
- The legacy app-data directory remains intact as a rollback copy.
- If both locations contain different meeting databases, MeetOdds refuses to overwrite either one.
- A migration marker is written only after the copy completes, so interrupted copies can resume safely.

Close older MeetOdds/Meetily desktop builds before the first launch of an identifier-migrating build so SQLite files are not changing during the copy.
