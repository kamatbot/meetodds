/** Interactive, fictional product preview. No accounts, analytics, storage or network calls. */
const tabs = [...document.querySelectorAll('[role="tab"]')];
const panels = [...document.querySelectorAll('[role="tabpanel"]')];
const status = document.querySelector('[data-demo-status]');
const summary = document.querySelector('[data-summary]');
const provider = document.querySelector('[data-provider]');
const notice = document.querySelector('[data-demo-notice]');
const insight = document.querySelector('[data-insight]');
const copyButton = document.querySelector('[data-copy]');
const transcript = 'The team is simplifying onboarding so new users can reach their first win faster. Next up: a focused prototype, five customer conversations, and a check-in on Friday.';
const modes = {
  local: {
    summary: transcript,
    provider: 'Summarized with local AI',
    badge: 'ON-DEVICE',
    icon: '#i-laptop',
    disclosure: 'Illustrative preview. Local mode keeps recording, transcription, and summaries on-device.',
    announcement: 'Local AI preview. All three stages can run on your Mac.',
  },
  chatgpt: {
    summary: 'The team’s priority is a clearer first experience, not more features. A focused prototype and five customer conversations will test that direction before development. Friday’s review should decide what to build next.',
    provider: 'Summarized with ChatGPT',
    badge: 'OPTIONAL CLOUD',
    icon: '#i-cloud',
    disclosure: 'Illustrative preview, not live AI. ChatGPT summaries send required transcript text to OpenAI; audio stays local. Account limits apply.',
    announcement: 'ChatGPT preview. Cloud summaries send transcript text to OpenAI. This is fictional example content, not live AI.',
  },
};

function activateTab(tab, moveFocus = false) {
  if (!tab || !tabs.includes(tab)) return;
  for (const candidate of tabs) {
    const selected = candidate === tab;
    candidate.setAttribute('aria-selected', String(selected));
    candidate.tabIndex = selected ? 0 : -1;
  }
  for (const panel of panels) {
    panel.hidden = panel.id !== tab.getAttribute('aria-controls');
  }
  if (moveFocus) tab.focus();
}

for (const [index, tab] of tabs.entries()) {
  tab.addEventListener('click', () => activateTab(tab));
  tab.addEventListener('keydown', (event) => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    activateTab(tabs[next], true);
  });
}

/** Use DOM construction rather than interpolating content into innerHTML. */
function setProvider(mode, isCloud) {
  if (!provider) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', mode.icon);
  svg.append(use);
  const pill = document.createElement('span');
  pill.className = `tiny-pill${isCloud ? ' cloud' : ''}`;
  pill.textContent = mode.badge;
  provider.replaceChildren(svg, document.createTextNode(mode.provider), pill);
}

for (const input of document.querySelectorAll('input[name="demo-mode"]')) {
  input.addEventListener('change', () => {
    const mode = modes[input.value];
    if (!mode || !input.checked) return;
    if (summary) summary.textContent = mode.summary;
    if (notice) notice.textContent = mode.disclosure;
    if (insight) insight.hidden = input.value !== 'chatgpt';
    setProvider(mode, input.value === 'chatgpt');
    // Keep the focused radio in place so arrow-key radio navigation stays native.
    activateTab(tabs[0]);
    if (status) status.textContent = mode.announcement;
  });
}

if (copyButton) {
  copyButton.hidden = false;
  copyButton.addEventListener('click', async () => {
    if (!status) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(summary?.textContent ?? transcript);
      status.textContent = 'Sample summary copied to clipboard.';
      copyButton.dataset.feedback = 'Copied';
    } catch {
      status.textContent = 'Clipboard access is unavailable. You can select and copy the sample text instead.';
      copyButton.dataset.feedback = 'Select the sample text to copy it.';
    }
    window.setTimeout(() => delete copyButton.dataset.feedback, 3500);
  });
}

const menu = document.querySelector('.mobile-menu');
if (menu instanceof HTMLDetailsElement) {
  for (const link of menu.querySelectorAll('a')) {
    link.addEventListener('click', () => {
      menu.open = false;
      // Closing <details> hides the clicked link. Move focus to its destination.
      const target = document.getElementById(link.hash.slice(1));
      if (target) {
        target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
        target.addEventListener('blur', () => target.removeAttribute('tabindex'), { once: true });
      }
    });
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menu.open) {
      menu.open = false;
      menu.querySelector('summary')?.focus();
    }
  });
  document.addEventListener('click', (event) => {
    if (menu.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
  });
}

// Static copy and native FAQ/menu remain useful even without JavaScript.
for (const control of document.querySelectorAll('.demo-tabs, .preview-controls')) control.hidden = false;
// Do not override user choices, focus, or the browser's back/forward scroll restoration.
