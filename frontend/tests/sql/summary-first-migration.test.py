"""Runs the actual migration with SQLite; does not substitute for SQLx/native tests."""
import pathlib
import sqlite3
import unittest

MIGRATION = pathlib.Path(__file__).resolve().parents[2] / "src-tauri/migrations/20260911020000_summary_first_outcomes.sql"


class SummaryFirstMigrationTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.executescript("""
            PRAGMA foreign_keys=ON;
            CREATE TABLE meetings(id TEXT PRIMARY KEY, title TEXT, folder_path TEXT, notes TEXT);
            CREATE TABLE transcripts(id TEXT PRIMARY KEY, meeting_id TEXT, text TEXT);
            CREATE TABLE summary_processes(meeting_id TEXT PRIMARY KEY, status TEXT, result TEXT);
            CREATE TABLE meeting_actions(id TEXT PRIMARY KEY, meeting_id TEXT, text TEXT, confirmed INTEGER, status TEXT);
            CREATE TABLE meeting_facts(id TEXT PRIMARY KEY, meeting_id TEXT, text TEXT, confirmed INTEGER, state TEXT);
            CREATE TABLE meeting_evidence(id TEXT PRIMARY KEY, action_id TEXT REFERENCES meeting_actions(id) ON DELETE CASCADE, fact_id TEXT REFERENCES meeting_facts(id) ON DELETE CASCADE, quote TEXT);
            INSERT INTO meetings VALUES('m','Original title','/unchanged/audio','Private notes');
            INSERT INTO transcripts VALUES('t','m','Actual recorded speech');
            INSERT INTO summary_processes VALUES('m','completed','Prior AI document');
        """)
        self.db.executemany("INSERT INTO meeting_actions VALUES(?,?,?,?,?)", [
            ("fragment", "m", "I will um maybe", 0, "open"),
            ("confirmed", "m", "User edited task", 1, "open"),
            ("completed", "m", "Done task", 0, "done"),
            ("dismissed", "m", "Rejected task", 0, "dismissed"),
        ])
        self.db.executemany("INSERT INTO meeting_facts VALUES(?,?,?,?,?)", [
            ("guess", "m", "Raw guessed fact", 0, "detected"),
            ("reviewed", "m", "Reviewed decision", 1, "agreed"),
            ("rejected", "m", "Rejected claim", 0, "dismissed"),
        ])
        self.db.executemany("INSERT INTO meeting_evidence VALUES(?,?,?,?)", [
            ("e1", "fragment", None, "fragment source"),
            ("e2", "confirmed", None, "reviewed source"),
            ("e3", None, "guess", "guessed source"),
            ("e4", None, "reviewed", "reviewed fact source"),
        ])
        self.db.commit()

    def apply(self):
        self.db.executescript("BEGIN;\n" + MIGRATION.read_text() + "\nCOMMIT;")

    def test_unreviewed_fragments_are_archived_with_their_evidence(self):
        self.apply()
        self.assertEqual(self.db.execute("SELECT id FROM meeting_legacy_action_candidates").fetchall(), [("fragment",)])
        self.assertEqual(self.db.execute("SELECT id FROM meeting_legacy_fact_candidates").fetchall(), [("guess",)])
        self.assertEqual(set(self.db.execute("SELECT quote FROM meeting_legacy_candidate_evidence").fetchall()), {("fragment source",), ("guessed source",)})

    def test_reviewed_done_and_rejected_work_survives(self):
        self.apply()
        self.assertEqual(set(self.db.execute("SELECT id FROM meeting_actions").fetchall()), {("confirmed",), ("completed",), ("dismissed",)})
        self.assertEqual(set(self.db.execute("SELECT id FROM meeting_facts").fetchall()), {("reviewed",), ("rejected",)})
        self.assertEqual(set(self.db.execute("SELECT id FROM meeting_evidence").fetchall()), {("e2",), ("e4",)})
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_original_meeting_transcript_notes_and_summary_are_untouched(self):
        tables = ["meetings", "transcripts", "summary_processes"]
        before = {table: self.db.execute(f"SELECT * FROM {table}").fetchall() for table in tables}
        self.apply()
        after = {table: self.db.execute(f"SELECT * FROM {table}").fetchall() for table in tables}
        self.assertEqual(before, after)

    def test_failure_can_roll_back_the_entire_archive_and_cleanup(self):
        before = self.db.execute("SELECT * FROM meeting_actions ORDER BY id").fetchall()
        self.db.executescript("CREATE TRIGGER reject_cleanup BEFORE DELETE ON meeting_actions BEGIN SELECT RAISE(ABORT,'injected'); END;")
        with self.assertRaises(sqlite3.DatabaseError):
            self.apply()
        self.db.rollback()
        self.assertEqual(before, self.db.execute("SELECT * FROM meeting_actions ORDER BY id").fetchall())
        self.assertEqual(self.db.execute("SELECT count(*) FROM sqlite_master WHERE name='meeting_outcome_state'").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
