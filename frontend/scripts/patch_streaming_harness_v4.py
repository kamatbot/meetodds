from pathlib import Path

p = Path('frontend/scripts/implement_streaming_live_subtitles.py')
text = p.read_text()
old = '''def replace_n(text: str, old: str, new: str, count: int, label: str) -> str:\n    present = text.count(old)\n    if present >= count:\n        return text.replace(old, new, count)\n    if text.count(new) >= count:\n        return text\n    raise SystemExit(f"Expected {count} anchors for {label}, found {present}")\n'''
new = '''def replace_n(text: str, old: str, new: str, count: int, label: str) -> str:\n    present = text.count(old)\n    if present >= count:\n        return text.replace(old, new, count)\n    if text.count(new) >= count:\n        return text\n\n    def indented(value: str, prefix: str) -> str:\n        return "\\n".join(prefix + line if line else line for line in value.split("\\n"))\n\n    for prefix in ("    ", "        ", "            ", "                ", "                    ", "                        ", "                            "):\n        candidate = indented(old, prefix)\n        present = text.count(candidate)\n        if present >= count:\n            return text.replace(candidate, indented(new, prefix), count)\n    raise SystemExit(f"Expected {count} anchors for {label}, found {present}")\n'''
if old not in text:
    raise SystemExit('replace_n helper anchor changed')
p.write_text(text.replace(old, new, 1))
