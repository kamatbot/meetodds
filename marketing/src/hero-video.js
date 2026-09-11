const host = document.querySelector('.hero-product');
const videoUrl = document.body.dataset.heroVideo;

if (host && videoUrl) {
  const topline = host.querySelector('.preview-topline');
  host.querySelectorAll('.product-window, .preview-controls, .preview-disclaimer, noscript, [data-demo-status]').forEach((node) => node.remove());

  if (topline) {
    const caption = topline.querySelector('.preview-caption');
    if (caption) caption.innerHTML = '<span class="small-dot"></span> SEE THE REAL MEETODDS WORKFLOW';
  }

  const card = document.createElement('div');
  card.className = 'horizon-video-card';

  const video = document.createElement('video');
  video.src = videoUrl;
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.setAttribute('aria-label', 'MeetOdds product walkthrough showing the live meeting workspace and post-meeting workflow');

  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  video.autoplay = !reducedMotion;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'video-control';
  button.setAttribute('aria-label', reducedMotion ? 'Play MeetOdds product video' : 'Pause MeetOdds product video');
  button.innerHTML = reducedMotion
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg><span>Play</span>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg><span>Pause</span>';

  const syncButton = () => {
    const paused = video.paused;
    button.setAttribute('aria-label', paused ? 'Play MeetOdds product video' : 'Pause MeetOdds product video');
    button.innerHTML = paused
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg><span>Play</span>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg><span>Pause</span>';
  };

  button.addEventListener('click', async () => {
    try {
      if (video.paused) await video.play();
      else video.pause();
    } catch {
      // The browser may block autoplay/play in unusual embedding contexts; controls remain available.
    }
    syncButton();
  });
  video.addEventListener('play', syncButton);
  video.addEventListener('pause', syncButton);

  card.append(video, button);

  const meta = document.createElement('div');
  meta.className = 'video-meta';
  meta.innerHTML = '<span><i></i><strong>Real product footage</strong></span><span>Local capture · live notebook · AI outcomes</span>';

  host.append(card, meta);

  if (!reducedMotion) {
    video.play().catch(() => syncButton());
  } else {
    syncButton();
  }
}
