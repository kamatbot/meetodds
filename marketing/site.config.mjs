/** Public website settings, not desktop app configuration. Never put secrets here. */
export default Object.freeze({
  siteUrl: 'https://meetodds.kamatbot.com',
  repositoryUrl: 'https://github.com/kamatbot/meetodds',
  // Public repository and installer are published.
  repositoryAvailable: true,
  // Verified HTTPS URL of the signed Mac installer.
  macDownloadUrl: 'https://github.com/kamatbot/meetodds/releases/download/v0.4.19/MeetOdds_0.4.19_aarch64.dmg',
});
