// Ping runtime configuration.
window.PING_CONFIG = {
  // URL of the deployed feedback Worker (see worker/README.md), e.g.
  // "https://ping-feedback.<your-subdomain>.workers.dev". Leave empty to keep
  // reader feedback in the reader's own browser only.
  feedbackEndpoint: "https://ping-feedback.raus-ums.workers.dev",
  // Standing line under the PING wordmark on every issue.
  tagline: "Weekly intelligence on uncrewed maritime systems.",
  // Topics readers can ask for more of. Weekly curation reads the tallies and applies them only within
  // Ping's scope (uncrewed maritime systems), as extra search effort inside the four tables.
  topics: [
    "Southeast Asia focus", "Singapore & straits", "Underwater (AUV/UUV)", "Surface (USV)",
    "Counter-drone & threats", "Mine countermeasures", "Uncrewed SAR & response",
    "Comms & networking", "China & PLAN", "Contracts & procurement", "Commercial & offshore"
  ]
};
