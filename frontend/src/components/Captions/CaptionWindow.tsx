'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow, currentMonitor } from '@tauri-apps/api/window';
import { LogicalSize, PhysicalPosition } from '@tauri-apps/api/dpi';
import { GripHorizontal, Maximize2, Minus, Plus, SlidersHorizontal, X } from 'lucide-react';
import { getLiveTranslationLanguage } from '@/lib/live-translation';
import {
  CAPTION_FRAME_EVENT, CAPTION_READY_EVENT, CAPTION_DISMISS_EVENT, CAPTION_RESET_EVENT,
  CAPTION_GEOMETRY_KEY, CAPTION_APPEARANCE_KEY, fitCaptionGeometry,
  normalizeCaptionAppearance, CaptionFrameGate, type CaptionFrame, type CaptionAppearance,
} from '@/lib/live-captions';
import './captions.css';

const INITIAL: CaptionFrame = {
  sessionId: '', epoch: '', sequence: 0, enabled: false,
  text: '', speaker: 'Live', language: 'und', translated: false, phase: 'listening',
};
const MOVEMENT: Record<string, readonly [number, number] | undefined> = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
};
const EDGES = [
  ['n', 'North'], ['s', 'South'], ['e', 'East'], ['w', 'West'],
  ['ne', 'NorthEast'], ['nw', 'NorthWest'], ['se', 'SouthEast'], ['sw', 'SouthWest'],
] as const;

export default function CaptionWindow() {
  const [frame, setFrame] = useState<CaptionFrame>(INITIAL);
  const [appearance, setAppearance] = useState<CaptionAppearance>(() => normalizeCaptionAppearance());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [following, setFollowing] = useState(true);
  const [connectionLost, setConnectionLost] = useState(false);
  const [windowError, setWindowError] = useState<string | null>(null);
  const gate = useRef(new CaptionFrameGate());
  const lastReceived = useRef(Date.now());
  const scroller = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const visibilityQueue = useRef(Promise.resolve());
  const enabledRef = useRef(false);

  const dismiss = useCallback(() => {
    gate.current.dismiss();
    enabledRef.current = false;
    setFrame(previous => ({ ...previous, text: '', enabled: false }));
    void emitTo('main', CAPTION_DISMISS_EVENT).catch(() => {});
    void getCurrentWindow().hide().catch(() => setWindowError('Could not hide captions. Use the Captions button in MeetOdds.'));
  }, []);

  const resetPosition = useCallback(async () => {
    try {
      const monitor = await currentMonitor();
      if (!monitor) { await getCurrentWindow().center(); return; }
      const bounds = fitCaptionGeometry(null, {
        x: monitor.position.x, y: monitor.position.y,
        width: monitor.size.width, height: monitor.size.height, scaleFactor: monitor.scaleFactor,
      });
      await getCurrentWindow().setSize(new LogicalSize(bounds.width, bounds.height));
      await getCurrentWindow().setPosition(new PhysicalPosition(bounds.x, bounds.y));
      setWindowError(null);
    } catch { setWindowError('Could not reset the window. Drag its top edge to reposition it.'); }
  }, []);

  useEffect(() => {
    try { setAppearance(normalizeCaptionAppearance(JSON.parse(localStorage.getItem(CAPTION_APPEARANCE_KEY) || 'null'))); }
    catch { /* Safe defaults for corrupt/blocked storage. */ }
    let gone = false;
    const disposers: Array<() => void> = [];
    let geometryTimer: ReturnType<typeof setTimeout> | undefined;
    const add = (fn: () => void) => gone ? fn() : disposers.push(fn);
    const persistGeometry = () => {
      clearTimeout(geometryTimer);
      geometryTimer = setTimeout(() => {
        void (async () => {
          const window = getCurrentWindow();
          const [position, size, scale] = await Promise.all([window.outerPosition(), window.innerSize(), window.scaleFactor()]);
          if (!gone) localStorage.setItem(CAPTION_GEOMETRY_KEY, JSON.stringify({ x: position.x, y: position.y, width: size.width / scale, height: size.height / scale }));
        })().catch(() => {});
      }, 250);
    };
    const setup = async () => {
      add(await listen<unknown>(CAPTION_FRAME_EVENT, event => {
        const next = gate.current.accept(event.payload);
        if (!next) return;
        lastReceived.current = Date.now();
        enabledRef.current = next.enabled;
        setConnectionLost(false);
        // Heartbeats do not rerender text or restart motion.
        setFrame(old => old.text === next.text && old.phase === next.phase && old.enabled === next.enabled
          && old.sessionId === next.sessionId && old.language === next.language && old.translated === next.translated
          && old.speaker === next.speaker ? old : next);
      }));
      if (gone) return;
      add(await getCurrentWindow().onCloseRequested(event => { event.preventDefault(); dismiss(); }));
      add(await getCurrentWindow().onMoved(persistGeometry));
      add(await getCurrentWindow().onResized(persistGeometry));
      add(await getCurrentWindow().onScaleChanged(persistGeometry));
      add(await listen(CAPTION_RESET_EVENT, () => { void resetPosition(); }));
      if (!gone) await emitTo('main', CAPTION_READY_EVENT);
    };
    void setup().catch(() => { if (!gone) setWindowError('Captions could not connect. Close this window and turn captions on again.'); });
    const heartbeat = setInterval(() => {
      if (Date.now() - lastReceived.current > 10000) setConnectionLost(true);
      void emitTo('main', CAPTION_READY_EVENT).catch(() => {});
    }, 2500);
    return () => { gone = true; clearTimeout(geometryTimer); clearInterval(heartbeat); disposers.forEach(fn => fn()); };
  }, [dismiss, resetPosition]);

  useEffect(() => {
    const timer = setTimeout(() => {
      try { localStorage.setItem(CAPTION_APPEARANCE_KEY, JSON.stringify(appearance)); } catch { /* Preferences only, no meeting content. */ }
    }, 250);
    return () => clearTimeout(timer);
  }, [appearance]);

  useEffect(() => {
    // Serialize show/hide and re-read desired state, so rapid toggles never reopen a dismissed window.
    visibilityQueue.current = visibilityQueue.current.catch(() => {}).then(async () => {
      const window = getCurrentWindow();
      if (enabledRef.current) await window.show(); else await window.hide();
    }).catch(() => setWindowError('Window visibility could not be updated. Toggle Captions in MeetOdds to retry.'));
  }, [frame.enabled]);

  const follow = useCallback(() => {
    followingRef.current = true;
    setFollowing(true);
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, []);
  const stopFollowing = useCallback(() => { followingRef.current = false; setFollowing(false); }, []);
  const scrollToTail = useCallback(() => {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && scroller.current?.contains(selection.anchorNode)) return;
    if (followingRef.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, []);
  useLayoutEffect(scrollToTail, [frame.text, appearance.fontSize, scrollToTail]);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(scrollToTail);
    observer.observe(element);
    return () => observer.disconnect();
  }, [scrollToTail]);

  const moveWithKeyboard = async (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = MOVEMENT[event.key];
    if (!delta) return;
    event.preventDefault();
    try {
      const window = getCurrentWindow();
      const step = event.shiftKey ? 50 : 10;
      const [position, scale] = await Promise.all([window.outerPosition(), window.scaleFactor()]);
      await window.setPosition(new PhysicalPosition(position.x + delta[0] * step * scale, position.y + delta[1] * step * scale));
    } catch { setWindowError('Could not move captions with the keyboard. Drag the top edge instead.'); }
  };
  const resizeWithKeyboard = async (event: KeyboardEvent<HTMLButtonElement>) => {
    const delta = MOVEMENT[event.key];
    if (!delta) return;
    event.preventDefault();
    try {
      const window = getCurrentWindow();
      const [size, scale] = await Promise.all([window.innerSize(), window.scaleFactor()]);
      await window.setSize(new LogicalSize(Math.max(340, size.width / scale + delta[0] * 20), Math.max(140, size.height / scale + delta[1] * 20)));
    } catch { setWindowError('Could not resize captions with the keyboard. Drag an edge instead.'); }
  };

  const language = frame.translated ? getLiveTranslationLanguage(frame.language)?.name || frame.language : 'Original';
  const message = connectionLost ? 'Waiting for MeetOdds…' : {
    listening: 'Listening to the conversation…', translating: `Translating to ${language}…`,
    paused: 'A moment of pause.', error: 'Translation unavailable. Check translation settings in MeetOdds.', live: 'Listening…',
  }[frame.phase];
  const text = !connectionLost && frame.enabled ? frame.text : '';

  return (
    <main className="caption-window" aria-label="Floating live captions" onKeyDown={event => { if (event.key === 'Escape') dismiss(); }}>
      <section className="caption-glass" style={{ '--caption-font': `${appearance.fontSize}px`, '--caption-opacity': appearance.opacity } as CSSProperties}>
        <header className="caption-toolbar">
          <div className="caption-drag" role="button" tabIndex={0} aria-label="Move captions. Drag or use arrow keys. Shift moves faster."
            onKeyDown={event => { void moveWithKeyboard(event); }}
            onPointerDown={event => { if (event.button === 0) { event.preventDefault(); void getCurrentWindow().startDragging().catch(() => setWindowError('Drag could not start. Use arrow keys on this handle.')); } }}>
            <GripHorizontal size={15} aria-hidden="true" />
            <span className="caption-dot" data-phase={frame.phase} aria-hidden="true" />
            <span className="caption-kicker">{frame.phase === 'paused' ? 'Paused' : frame.speaker}</span>
            <span className="caption-language">{language}</span>
          </div>
          <div className="caption-actions">
            <button type="button" className="caption-button" aria-label="Smaller caption text" disabled={appearance.fontSize <= 18} onClick={() => setAppearance(p => normalizeCaptionAppearance({ ...p, fontSize: p.fontSize - 2 }))}><Minus size={15} /></button>
            <button type="button" className="caption-button" aria-label="Larger caption text" disabled={appearance.fontSize >= 40} onClick={() => setAppearance(p => normalizeCaptionAppearance({ ...p, fontSize: p.fontSize + 2 }))}><Plus size={15} /></button>
            <button type="button" className="caption-button" aria-label="Caption appearance" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(v => !v)}><SlidersHorizontal size={14} /></button>
            <button type="button" className="caption-button" aria-label="Reset caption position and size. Arrow keys resize." onKeyDown={event => { void resizeWithKeyboard(event); }} onClick={() => void resetPosition()}><Maximize2 size={14} /></button>
            <button type="button" className="caption-button" aria-label="Hide live captions" onClick={dismiss}><X size={16} /></button>
          </div>
        </header>
        <div className="caption-copy" ref={scroller} onWheel={stopFollowing} onTouchStart={stopFollowing}
          onScroll={() => { const node = scroller.current; if (node && node.scrollHeight - node.clientHeight - node.scrollTop < 8) { followingRef.current = true; setFollowing(true); } }}>
          <p className={text ? '' : 'caption-empty'} lang={text ? frame.language : 'en'} dir="auto">{text || message}</p>
        </div>
        <footer className="caption-footer">
          <span>{windowError || (frame.translated ? 'Translated captions · original transcript unchanged' : 'Live captions · on-device speech recognition')}</span>
          {!following && <button className="caption-follow" type="button" onClick={follow}>Back to live</button>}
        </footer>
        {settingsOpen && <div className="caption-settings">
          <label>Opacity <input aria-label="Caption background opacity" type="range" min="35" max="96" value={Math.round(appearance.opacity * 100)} onChange={e => setAppearance(p => ({ ...p, opacity: Number(e.target.value) / 100 }))} /></label>
          <span>Drag the top · resize any edge</span>
        </div>}
        {EDGES.map(([edge, direction]) => <div key={edge} className={`caption-resize caption-resize-${edge}`} aria-hidden="true" onPointerDown={event => {
          if (event.button !== 0) return;
          event.preventDefault(); event.stopPropagation();
          void getCurrentWindow().startResizeDragging(direction).catch(() => setWindowError('Use arrow keys on the resize button to resize.'));
        }} />)}
      </section>
    </main>
  );
}
