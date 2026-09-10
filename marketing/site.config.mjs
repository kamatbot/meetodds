/** Public website settings, not desktop app configuration. Never put secrets here. */
export default Object.freeze({
  siteUrl: 'https://meetodds.kamatbot.com',
  repositoryUrl: 'https://github.com/kamatbot/meetodds',
  // The public repository and installer are not published yet. Do not fake availability.
  repositoryAvailable: false,
  // Codex: set to the verified HTTPS URL of the signed Mac installer at release time.
  // null intentionally renders a disabled download control, not a broken download.
  macDownloadUrl: null,
});
