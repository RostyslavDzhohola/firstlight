# Proximity voice: illegal-content risk assessment (UK Online Safety Act)

**Service:** FIRSTLIGHT, a free open-world browser game. **Feature assessed:** proximity voice and
radio (SPEC §5.7). **Written:** 2026-10-11, at build (M5); checked against the code 2026-10-12
(F12 review). **Review:** before launch, after any
report of serious harm, after any change to how voice works, and at least once a year.
**Owner:** the game's operator (the admin account).

## 1. What the feature is

- Players talk by **live speech only**. There is no text chat, no voice messages, no file or image
  sharing, no private DMs. The only other user-to-user channel is six fixed phrases ("Truce?", "Help!",
  "Follow me", "Boss here", "Thanks", "GG"). (A report from the Tab player list may carry an optional
  note of up to 200 characters; only admins see it.)
- **Proximity voice:** you hear players within 35 m of you in the same world copy (at most 40 players
  per copy; links to the 12 nearest within 45 m). **Radio:** players who own an in-game radio and tune to the same
  channel (1–9, at most 8 per channel) hear each other anywhere on that planet copy.
- **Off by default.** Hearing and speaking both start off. Turning voice on needs an opt-in panel
  with an "I'm 16 or older" checkbox and a microphone permission prompt. Push-to-talk (V; B for
  radio): nothing is sent unless a key is held.
- **Never recorded.** Audio flows peer to peer through a relay (Cloudflare TURN). The game server
  only relays connection set-up messages; it never receives, stores or processes audio.
- Group speech between more than two users is in scope of the Act (only one-to-one live speech is
  exempt, s.55), so this assessment covers the feature.

## 2. Users

Anonymous guests and email-saved accounts. Chosen display names are unique (case-insensitive),
3–16 characters (letters, digits, `_`) and filtered for slurs. A guest who skips the name prompt
plays as an auto-generated `Wanderer-NNNN`, which is not checked for uniqueness. The game is not aimed at children, but a browser game will attract some.
**The 16+ checkbox is a self-declaration, not age assurance** (it is not "highly effective age
assurance" under the Act and can be ticked by anyone). It sets expectations and is a condition of
use; it does not stop a determined child. Mitigations below therefore assume minors may be present.

## 3. Risks of illegal content and harm

| # | Risk (illegal-content kind) | How it could happen here | Likelihood | Impact |
|---|---|---|---|---|
| R1 | Harassment, threats, stalking (public order, harassment offences) | A player follows another and abuses them by voice | Medium | Medium |
| R2 | Hate speech (stirring up hatred offences) | Slurs or abuse spoken to nearby players or a radio channel | Medium | Medium |
| R3 | Grooming / child sexual exploitation | An adult uses voice or a private radio channel to build contact with a child and move them off-platform | Low (no DMs, no text, no media, no friend lists) | Severe |
| R4 | Sexual content or exposure to minors | Sexual speech near or to a minor | Low–medium | High |
| R5 | Encouraging self-harm or suicide | Spoken encouragement to a vulnerable player | Low | Severe |
| R6 | Fraud / scams | Spoken requests to visit sites or share account details | Low | Medium |
| R7 | Doxxing via network data | A player learns another's IP address from a peer-to-peer connection | Low with relay | Medium |
| R8 | Terrorism content | Spoken propaganda | Very low (no reach, no recording) | High |

Factors that lower risk: no recording or replay, no text or media, short range (35 m), small rooms
(≤ 40), radio channels capped at 8, push-to-talk, voice off by default. Factors that raise it:
anonymous guests, live speech can't be checked in advance, and radio channels are semi-private.

## 4. Mitigations in place

| Mitigation | Risks | Where |
|---|---|---|
| Voice **off by default**; opt-in panel explains range, push-to-talk, no recording, and how to mute/block/report | all | client `voice/ui.ts` |
| **16+ self-declaration** before enabling (not age assurance; see §2): the panel's checkbox gates the request, and the server refuses `voice:enable` without the flag. The opt-in is remembered per browser, after which V turns voice on without the panel | R3, R4 | client `voice/ui.ts`, server `voice:enable` |
| **Push-to-talk** (V, B); the mic is not sent otherwise; listen-only if the mic is denied | R1, R2, R4 | client sender gating |
| **Mute** any player (local to this browser: kept in localStorage, keyed by the muted player's account id; from the voice panel or the Tab player list) and **"mute strangers"** (hear only your party; also per browser) | R1, R2, R4 | client `voice/`, `social/store.ts` |
| **Panic mute-all** (Shift+Esc) silences everyone at once and stops transmitting | all | client |
| **Block** (persisted on the server, both directions, across sessions; from the voice panel or the Tab list, which share one rate limit and list cap): the server stops relaying connection set-up between the pair and tells both clients to hang up at once. If the pair was linked, the blocked player's relay credential is replaced (at most once per 10 minutes per player, never charged to their own mint budget, and the old one is kept until a new one is minted), so repeated blocks can't knock anyone off voice | R1–R6 | server `voice:block`, `social:block` (`applyBlock`), game.db `block` |
| **Blocks reach parties:** a block withdraws party invites between the pair and splits a party they share (the blocker leaves; a leader's block removes the other player instead), and invites and accepts are refused while anyone in the party is blocked either way, so a blocked player never gets the blocker's live position or a way into their copy through the party | R1 | server `social/system.ts` (`applyBlock`) |
| **Report** in game: who, when, which planet and where, and a reason category. **Never audio** (none exists). Stored in game.db `report` | all | server `voice:report` |
| **Report review on `/admin`** by the admin: each report can be dismissed or the target banned (account + network). Kick and **voice-mute** (stops all relaying to and from the player) sit in the "Players online" table, so they work only while the player is online; admins also have kick/mute/ban in the Tab list | all | `ops/admin.ts`, `social/moderation.ts`, server `voice:mute` |
| **Ban → voice ends:** a ban revokes all the account's relay credentials at once (failed revocations are retried after 30 s, 2 min and 10 min), removes the player, and any room still holding them turns their voice off within a second | all | `banAccount` → `turnCredentials.revokeUser`, `VoiceSystem` tick |
| **Relay-only connections** in production (`iceTransportPolicy: "relay"`, per-player Cloudflare TURN credentials, 12 h lifetime, re-minted every 6 h): players never see each other's IP address. If the relay is down, voice is unavailable rather than falling back to direct connections | R7 | server `voice/turn.ts` |
| The server relays set-up messages only for players **within 60 m or on the same radio channel** (both holding a radio), never across the world; rate-limited (signals 20/s, burst 40; actions 2/s, burst 12) | R1, R6 | server `voice/VoiceSystem.ts` |
| Radio channels capped at 8 holders; radio drops on death | R3 | server |
| No DMs, text chat, media, friend lists or user profiles exist to move contact elsewhere | R3, R6, R8 | design |

## 5. Residual risk and next steps

- **Residual risk:** medium for harassment and hate speech (live speech can't be pre-moderated);
  low but severe for grooming. Acceptable for a small free game **with** the controls above, provided
  reports are reviewed promptly.
- **Report handling:** the admin checks `/admin` reports at least daily during launch week, then
  weekly; serious reports (R3, R5, threats) are handled the same day, with ban and preservation of
  the report row. Reports involving a child at risk are referred to the police / CEOP.
- **Not yet built (planned; checked against the code 2026-10-12, tracked in `docs/STATUS.md` M9):**
  - a public contact address for complaints and appeals (s.20/s.21 reporting and complaints); the
    only address in the code is the sign-in sender;
  - a published terms page that states the voice rules and the 16+ condition (the landing page links
    only to the source code);
  - admin voice-mutes persisted in game.db (today they are an in-memory set and end when the server
    restarts or redeploys);
  - personal mutes are per browser (localStorage), so they don't follow a signed-in player to a
    second browser.
- **If risk rises** (repeated R3/R4 reports, or many under-16 users): switch voice to party-only
  by default, require a saved account for voice, or add real age assurance before voice.

*Practical notes, not legal advice. Ofcom's guidance for small user-to-user services should be
checked before launch; the illegal-content duties have applied since 17 March 2025.*
