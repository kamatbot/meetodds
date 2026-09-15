"""Generate languages/talk.rs from authored free-talk JSON."""
import json, pathlib, sys

ORDER = ["nb", "es", "en", "fr", "de", "it", "pt", "zh"]
NAMES = {"nb":"NORWEGIAN","es":"SPANISH","en":"ENGLISH","fr":"FRENCH",
         "de":"GERMAN","it":"ITALIAN","pt":"PORTUGUESE","zh":"MANDARIN"}
TOPIC_IDS = ["family","school","sports","food","travel","games"]

def rs(s): return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'

HEADER = '''//! Free-talk content: the topic openers, closing line and fallbacks the tutor
//! uses outside a scripted scene, for every target language including Spanish.
//!
//! GENERATED FILE - do not hand-edit. Source of truth is
//! tools/scene-authoring/talk/<lang>.json; regenerate with
//! tools/scene-authoring/codegen_talk.py. See docs/SCENE-AUTHORING.md.
//!
//! The Spanish entry was extracted verbatim from the constants that used to
//! live in `crate::spanish::scenes`, so moving Spanish onto this registry is a
//! no-op for the learner. `spanish_parity` in the test module pins that.

/// Openers for one free-talk topic, indexed by the tutor's level dial.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Topic {
    pub id: &'static str,
    /// [dial][choice] - 3 dial bands, 3 interchangeable openers each.
    pub openers: [[&'static str; 3]; 3],
}

/// Everything the tutor says in a language when no scene is driving it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TalkContent {
    pub language_id: &'static str,
    /// Said once a scene is finished.
    pub closing: &'static str,
    /// Opens free talk when no topic is chosen.
    pub talk_fallback: &'static str,
    /// Used when a scene lookup fails, so the tutor still says something useful.
    pub scaffold_fallback: &'static str,
    /// Model-facing pacing instructions in English, indexed by dial 0..=3.
    pub dial_instructions: [&'static str; 4],
    pub topics: [Topic; 6],
}

impl TalkContent {
    pub fn topic(&self, id: &str) -> Option<&Topic> {
        self.topics.iter().find(|t| t.id == id)
    }
    /// Clamps rather than panicking on a dial from stored state.
    pub fn dial_instruction(&self, dial: u8) -> &'static str {
        self.dial_instructions[(dial as usize).min(3)]
    }
}

impl Topic {
    pub fn openers_for(&self, dial: u8) -> &[&'static str; 3] {
        &self.openers[(dial as usize).min(2)]
    }
}

/// Free-talk topic ids, shared across every language.
pub static TOPIC_IDS: [&str; 6] = ["family", "school", "sports", "food", "travel", "games"];

'''

def topic_rs(t):
    rows = ",\n".join(
        "                [" + ", ".join(rs(o) for o in row) + "]"
        for row in t["openers"])
    return (f'        Topic {{\n            id: {rs(t["id"])},\n'
            f'            openers: [\n{rows},\n            ],\n        }}')

def lang_rs(d):
    dials = ",\n".join(f"        {rs(x)}" for x in d["dial_instructions"])
    topics = ",\n".join(topic_rs(t) for t in d["topics"])
    return (f'pub static {NAMES[d["language_id"]]}_TALK: TalkContent = TalkContent {{\n'
            f'    language_id: {rs(d["language_id"])},\n'
            f'    closing: {rs(d["closing"])},\n'
            f'    talk_fallback: {rs(d["talk_fallback"])},\n'
            f'    scaffold_fallback: {rs(d["scaffold_fallback"])},\n'
            f'    dial_instructions: [\n{dials},\n    ],\n'
            f'    topics: [\n{topics},\n    ],\n}};\n')

def main(src_dir, out_path, tests_path):
    out = [HEADER]
    for lid in ORDER:
        d = json.loads((pathlib.Path(src_dir) / f"{lid}.json").read_text(encoding="utf-8"))
        assert [t["id"] for t in d["topics"]] == TOPIC_IDS, f"{lid} topic order"
        out.append(lang_rs(d))
    lookup = "\n".join(f'        "{l}" => Some(&{NAMES[l]}_TALK),' for l in ORDER)
    out.append(f'''/// Free-talk content for a language id, or `None` if it is not a known id.
pub fn talk_for(language_id: &str) -> Option<&'static TalkContent> {{
    match language_id {{
{lookup}
        _ => None,
    }}
}}

/// Every language this module carries free-talk content for.
pub static TALK_LANGUAGES: [&str; {len(ORDER)}] = [{", ".join(f'"{l}"' for l in ORDER)}];
''')
    out.append(pathlib.Path(tests_path).read_text(encoding="utf-8"))
    pathlib.Path(out_path).write_text("\n".join(out), encoding="utf-8")
    print(f"wrote {out_path}")

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
