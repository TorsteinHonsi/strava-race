// Opens the race page in a new tab next to the Strava tab that asked for it.
// The Strava tab id is passed along so the race page can fetch data through
// that tab's content script (which runs on strava.com with the user's session).
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'openRace' && sender.tab) {
    const q = new URLSearchParams({ id: msg.id, tab: String(sender.tab.id) });
    if (msg.name) q.set('name', msg.name);
    chrome.tabs.create({
      url: chrome.runtime.getURL('race.html?' + q.toString()),
      index: sender.tab.index + 1
    });
  }
});
