from pathlib import Path

p = Path('frontend/scripts/implement_streaming_live_subtitles.py')
text = p.read_text()
start = text.index("    closing_anchor = dedent('''")
end_marker = '    text = replace_once(text, closing_anchor, closing_new, "subtitle panel render")\n'
end = text.index(end_marker, start) + len(end_marker)
replacement = '''    closing_anchor = "      </div>\\n    </div>\\n  );\\n}"\n    closing_new = ''' + '"""' + '''      </div>\n\n      {isRecording && (\n        <LiveTranscriptSubtitle\n          preview={livePreview}\n          translation={liveTranslation.previewTranslation}\n          translationEnabled={liveTranslation.settings.enabled}\n          translationDisplayMode={liveTranslation.settings.displayMode}\n          translationTargetLanguage={liveTranslation.settings.targetLanguage}\n          isPaused={isPaused}\n        />\n      )}\n    </div>\n  );\n}"""\n    text = replace_once(text, closing_anchor, closing_new, "subtitle panel render")\n'''
p.write_text(text[:start] + replacement + text[end:])
