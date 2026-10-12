# Before the repo goes public (owner checklist)

Making `RostyslavDzhohola/firstlight` public is the owner's call (DECISIONS, Process; D31). Work
through this list first. Items marked **owner approval** rewrite history or change live puzzles:
run them only after the owner says go, and only when no lane branch is in flight (every worktree
must be re-cloned afterwards).

## 1. Scrub the first-look screenshot from history (owner approval)

`docs/reviews/firstlook-1.png` showed the owner's browser bookmarks bar and profile avatar. It was
deleted on `lane/f12-docs`, but every older commit still contains it. The same run can drop the old
committed Python caches (`tools/blender/characters/__pycache__/*.pyc`, which embed local paths).

Run in a fresh mirror clone, never in a working worktree (needs `git-filter-repo`,
e.g. `brew install git-filter-repo`):

```sh
git clone --mirror https://github.com/RostyslavDzhohola/firstlight.git firstlight-scrub.git
cd firstlight-scrub.git
git filter-repo --invert-paths \
  --path docs/reviews/firstlook-1.png \
  --path-glob 'tools/blender/characters/__pycache__/*'
git log --all --oneline -- docs/reviews/firstlook-1.png    # must print nothing
```

Optional, same clone: rewrite the local worktree paths that older revisions of
`docs/reviews/2026-10-12-render-opus-5-5.md` contain (61 occurrences, all under `fl-wt-render`;
the folder name is in them):

```sh
printf '%s\n' \
  'regex:/Users/[^/\n]+/Projects/[^/\n]+/fl-wt-render/==>' \
  'regex:/Users/[^/\n]+/Projects/[^/\n]+/fl-wt-render==>fl-wt-render' > ../fl-replace.txt
git filter-repo --replace-text ../fl-replace.txt
git log --all -p | grep -c -E '/Users/[A-Za-z]'            # must print 0 (also add docs/reviews/2026-10-12-f12-sonnet-5-5.md's one /Users line from dd4ed12 to the replace list)
```

Push the rewritten history (filter-repo removes the `origin` remote on purpose):

```sh
git remote add origin https://github.com/RostyslavDzhohola/firstlight.git
git push --force --all origin && git push --force --tags origin
```

Afterwards: delete every old clone and worktree (`../fl-wt-*`) and clone again, so nobody pushes the
old commits back. Open pull requests keep old objects on GitHub; close them first, or ask GitHub
Support to purge cached views if the image matters.

## 2. Take the Easter-egg solutions out of the public source (owner approval)

Each egg's first finder is engraved on a Hall of Firsts plaque, so with public source anyone can
claim them from the code instead of the game. The solutions live in:

- `packages/shared/src/content/secrets.ts`: `EGG_RULES` (E2 symbol order, E5 rope order, E7 keypad
  code, E4/E8 counts and windows). The client bundle also carries the `EGGS` table (names, places,
  reward items) because it imports `PLAQUES` from this file.
- `apps/client/src/world/QuestWorld.ts`: E7's code painted in the world (the in-game clue, by design:
  rotate it together with `E7_CODE`).
- `apps/server/test/quests.test.ts`: the tests send the real answers.
- `docs/content.md` §6 (full walkthroughs) and the M2 mission row in §5.

Options, pick one: (a) move `EGG_RULES` into a server-only file loaded from outside git (e.g. the
Railway volume) and give the tests their own fixture values; (b) rotate the solutions right before
going public and keep the real ones out of the repo (private copy of content.md §6); (c) accept that
the eggs are spoiled. Whatever you pick, also clear test claims from game.db's `hall_of_firsts` table
before launch.

## 3. No local paths or personal emails

```sh
git grep -n -I -E '/Users/[A-Za-z]|/home/[a-z]|C:\\Users'               # expect nothing
git grep -n -I -E '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' -- ':!pnpm-lock.yaml' \
  | grep -v -E '@example\.(com|test)|\.example\b|@test\.invalid|noreply@anthropic\.com|@firstlight\.one4all\.dev'
git grep -n -I -i 'rostyslav'      # expect only the GitHub repo name (config.ts, SPEC, DECISIONS, STATUS, this file)
git log --all --format='%an <%ae>%n%cn <%ce>' | sort -u                  # commit identities
```

Every commit so far is authored with the owner's personal email address. If it shouldn't be public,
rewrite it to the GitHub noreply address with `git filter-repo --mailmap <file>` in the same mirror
clone as §1 (owner approval), and set `git config user.email` to the noreply address for future
commits.

## 4. Licences

- `LICENSE` (MIT, "FIRSTLIGHT contributors") and `LICENSE-ART` (CC BY 4.0): confirm the holder name
  you want on them.
- `docs/ASSETS.md`: every third-party file and library, with licence and source.
- `apps/client/public/fonts/LICENSES.md` (full OFL 1.1 text) and
  `apps/client/public/THIRD-PARTY-NOTICES.md` (MIT notices for bundled packages): rebuild the
  notices list if client dependencies changed (method at the top of that file).
- No ElevenLabs outputs or raw third-party archives in history:
  `git log --all --diff-filter=A --name-only --format= | grep -i -E '\.(mp3|wav|ogg|zip|blend)$'`
  should print nothing.

## 5. No secrets in history

Scan the whole history, not just the working tree, with redaction on so findings don't print the
secrets themselves:

```sh
gitleaks git --redact -v .          # gitleaks 8.19+; older versions: gitleaks detect --redact -v
```

If anything real turns up: rotate it first (Railway, Vercel, Cloudflare, Resend, ElevenLabs), then
remove it from history the same way as §1. After going public, turn on GitHub secret scanning and
push protection for the repo.

## 6. Third-party IP wording

```sh
git grep -n -i -E 'oasis|ready player|parzival|halliday|sixers|\bIOI\b|sorrento' -- ':!docs/reviews' ':!docs/pre-public.md'
```

- Expected today: `docs/content.md` §3.4 (below) and §9's mention of the unrelated avatar service
  "Ready Player Me".
- "OASIS-style" was replaced with neutral wording in DECISIONS and SPEC; older commits still contain
  it (rewriting that is optional, with `--replace-text` as in §1).
- `docs/content.md` §3.4 names that franchise's villains in an avoid list; other avoid lists and the
  name check (§8.2, §10) name franchises on purpose. Decide whether to keep them public or reword
  them as plain descriptions.
- `docs/reviews/` are kept as records and quote some of this wording.
- The F12 review asked for the Meridian Associates to move off the clone-trooper look (slate grey,
  amber visors, content.md §3.4): merged in c57d406 (the Sonnet final review confirmed it).
- The NPC name "Hopbit" is one letter from a franchise word, which content.md §10's own "no
  one-letter variants" rule bans. Low risk and display-name only (the id `hopbit` can stay): decide
  whether to rename before going public.

## 7. Front page

- README.md exists (what it is, how to run it, licences). Add a CONTRIBUTING.md (how to run tests,
  the erasable-TypeScript rule, review process) if you want outside contributions.
