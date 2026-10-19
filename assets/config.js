// Ping runtime configuration.
window.PING_CONFIG = {
  // URL of the deployed feedback Worker (see worker/README.md), e.g.
  // "https://ping-feedback.<your-subdomain>.workers.dev". Leave empty to keep
  // reader feedback in the reader's own browser only.
  feedbackEndpoint: "https://ping-feedback.genixm.workers.dev",
  // Topics readers can ask for more of. Weekly curation reads the tallies.
  topics: [
    "Southeast Asia focus", "Singapore & straits", "Underwater (AUV/UUV)", "Surface (USV)",
    "Counter-drone & threats", "Mine countermeasures", "Emergency response & SAR",
    "Comms & networking", "China & PLAN", "Contracts & procurement", "Commercial / offshore"
  ]
};
