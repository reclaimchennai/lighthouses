// Provision for the reclaimchennai.city mini-app network (trees, parks, civic reports, lighthouses).
// NOT a feature yet: no login, no points, no network calls, nothing stored.
//
// The trees app awards points through the shared civic-sentinel ledger: an authenticated player
// (Google / social login) performs an action, the server records {playerKey, action, points,
// status, externalRef} and confirms it later (~/projects/trees/server/index.js, points-config.js).
// This site will join that network by sending the same kind of events. Until then every
// meaningful action is only announced in the page as a DOM event, so a future module can
// subscribe without touching the map code:
//
//   window.addEventListener('lh:action', e => console.log(e.detail));
//
// Planned externalRef shapes (stable ids, one per thing a player can do once):
//   lighthouse:view:<station id>        opened a lighthouse card
//   lighthouse:record:<station id>      read a full Master Ledger record
//   lighthouse:tender:<nid>             opened a tender
//   lighthouse:visit:<station id>       (future) GPS-verified visit to a public-access lighthouse
//   lighthouse:report:<station id>     (future) reported a light not showing its characteristic
export function emit(action, detail = {}) {
  window.dispatchEvent(new CustomEvent('lh:action', { detail: { action, ...detail, at: Date.now() } }));
}
