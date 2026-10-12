# Proximity voice: illegal-content risk assessment (UK Online Safety Act)

**Service:** FIRSTLIGHT, a free open-world browser game. **Feature assessed:** proximity voice and
radio (SPEC §5.7). **Written:** 2026-10-11, at build (M5). **Review:** before launch, after any
report of serious harm, after any change to how voice works, and at least once a year.
**Owner:** the game's operator (the admin account).

## 1. What the feature is

- Players talk by **live speech only**. There is no text chat, no voice messages, no file or image
  sharing, no private DMs. The only other user-to-user channel is six fixed phrases ("Truce?", "Help!",
  "Follow me", "Boss here", "Thanks", "GG").
- **Proximity voice:** you hear players within 35 m of you in the same world copy (at most 40 players
  per copy; links to the 12 nearest). **Radio:** players who own an in-game radio and tune to the same
  channel (1–9, at most 8 per channel) hear each other anywhere on that planet copy.
- **Off by default.** Hearing and speaking both start off. Turning voice on needs an opt-in panel
  with an "I'm 16 or older" checkbox and a microphone permission prompt. Push-to-talk (V; B for
  radio): nothing is sent unless a key is held.
- **Never recorded.** Audio flows peer to peer through a relay (Cloudflare TURN). The game server
  only relays connection set-up messages; it never receives, stores or processes audio.
- Group speech between more than two users is in scope of the Act (only one-to-one live speech is
  exempt, s.55), so this assessment covers the feature.

## 2. Users

Anonymous guests and email-saved accounts; display names are unique, 3–16 characters and filtered
for slurs. The game is not aimed at children, but a browser game will attract some.
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
| **16+ self-declaration** before enabling (not age assurance; see §2); the server refuses to enable without it | R3, R4 | server `voice:enable` |
| **Push-to-talk** (V, B); the mic is not sent otherwise; listen-only if the mic is denied | R1, R2, R4 | client sender gating |
| **Mute** any player (local, remembered by account) and **"mute strangers"** (hear only your party) | R1, R2, R4 | client |
| **Panic mute-all** (Shift+Esc) silences everyone at once and stops transmitting | all | client |
| **Block** (persisted on the server, both directions, across sessions): the server stops relaying connection set-up between the pair and tells both clients to hang up; the blocked player's relay credential is revoked | R1–R6 | server `voice:block`, game.db `block` |
| **Report** in game: who, when, which planet and where, and a reason category. **Never audio** (none exists). Stored in game.db `report` | all | server `voice:report` |
| **Admin voice-mute** (stops all relaying to and from the player; in-game for admins today) | all | server `voice:mute` |
| **Ban → voice ends:** within a second of a ban being recorded in game.db, the room turns the player's voice off, tells peers to hang up and revokes their relay credentials (failed revocations are retried) | all | server `VoiceSystem` tick, `revokeVoiceForUser` |
| **Report review on `/admin`** by the admin, with kick and ban (account + IP hash) | all | M8 admin tools (**pending**, see §5) |
| **Relay-only connections** in production (`iceTransportPolicy: "relay"`, per-player Cloudflare TURN credentials, 12 h lifetime, re-minted every 6 h): players never see each other's IP address. If the relay is down, voice is unavailable rather than falling back to direct connections | R7 | server `voice/turn.ts` |
| The server relays set-up messages only for players **within 60 m or on the same radio channel**, never across the world; rate-limited | R1, R6 | server `voice/VoiceSystem.ts` |
| Radio channels capped at 8 holders; radio drops on death | R3 | server |
| No DMs, text chat, media, friend lists or user profiles exist to move contact elsewhere | R3, R6, R8 | design |

## 5. Residual risk and next steps

- **Residual risk:** medium for harassment and hate speech (live speech can't be pre-moderated);
  low but severe for grooming. Acceptable for a small free game **with** the controls above, provided
  reports are reviewed promptly.
- **Report handling:** the admin checks `/admin` reports at least daily during launch week, then
  weekly; serious reports (R3, R5, threats) are handled the same day, with ban and preservation of
  the report row. Reports involving a child at risk are referred to the police / CEOP.
- **Not yet built (planned, M8):** the `/admin` page that lists reports with kick/ban actions (reports
  are already stored; until the page ships the admin reads the `report` table directly), a public
  contact address for complaints and appeals (s.20/s.21 reporting and complaints), a published terms
  page that states the voice rules and the 16+ condition, and admin voice-mutes persisted in game.db
  (today they last until the server restarts).
- **If risk rises** (repeated R3/R4 reports, or many under-16 users): switch voice to party-only
  by default, require a saved account for voice, or add real age assurance before voice.

*Practical notes, not legal advice. Ofcom's guidance for small user-to-user services should be
checked before launch; the illegal-content duties have applied since 17 March 2025.*
