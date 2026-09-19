"""Extract Spanish free-talk content from spanish/scenes.rs, byte-exact."""
import json, re, pathlib
src = pathlib.Path("/home/user/notes/frontend/src-tauri/src/spanish/scenes.rs").read_text(encoding="utf-8")

def one(pattern, label):
    m = re.search(pattern, src, re.S)
    assert m, f"could not find {label}"
    return m.group(1)

closing = one(r'pub const CLOSING: &str =\s*"((?:[^"\\]|\\.)*)";', "CLOSING")
talk_fb = one(r'pub const TALK_FALLBACK: &str = "((?:[^"\\]|\\.)*)";', "TALK_FALLBACK")
scaffold_fb = one(r'\.unwrap_or\("((?:[^"\\]|\\.)*)"\)\n\}\npub fn advance', "scaffold fallback")

dial_block = one(r'pub fn dial_instruction\(dial: u8\) -> &\'static str \{\s*match dial \{(.*?)\n    \}', "dial_instruction")
dials = re.findall(r'=> "((?:[^"\\]|\\.)*)"', dial_block)
assert len(dials) == 4, f"expected 4 dial instructions, got {len(dials)}"

topics_block = src[src.index("pub static TOPICS"):]
topics = []
for tid, block in re.findall(r'id: "([a-z_]+)",\s*openers: \[(.*?)\n        \],\n    \}', topics_block, re.S):
    rows = re.findall(r'\[\s*((?:"(?:[^"\\]|\\.)*",?\s*){3})\]', block)
    assert len(rows) == 3, f"{tid}: expected 3 levels, got {len(rows)}"
    openers = []
    for r in rows:
        items = re.findall(r'"((?:[^"\\]|\\.)*)"', r)
        assert len(items) == 3, f"{tid}: expected 3 openers, got {len(items)}"
        openers.append(items)
    topics.append({"id": tid, "openers": openers})
assert len(topics) == 6, f"expected 6 topics, got {len(topics)}"

out = {
    "language_id": "es",
    "closing": closing,
    "talk_fallback": talk_fb,
    "scaffold_fallback": scaffold_fb,
    "dial_instructions": dials,
    "topics": topics,
}
dest = pathlib.Path("/tmp/claude-0/-home-user-notes/70e67c41-c38f-569a-801a-4f0e5a9a96cb/scratchpad/talk/es.json")
dest.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"extracted es: {len(topics)} topics, closing={closing[:40]!r}")
