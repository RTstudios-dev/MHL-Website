# MHL website

Site for the Miniature Hockey League. Plain Node, with an optional SFTP client dependency.

## Running it

You need Node 18+. In this folder:

    npm install
    node server.js

Then go to http://localhost:3000, admin is at http://localhost:3000/admin.
Opening the html files directly won't work, everything loads from the server.

The admin password is in `.admin-password` (made on first start). You can also set `ADMIN_PASSWORD` instead.
Don't upload `.admin-password` anywhere, it's already in `.gitignore`.

## Pages

- `/` home
- `/matches`
- `/standings`
- `/teams` and `/team/<name>` for each team
- `/players`
- `/sign-up`, `/player-login`, and `/season-2-players`
- `/news`
- `/rules`
- `/admin`

Player Steam sign-in is available from the top-right button; it is not a navigation tab.

## Admin

Remember to press **Save changes**, nothing goes live until you do.

- Teams: name, short code (shows on the scoreboards), colour, logo, team photo, page address, and Season 2 captain.
  Fill the numbered draft-order dropdowns manually; blank slots are skipped. Assign captains to the selected teams, then start/stop the draft with the button at the top of Teams and press **Save changes**. Team captains cannot be drafted. Steam-authenticated captains pick on the public Season 2 Player Sign Ups board in order; captains are redirected there when their turn starts, their remaining budget is pinned at the top of the page, and pick turns update automatically. Each pick deducts the higher of the player's Skater and Goalie Values, regardless of position. Teams that cannot afford the cheapest remaining player are skipped. Remaining budgets also appear on the regular Teams page. Admins can clear all Season 2 team assignments from the Season 2 Player Sign Ups tab; this also stops the draft and removes its saved picks.
  If you change the page address later, old links to that team stop working.
- Matches: regular rounds are optional. Add Quarter Finals, Semi Finals, and Finals as playoff stages from the Matches tab. Quarter Finals are best-of-3, Semi Finals best-of-5, and Finals best-of-7.
  Playoff stages allow up to 4 Quarter Finals matches, 2 Semi Finals matches, and 1 Finals match.
  The admin preview and public Matches page show who advances, and Finals show the champion and finalist.
  Playoff matches do not affect regular-season records or form. Once playoff matches are recorded, both standings tables order teams by playoff finish; teams tied at a finish keep their regular-season order, and non-playoff teams follow.
  It shows you the result and points before saving regular-season matches.
  Under each match there is a **Goals** list with a row for every goal in the scores.
  Pick who scored and up to two assists, the player totals count themselves.
  Goals from a game that does not count (a tie or a game after the series is decided) are not counted.
- Players: name, team, number, position. Their goal and assist totals add up from the matches.
- News: pinned posts stay on top, the newest one also shows on the home page.
- Rules: shown in the same order as in the admin.
- Season 2 Player Sign Ups: signups include position and Steam profile. Players can use a numeric `/profiles/<SteamID>` URL or a custom `/id/` URL; the form requests the 17-digit Steam ID separately when the profile URL does not contain it. Admins can enter a manual Steam ID for existing signups whose profile URL does not contain one. Steam links are admin-only; after signing up, players can choose to visit the Season 2 Player Sign Ups page. Admins can edit signup answers, assign a team, set separate Skater and Goalie Values in euros, and set the Ice Cap and Team Cap amounts. Every signup automatically appears as an editable player slot, including unassigned players; the Players tab lets admins edit its team, position, in-game name, Discord username, jersey number, and values. The caps appear between the signed-in player's entry and the public signup list. Team budgets and assigned Season 2 player values are shown in Teams. Duplicate Discord usernames or Steam profiles are rejected; players can use Player Login with the Steam account on their existing signup, or ask staff for help.
- Badges: upload 400×400 PNGs and set combined goals, assists, saves, configured-points, and game-milestone requirements (games with a goal, 3+, 5+, or 10+ goals; 10+, 20+, or 30+ saves; and games with a 100% save percentage), audience toggles, or manual Season 2 awards. Eligibility is recalculated from current tracked stats. Players can equip up to three distinct unlocked badges from Player Login; locked badges remain in their collection.
- The Player Stats page lists every Season 2 signup, including unassigned players, and shows each player's W:L record. Wins can be sorted in either direction. Points are position-specific: skaters earn points from goals and assists, while goalies earn points from saves and assists. Admins can edit linked players' goals, assists, saves, stick saves, body saves, passes, wins, and losses in the Players tab; later game-mod events continue adding to those totals. Admins can set independent goals-per-point, assists-per-point, and saves-per-point requirements in Admin > Settings; defaults are 1 goal, 1 assist, and 2 saves per point. The game mod records linked-player stats for any position when both the MHL mod (Workshop ID `3788905426`) and StatsTooltip (Workshop ID `3608968085`) are active on the authoritative server, the game has started, and at least six players are in the game. Once these requirements are met during a game, tracking remains enabled for that game even if the player count later drops. A completed eligible game counts once toward games played and records each player's goals for games-scored-in, 3+, 5+, and 10+ goal milestones, and games with 10+, 20+, and 30+ saves. Goalie games with a 100% save percentage are counted separately. Goals, assists, and saves per game use eligible games played as their denominator; average save percentage is the arithmetic mean of per-game save percentages for games with shots faced. Wins and losses use the final team score; meeting the existing eligibility requirements within the final minute still counts the result.
- The game mod uses `GET /api/mod/roster` for linked Steam IDs and player values, and `POST /api/mod/stats` for authenticated goal, assist, save, stick-save, body-save, pass, game-summary, win, and loss events. The Player Login profile has a tracked-game-stats section with totals, per-game rates, and game milestones; its summary row uses those same tracked totals. Its Players tab displays current server players as website-styled A4 cards, four across, and refreshes their equipped badges and portrait from the roster. The Ice Cap rows are removed from the in-game leaderboard when the local player disconnects from the server. Eligible game events are uploaded in batches during play and flushed when the game ends. Unsent events are persisted as `MHLGameStatsPending.json` in the `MHL Stats` folder beside the game's data folder (for example, `C:\Program Files (x86)\Steam\steamapps\common\Puck\MHL Stats`) and retried. Admins can select this file in Admin > Players; the page reads and previews it before import. Imports use the same event-ID deduplication as live uploads and credit only linked signups. Both mod endpoints require `Authorization: Bearer <MHL_MOD_API_KEY>`. The public roster includes linked Steam IDs, names, positions, teams, values, tracked stats, optional profile-picture paths, and images for equipped unlocked badges; it does not include Steam profile URLs or other signup details. Stats responses report how many events were credited or unmatched.
- The website can optionally poll pending stats JSON files over SFTP. Configure `MHL_STATS_SFTP_CONFIG` with the SFTP host, port, username, pinned SHA-256 host-key fingerprint, one authentication environment-variable name, and a `sources` array containing each selected server's name and full JSON path. Use either `privateKeyBase64Env` (recommended) or `passwordEnv`; store the referenced secret in the hosting provider's environment settings, not in this file. `MHL_STATS_SFTP_POLL_SECONDS` is optional (default 60; allowed range 30-3600). The poller is read-only: it does not delete or alter remote files, and repeated imports are deduplicated by event ID. The mod may remove a pending file after a successful direct API upload, so SFTP polling only sees files that remain pending.
- Server scripts can push stats JSON files to `POST /api/stats-import`. The endpoint is enabled by the `MHL_STATS_PUSH_KEY` environment variable; when it is unset, the endpoint returns 503 and the website continues running. It validates the server identifier and file SHA-256 header, uses the existing event-ID deduplication, and stores accepted stats in the site's persistent data.
- Admin > Logs lists the latest 500 automatic stats JSON imports from server push and SFTP, including local display time, source/server, filename when available, import status, event counts, and file hash. Manual admin imports and live mod uploads are not included. Log records are kept in the persistent site data and are available only to admins.
- Player Profile: the top-right Steam button becomes the player's profile picture when signed in. The profile page keeps its account summary separate from the editable in-game player card. The player stats show a W:L record. That card uses an A4 portrait layout with the player's name, evenly spaced profile picture and three editable badge slots, and an independently uploaded square-cropped portrait with clear inset spacing; the portrait controls sit below the card. Team, value, and vertically stacked goals, assists, and saves appear underneath the artwork. The collection below it shows locked and unlocked badges. This does not change Admin login.
- Settings: season name and Discord link (leave it empty to hide the Discord button). Admins can download a self-contained JSON backup containing saved site data, stats, uploaded images, and the league logo; website source code and server secrets are not included.
- The backup's `data` field contains the saved site database. Each item in `assets` has a relative `path`, `contentType`, and base64-encoded file contents; restore `uploads/...` files under `DATA_DIR` and the logo beside `server.js`.

Public Season 2 signups are saved in the same persistent `data.json` as the rest of the site. Optional profile pictures and player-card portrait images are stored in `uploads/`, alongside team images, and are retained when admin changes are saved. Existing signups without position, team, or Steam profile remain unassigned/blank.

Existing single signup Values are carried into both the Skater and Goalie Values until an admin changes them. A displayed value of zero appears as a dash on the public board.

Steam sign-in uses OpenID and never collects player passwords. It is not required to submit a signup. For existing custom Steam `/id/` links, admins can enter the player's Steam ID in Admin, or set the optional `STEAM_API_KEY` on the host so Player Login can resolve those links; numeric `/profiles/` links work without it. Admin login remains separate.

## Points

- 2-0 win: 3 points for the winner, 0 for the loser
- 2-1 win: 2 points for the winner, 1 for the loser

Tied games don't count, and games after a series is decided are ignored.
If teams have the same points it goes by games won, then head to head, then series won, then goal difference, then goals scored.
These points and tiebreakers apply to regular-season rounds only; playoff series determine advancement and final finish separately.

## Logo

The logo is `logo.webp`. It shows in the menu, as the browser tab icon and in link previews. To change it, replace the file (`logo.png` or `logo.jpg` also work, keep just one).

The faded rink picture behind the pages is `bg.webp`. Swap the file to change it, or change how strong it is with the `opacity` on `body::before` in `site.css`.

## Files

- `server.js` - the server (data, login, uploads)
- `standings.js` - points and table maths, used by both the site and the admin
- `site.css`, `site.js` - shared look and code for the public pages
- `bg.webp` - the background picture
- `*.html` - the pages, `admin.html` is the admin
- `data.json` - all the content
- `uploads/` - team logos and photos
- `hash-password.js` - makes the password hash for hosting

## Hosting

The host needs Node 18+ and a **persistent disk**. Without one, every redeploy wipes the teams, results and photos.

1. Make a password hash: `node hash-password.js`, type a long password, copy the `scrypt$...` line it prints.
   Keep the password somewhere safe, it can't be recovered from the hash.
2. Put this folder in a private GitHub repo.
3. On Railway/Render/etc. make a web service from the repo. No build command, start command is `node server.js`.
   Mount the disk at `/data`. (Fly.io or a VPS: use the Dockerfile.)
4. Set these env vars:
   - `NODE_ENV=production`
   - `ADMIN_PASSWORD_HASH=` the line from step 1
   - `MHL_MOD_API_KEY=` a separate random key of at least 32 characters for the game mod (never use the admin password)
   - `DATA_DIR=/data`
   - `TRUST_PROXY=1`

Check `https://your-site/healthz` says `ok` and that you can log in at `/admin`.

Generate a mod API key with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Set the same value as `MHL_MOD_API_KEY` in the website host environment and in the host game's MHL tab. Keep it private; the mod sends only linked player IDs needed for the roster and eligible game stats.

To pull pending files from SFTP instead, add `MHL_STATS_SFTP_CONFIG` in Railway as a JSON value, for example:

    {
      "host": "sftp.example.com",
      "port": 22,
      "username": "mhl-stats-reader",
      "hostKeyFingerprint": "SHA256:HOST_KEY_FINGERPRINT",
      "privateKeyBase64Env": "MHL_STATS_SFTP_KEY_BASE64",
      "passphraseEnv": "MHL_STATS_SFTP_KEY_PASSPHRASE",
      "sources": [
        { "name": "server1", "remotePath": "/srv/puck/server1/MHL Stats/MHLGameStatsPending.json" },
        { "name": "server2", "remotePath": "/srv/puck/server2/MHL Stats/MHLGameStatsPending.json" },
        { "name": "server3", "remotePath": "/srv/puck/server3/MHL Stats/MHLGameStatsPending.json" }
      ]
    }

Create a read-only SFTP account/key and add the base64-encoded private key as the `MHL_STATS_SFTP_KEY_BASE64` Railway variable. For an encrypted private key, also set `passphraseEnv` to the name of a separate Railway secret containing its passphrase. If the SFTP account uses password authentication instead, set `passwordEnv` to the name of a Railway secret containing that password. Pin the SFTP server's SHA-256 host-key fingerprint from WinSCP; the poller rejects unverified hosts. The site logs polling, missing files, and per-source errors. It starts polling 5 seconds after startup, then repeats at the configured interval.

SFTP polling is optional. If `MHL_STATS_SFTP_CONFIG` or a referenced secret is missing or invalid, the website logs the problem and continues running with SFTP polling disabled.

On the first start it copies `data.json` and `uploads/` onto the disk, after that the disk is what counts.
So content changes go through `/admin` on the live site, and code/design changes get pushed to GitHub (redeploying doesn't touch the content).

Back up `data.json` and `uploads/` from the disk every now and then.

## Security

Only the admin can change anything, and uploads have to be real images.
5 wrong passwords locks login for 5 minutes. Admin and player logins last 12 hours. Player sessions are stored under `DATA_DIR/.player-sessions/`, so they survive server restarts when `DATA_DIR` is on persistent storage. If you run multiple server instances, they must share the same `DATA_DIR`; otherwise a sign-in may not be recognized by another instance.
