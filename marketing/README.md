# MeetOdds marketing website — Option 1

A standalone, lightweight implementation of the selected clean/light direction. Built for `https://meetodds.kamatbot.com`, with public source links pointing to `https://github.com/kamatbot/meetodds` as requested. This directory does not import or modify the desktop app.

## Run locally

Use **Node 24**, matching the repository's Node policy. There are no npm dependencies to install.

```bash
cd marketing
nvm use
npm run dev
```

Open `http://127.0.0.1:4173`. The development server rebuilds the page when you reload it. Restart it after changing `site.config.mjs`. Set `PORT=4180` to use another port. The development/preview server deliberately binds to loopback and is **not** a production server.

```bash
npm test
npm run build
npm run preview
```

The deployable directory is **`marketing/dist/`**, not `frontend/`, `marketing/src/`, or the marketing directory itself. Output is ordinary static HTML, CSS, JavaScript, an SVG favicon, `robots.txt`, `sitemap.xml`, and a 404 page. No React hydration, server runtime, native build, API routes, database, or environment secrets are required.

## Codex handoff

CI, DNS, hosting, TLS, app packaging, and deployment are intentionally left to Codex. No GitHub Actions workflows or deployment-provider files were added or changed.

| Setting | Value |
| --- | --- |
| Implementation branch | `feat/meetodds-option1` |
| Website project directory | `marketing` |
| Runtime for build/tests | Node 24 |
| Install step | None: zero dependencies |
| Build command from repository root | `node marketing/tools/site.mjs build` |
| Build command from project directory | `npm run build` |
| Test command from project directory | `npm test` |
| Publish directory from repository root | `marketing/dist` |
| Public website origin | `https://meetodds.kamatbot.com` |
| Public source repository | `https://github.com/kamatbot/meetodds` |

The earlier `feat/meetodds-marketing-landing` branch acquired another draft during this implementation. It was left untouched; this selected Option 1 implementation has its own branch based on `main` at `555315c69dfb5d551e80696a46d261e19246b0d8`. Do not deploy the older draft by mistake.

### Release availability

All release configuration is in `site.config.mjs`:

```js
repositoryAvailable: false,
macDownloadUrl: null,
```

The public repository was described as not available yet, and no verified installer URL was provided. Consequently, GitHub links use the requested future repository and the page identifies its upcoming status. The download section renders a genuinely disabled **Mac download coming soon** button. Top-level Get MeetOdds links scroll to this section; they do not pretend to download an app.

When ready, change `repositoryAvailable` to `true` and set `macDownloadUrl` to the verified HTTPS URL for the signed Mac installer. These settings are independent: publishing source does not imply publishing an installer. Rebuild to update all availability copy consistently. Do not point visitors to an upstream Meetily installer or fabricate a MeetOdds release filename.

### Static hosting suggestions

Serve HTML with revalidation and the content-hashed `/assets/` files with long-lived immutable caching. Enable compression at the host. Configure a real 404 response; this is not a single-page app that needs every unknown URL rewritten to `index.html`.

The site requires no third-party scripts, fonts, images, analytics, cookies, web storage, or outbound API connections. A suitable production Content Security Policy is:

```text
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
```

The preview server applies this policy; Codex should configure equivalent headers on the actual host. Social title/description tags and canonical URLs are included. No non-existent social-image URL is advertised. A dedicated raster social card can be added as part of release polish.

## Design and behavior

The page includes the light blue/pastel hero, an HTML/CSS product illustration, local-versus-ChatGPT comparison, microphone/system-audio capture, docked notes, summary/action-item and export feature cards, a three-step workflow, an open-source section, seven native FAQ disclosures, and a release-aware closing call to action.

The product preview uses fictional sample content, not a screenshot of a particular app version or live AI. Visitors can switch between local and ChatGPT-style sample summaries, explore Summary / Transcript / Action items tabs, check off sample tasks, and copy the sample summary. Selecting a preview mode does not connect an account, send a transcript, or modify application settings. The static page does not offer an OAuth sign-in UI.

The small waveform animation stops within five seconds. There are no continuously running animation loops, scroll listeners, autoplay video, external font downloads, or large hero-image assets. Native details elements support the FAQ and mobile menu without JavaScript. JavaScript enhances the demo with roving-tabindex keyboard navigation, visible/screen-reader clipboard feedback, an Escape-to-close menu, and appropriate focus handling. Reduced-motion preferences disable animation and smooth scrolling. The core content and default sample summary remain available with JavaScript disabled.

## Messaging boundaries and evidence

The two modes are intentionally distinguished throughout the hero, preview, comparison, FAQ, and closing section:

- **Fully local:** microphone/system-audio recording, Whisper/Parakeet transcription, and Built-in Local AI or locally hosted Ollama summaries. No account or cloud AI usage fees for this workflow. Models must be downloaded before offline use.
- **Optional ChatGPT account:** use the existing desktop app's **OpenAI Codex (ChatGPT subscription)** provider. No separate API key is needed for that mode. The transcript text needed for the summary is sent to OpenAI; recording and transcription remain local. Eligible-account availability and OpenAI usage limits apply. This is not a fully local or offline summary workflow.

Project evidence reviewed:

- [`../docs/OPENAI_CLOUD.md`](../docs/OPENAI_CLOUD.md): account sign-in, separate API-key provider, and transcript/cloud boundary.
- [`../README.md`](../README.md): local engines, docked notes, local summaries, and PDF/DOCX/Markdown/JSON exports.
- [`../PRIVACY_POLICY.md`](../PRIVACY_POLICY.md): privacy commitments; do not turn optional cloud processing into a blanket no-data-leaves claim.
- [OpenAI: Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-codex-and-chatgpt-plan-usage-limits): account access and usage-limit context, checked September 10, 2026.

Do not advertise particular model names, unlimited use, eligibility for every plan, guaranteed superior accuracy, application-level encryption, compliance certifications, or a public installer before those claims are verified. OpenAI account access is described as the app's integration, not as an endorsement. Upstream Meetily attribution is retained in the footer.

## Validation

The built-in test suite covers release states, URL validation/escaping, template completeness, metadata, anchor/SVG IDs, tab relationships, privacy disclosures, progressive enhancement, reduced motion, lack of third-party runtime requests, dev-server path containment, content hashes, sitemap generation, and a transfer budget.

Validation performed September 10, 2026:

- **21/21 Node tests passed**, plus syntax checks for the browser script and build/server tool.
- Browser interaction checks passed at **320, 360, 390, 640, 768, 960, 1024, 1280, 1440, and 1920 pixels**: no horizontal page overflow, no JavaScript exceptions, mode switching, tabs, keyboard navigation, action checkboxes, FAQ, disabled release control, and the responsive menu.
- Additional checks passed for JavaScript-disabled content/FAQ, reduced-motion behavior, and visible/screen-reader clipboard-failure feedback.
- Initial HTML + CSS + JS + favicon: **80,246 bytes uncompressed; 20,488 bytes gzip** in the checked build. Compression and caching must be enabled by the production host to realize transfer savings.

Environment limits: the available local runtime was **Node 22.16.0**, so the Node checks were run on that runtime; Node 24 is the declared project/build target and should be verified by Codex. Managed Chromium blocked navigation to HTTP/HTTPS addresses, so browser rendering and interaction tests used the exact built HTML/CSS/JS loaded into a local document. The loopback server's HTML response was checked separately. These are not deployed-site, Safari, Lighthouse, formal WCAG certification, desktop recording, ChatGPT authentication, or signed-installer tests. Production deployment has not been performed.
