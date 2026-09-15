#!/usr/bin/env python3
"""Structural + language-sanity gate for authored scene JSON."""
import json, re, sys, unicodedata, pathlib

SKELETON = [
 ("ordering_food","waiter","customer","order food and a drink, then ask for the bill",
  ["greet and choose a drink","order food; offer a dish","ask how the food tastes","ask for the bill and finish"],
  ["conditional politeness","complaining politely"]),
 ("meeting_someone","new acquaintance","new acquaintance","introduce yourself and find a shared interest",
  ["exchange names","say where you live","find a shared interest","suggest another conversation"],
  ["shared interests","polite invitations"]),
 ("school_day","classmate","student","talk about subjects, a class project and after-school activities",
  ["name a favorite subject","describe a class","describe a project or activity","arrange an after-school activity"],
  ["explain an opinion","compare learning experiences"]),
 ("weekend_plans","friend","friend","agree an activity, place and time",
  ["choose an activity","choose a place","agree a time","confirm the plan"],
  ["negotiate alternatives","hypothetical plans"]),
 ("shopping","shop assistant","customer","choose an item, compare options and buy it",
  ["identify an item","choose size and color","compare an alternative","ask price and decide"],
  ["compare value","negotiate politely"]),
 ("asking_directions","helpful pedestrian","visitor","find a destination and check the route",
  ["ask for a destination","establish a landmark","explain and confirm a route","check understanding and finish"],
  ["clarify ambiguous directions","compare routes"]),
 ("hotel_checkin","hotel receptionist","guest","check in, ask about facilities and agree checkout",
  ["greet and confirm reservation","choose a room","ask about facilities","agree checkout and finish"],
  ["request an accommodation","resolve a reservation problem"]),
 ("planning_party","friend helping organize","party organizer","plan guests, food, activities and timing",
  ["decide who is invited","choose food","choose an activity","confirm when and finish"],
  ["coordinate preferences","negotiate constraints"]),
]

def check(path):
    errs, warns = [], []
    try:
        d = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    except Exception as e:
        return [f"JSON parse failed: {e}"], []
    lang = d.get("language_id")
    scenes = d.get("scenes", [])
    if len(scenes) != 8:
        errs.append(f"expected 8 scenes, got {len(scenes)}")
    fillers = set()
    for i, (sid, tr, lr, goal, bgoals, adv) in enumerate(SKELETON):
        if i >= len(scenes): break
        s = scenes[i]
        p = f"[{i+1} {sid}]"
        # Fixed English metadata must be byte-identical
        for field, want in (("id",sid),("tutor_role",tr),("learner_role",lr),("goal",goal)):
            if s.get(field) != want:
                errs.append(f"{p} {field}: expected {want!r}, got {s.get(field)!r}")
        beats = s.get("beats", [])
        if len(beats) != 4:
            errs.append(f"{p} expected 4 beats, got {len(beats)}")
        for j, bg in enumerate(bgoals):
            if j >= len(beats): break
            b = beats[j]
            if b.get("goal") != bg:
                errs.append(f"{p} beat{j+1} goal: expected {bg!r}, got {b.get('goal')!r}")
            for f in ("opener","options"):
                v = (b.get(f) or "").strip()
                if not v:
                    errs.append(f"{p} beat{j+1} {f} is empty")
                elif len(v) > 120:
                    warns.append(f"{p} beat{j+1} {f} is long ({len(v)} chars)")
            # spanish/scenes.rs asserts opener/options end with '?'. The
            # multilingual set must hold the same invariant, allowing the
            # full-width form Mandarin punctuation requires.
            for f in ("opener","options"):
                v = (b.get(f) or "").rstrip()
                if v and not v.endswith(("?", "\uff1f")):
                    errs.append(f"{p} beat{j+1} {f} does not end with '?': {v[-30:]!r}")
            opt = (b.get("options") or "")
            # options should be a short either/or prompt
            if opt and len(opt) > 60:
                warns.append(f"{p} beat{j+1} options long ({len(opt)}): {opt[:50]}")
        ts = s.get("target_structures", [])
        if len(ts) != 3 or any(len(r) != 2 for r in ts):
            errs.append(f"{p} target_structures must be 3 rows of 2, got {[len(r) for r in ts]}")
        elif [x.strip() for x in ts[2]] != adv:
            errs.append(f"{p} advanced row: expected {adv}, got {ts[2]}")
        if len(ts) >= 2:
            for r_i, row in enumerate(ts[:2]):
                for cell in row:
                    if not (cell or "").strip():
                        errs.append(f"{p} target_structures row{r_i} has empty cell")
        fl = (s.get("filler") or "").strip()
        if not fl: errs.append(f"{p} filler is empty")
        else: fillers.add(fl)
    if fillers and not (1 <= len(fillers) <= 5):
        warns.append(f"{len(fillers)} distinct fillers (brief suggested 2-4): {sorted(fillers)}")

    # ---- language-specific sanity ----
    content = []
    for s in scenes:
        content.append(s.get("filler",""))
        for b in s.get("beats",[]):
            content += [b.get("opener",""), b.get("options","")]
        for row in s.get("target_structures",[])[:2]:
            content += list(row)
    blob = "\n".join(content)

    if lang == "zh":
        latin = re.findall(r"[A-Za-z]{2,}", blob)
        if latin:
            errs.append(f"Mandarin content contains Latin letters (pinyin?): {sorted(set(latin))[:8]}")
        # Traditional-only characters that shouldn't appear in simplified text
        trad = [c for c in blob if c in "們這樣個學國會說時間買東點鐘還沒錢車過來對開關"]
        if trad:
            errs.append(f"Traditional characters found: {sorted(set(trad))}")
        # space between two CJK chars
        if re.search(r"[一-鿿] +[一-鿿]", blob):
            errs.append("space between Chinese characters")
        if not re.search(r"[一-鿿]", blob):
            errs.append("no Chinese characters in content")
    else:
        if re.search(r"[一-鿿]", blob):
            errs.append(f"unexpected CJK characters in {lang} content")

    if lang == "de":
        if not re.search(r"[äöüÄÖÜß]", blob):
            warns.append("no umlauts or ß anywhere in German content")
        # du/Sie consistency within a scene
        for i, s in enumerate(scenes):
            txt = " ".join([b.get("opener","")+" "+b.get("options","") for b in s.get("beats",[])])
            du = re.search(r"\b(du|dich|dir|dein\w*)\b", txt, re.I)
            sie = re.search(r"\b(Sie|Ihnen|Ihr\w*)\b", txt)
            if du and sie:
                warns.append(f"[{s.get('id')}] mixes du and Sie")
    if lang == "fr":
        for i, s in enumerate(scenes):
            txt = " ".join([b.get("opener","")+" "+b.get("options","") for b in s.get("beats",[])])
            tu = re.search(r"\b(tu|toi|ton|ta|tes)\b", txt, re.I)
            vous = re.search(r"\bvous\b", txt, re.I)
            if tu and vous:
                warns.append(f"[{s.get('id')}] mixes tu and vous")
    if lang == "it":
        for s in scenes:
            txt = " ".join([b.get("opener","")+" "+b.get("options","") for b in s.get("beats",[])])
            if re.search(r"\b(tu|tuo|tua)\b", txt, re.I) and re.search(r"\bLei\b", txt):
                warns.append(f"[{s.get('id')}] mixes tu and Lei")
    if lang == "pt":
        euro = re.findall(r"\b(autocarro|pequeno-almoço|comboio|telemóvel|casa de banho)\b", blob, re.I)
        if euro: warns.append(f"European Portuguese forms: {sorted(set(euro))}")
    if lang == "nb":
        for s in scenes:
            txt = " ".join([b.get("opener","") for b in s.get("beats",[])])
            if re.search(r"\bDe\b|\bDem\b", txt):
                warns.append(f"[{s.get('id')}] archaic formal 'De' — Norwegian uses du")

    # duplicate openers across scenes suggest padding
    openers = [b.get("opener","") for s in scenes for b in s.get("beats",[])]
    dupes = {o for o in openers if openers.count(o) > 1 and o}
    if dupes: warns.append(f"duplicate openers: {list(dupes)[:4]}")
    return errs, warns

if __name__ == "__main__":
    bad = 0
    for path in sys.argv[1:]:
        name = pathlib.Path(path).stem
        if not pathlib.Path(path).exists():
            print(f"=== {name}: MISSING"); bad += 1; continue
        e, w = check(path)
        status = "FAIL" if e else "ok"
        print(f"=== {name}: {status} ({len(e)} errors, {len(w)} warnings)")
        for x in e: print(f"    ERROR  {x}")
        for x in w: print(f"    warn   {x}")
        if e: bad += 1
    sys.exit(1 if bad else 0)
