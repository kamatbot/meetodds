from pathlib import Path

p = Path('frontend/scripts/implement_streaming_live_subtitles.py')
text = p.read_text()
old = '''    text = replace_once(text, old_timer, new_timer, "canonical frontend buffer latency")\n    cleanup_timer = dedent(''' + "'''" + '''\n              if (processingTimer) {\n                clearTimeout(processingTimer);\n                console.log('🧹 CLEANUP: Cleared processing timer');\n              }\n    ''' + "'''" + ''')\n    text = text.replace(cleanup_timer, "")\n'''
new = '''    timer_pattern = r"(?m)^[ \\t]*// Clear any existing timer and set a new one\\n[ \\t]*if \\(processingTimer\\) \\{\\n[ \\t]*clearTimeout\\(processingTimer\\);\\n[ \\t]*\\}\\n\\n[ \\t]*// Process buffer with minimal delay for immediate UI updates \\(serial workers = sequential order\\)\\n[ \\t]*processingTimer = setTimeout\\(processBufferedTranscripts, 10\\);"\n    timer_replacement = ''' + "'''" + '''          // Serial backend emission is already ordered; yield only to the current JS\n          // task, then render the finalized sentence immediately.\n          queueMicrotask(() => processBufferedTranscripts());''' + "'''" + '''\n    text = regex_once(text, timer_pattern, timer_replacement, "canonical frontend buffer latency")\n    cleanup_pattern = r"(?m)^[ \\t]*if \\(processingTimer\\) \\{\\n[ \\t]*clearTimeout\\(processingTimer\\);\\n[ \\t]*console\\.log\\('🧹 CLEANUP: Cleared processing timer'\\);\\n[ \\t]*\\}\\n?"\n    text = re.sub(cleanup_pattern, "", text)\n'''
if old not in text:
    raise SystemExit('frontend timer patch anchor changed')
p.write_text(text.replace(old, new, 1))
