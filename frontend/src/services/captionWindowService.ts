import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { availableMonitors, currentMonitor } from '@tauri-apps/api/window';
import { LogicalSize, PhysicalPosition } from '@tauri-apps/api/dpi';
import {
  CAPTION_WINDOW_LABEL, fitCaptionGeometry, readCaptionGeometry, selectCaptionScreen,
  type CaptionScreen,
} from '@/lib/live-captions';

let pendingWindow: Promise<WebviewWindow> | null = null;

/** Lazy creation: no extra webview or recognition work at application startup. */
export function ensureCaptionWindow(): Promise<WebviewWindow> {
  if (pendingWindow) return pendingWindow;
  pendingWindow = createWindow().finally(() => { pendingWindow = null; });
  return pendingWindow;
}

async function createWindow(): Promise<WebviewWindow> {
  const existing = await WebviewWindow.getByLabel(CAPTION_WINDOW_LABEL);
  let geometry;
  try {
    let saved = readCaptionGeometry(window.localStorage);
    if (existing) {
      const [position, size, scale] = await Promise.all([existing.outerPosition(), existing.innerSize(), existing.scaleFactor()]);
      saved = { x: position.x, y: position.y, width: size.width / scale, height: size.height / scale };
    }
    const monitors = await availableMonitors();
    const preferred = await currentMonitor();
    const ordered = preferred ? [preferred, ...monitors.filter(m => m.position.x !== preferred.position.x || m.position.y !== preferred.position.y)] : monitors;
    const screens: CaptionScreen[] = ordered.map(m => ({
      x: m.position.x, y: m.position.y,
      width: m.size.width, height: m.size.height, scaleFactor: m.scaleFactor,
    }));
    const screen = selectCaptionScreen(saved, screens);
    if (screen) geometry = fitCaptionGeometry(saved, screen);
  } catch { /* OS monitor APIs/storage may be unavailable. The native centered default remains usable. */ }
  const overlay = existing ?? new WebviewWindow(CAPTION_WINDOW_LABEL, {
    url: '/live-captions', title: 'MeetOdds Live Captions',
    width: 720, height: 210, minWidth: 340, minHeight: 140,
    center: true,
    transparent: true, decorations: false, shadow: false,
    alwaysOnTop: true, visibleOnAllWorkspaces: true,
    skipTaskbar: true, resizable: true, maximizable: false, minimizable: false,
    focus: false, acceptFirstMouse: true, visible: false,
  });
  // Wait for native creation. The caption route separately handshakes after mounting its listener.
  if (!existing) await new Promise<void>((resolve, reject) => {
    let done = false;
    const disposers: Array<() => void> = [];
    const finish = (error?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      disposers.forEach(fn => fn());
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error('Caption window did not become ready. Toggle captions to retry.')), 12000);
    void overlay.once('tauri://created', () => finish()).then(fn => done ? fn() : disposers.push(fn), finish);
    void overlay.once('tauri://error', e => finish(new Error(String(e.payload)))).then(fn => done ? fn() : disposers.push(fn), finish);
  });
  // Position in physical desktop coordinates, then apply logical size on the destination monitor.
  // Re-clamp reused windows too: an external display may have been disconnected while hidden.
  if (geometry) {
    await overlay.setPosition(new PhysicalPosition(geometry.x, geometry.y));
    await overlay.setSize(new LogicalSize(geometry.width, geometry.height));
  }
  return overlay;
}
