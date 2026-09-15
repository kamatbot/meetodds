#!/usr/bin/env python3
"""Gate for authored free-talk JSON."""
import json, re, sys, pathlib
TOPICS = ["family","school","sports","food","travel","games"]
LEVELS = ["beginner","intermediate","advanced"]

def check(path):
    errs, warns = [], []
    try:
        d = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    except Exception as e:
        return [f"JSON parse failed: {e}"], []
    lang = d.get("language_id")
    learner_strings = []
    for k in ("closing","talk_fallback","scaffold_fallback"):
        v = (d.get(k) or "").strip()
        if not v: errs.append(f"{k} is empty")
        else: learner_strings.append((k, v))
    di = d.get("dial_instructions", [])
    if len(di) != 4:
        errs.append(f"dial_instructions must have 4 entries, got {len(di)}")
    for i, s in enumerate(di):
        if not (s or "").strip(): errs.append(f"dial_instructions[{i}] empty")
        # Instructions TO THE MODEL, so they must be English prose. CJK is fine
        # where it CITES a structure ("no aspect markers (了, 过)") - that is
        # correct, not a translation - so require English to dominate instead
        # of banning CJK outright.
        text = s or ""
        latin = sum(c.isascii() and c.isalpha() for c in text)
        cjk = sum('\u4e00' <= c <= '\u9fff' for c in text)
        if latin < 20:
            errs.append(f"dial_instructions[{i}] is not English prose ({latin} latin letters)")
        elif cjk and cjk > latin // 4:
            errs.append(f"dial_instructions[{i}] is mostly CJK ({cjk} cjk vs {latin} latin)")
    topics = d.get("topics", [])
    if len(topics) != 6:
        errs.append(f"expected 6 topics, got {len(topics)}")
    for i, tid in enumerate(TOPICS):
        if i >= len(topics): break
        t = topics[i]
        if t.get("id") != tid:
            errs.append(f"topic {i}: expected id {tid!r}, got {t.get('id')!r}")
        op = t.get("openers", [])
        if len(op) != 3:
            errs.append(f"[{tid}] expected 3 levels, got {len(op)}")
        for li, row in enumerate(op):
            if len(row) != 3:
                errs.append(f"[{tid}/{LEVELS[li] if li<3 else li}] expected 3 openers, got {len(row)}")
            for oi, o in enumerate(row):
                o = (o or "").strip()
                if not o: errs.append(f"[{tid}/{li}/{oi}] empty opener")
                else: learner_strings.append((f"{tid}/{li}/{oi}", o))
    # every learner-facing string is a question
    for name, s in learner_strings:
        if not s.rstrip().endswith(("?", "？")):
            errs.append(f"{name} does not end with '?': {s[-40:]!r}")
    blob = "\n".join(s for _, s in learner_strings)
    if lang == "zh":
        latin = re.findall(r"[A-Za-z]{2,}", blob)
        if latin: errs.append(f"Mandarin learner text has Latin letters: {sorted(set(latin))[:6]}")
        if re.search(r"[一-鿿] +[一-鿿]", blob):
            errs.append("space between Chinese characters")
        if not re.search(r"[一-鿿]", blob): errs.append("no Chinese characters")
    elif re.search(r"[一-鿿]", blob):
        errs.append(f"unexpected CJK in {lang}")
    if lang == "hi":
        # Roman script by design: no Devanagari, no IAST diacritics, peer register.
        deva = sorted({c for c in blob if "\u0900" <= c <= "\u097f"})
        if deva: errs.append(f"Hindi learner text contains Devanagari: {deva[:8]}")
        nonascii = sorted({c for c in blob if c.isalpha() and not c.isascii()})
        if nonascii: errs.append(f"Hindi learner text has non-ASCII letters: {nonascii}")
        banned = re.findall(r"\b(nahin|kyaa|chaahiye|hein|tumhein|voh|vahan|acha|accha|thik)\b", blob, re.I)
        if banned: errs.append(f"Hindi non-canonical spelling: {sorted(set(w.lower() for w in banned))}")
        if re.search(r"\baap(ko|ka|ki|ke|ne)?\b", blob, re.I):
            errs.append("Hindi free talk is peer register (tum), found aap")
        if re.search(r"\btu\b", blob, re.I):
            errs.append("Hindi content models tu")
        for i, s in enumerate(di):
            if any("\u0900" <= c <= "\u097f" for c in (s or "")):
                errs.append(f"dial_instructions[{i}] contains Devanagari")
    # duplicate openers
    vals = [s for n, s in learner_strings if "/" in n]
    dup = {v for v in vals if vals.count(v) > 1}
    if dup: warns.append(f"duplicate openers: {list(dup)[:3]}")
    return errs, warns

if __name__ == "__main__":
    bad = 0
    for p in sys.argv[1:]:
        name = pathlib.Path(p).stem
        if not pathlib.Path(p).exists():
            print(f"=== {name}: MISSING"); bad += 1; continue
        e, w = check(p)
        print(f"=== {name}: {'FAIL' if e else 'ok'} ({len(e)} errors, {len(w)} warnings)")
        for x in e: print(f"    ERROR  {x}")
        for x in w: print(f"    warn   {x}")
        if e: bad += 1
    sys.exit(1 if bad else 0)
