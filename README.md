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
- Matches: rounds are optional. Each match is a best of 3, just type in the score of every game played.
  It shows you the result and points before saving.
  Under each match there is a **Goals** list with a row for every goal in the scores.
  Pick who scored and up to two assists, the player totals count themselves.
  Goals from a game that does not count (a tie, or a game 3 after 2-0) are not counted.
- Players: name, team, number, position. Their goal and assist totals add up from the matches.
- News: pinned posts stay on top, the newest one also shows on the home page.
- Rules: shown in the same order as in the admin.
- Season 2 Player Sign Ups: signups include position and Steam profile. Players can use a numeric `/profiles/<SteamID>` URL or a custom `/id/` URL; the form requests the 17-digit Steam ID separately when the profile URL does not contain it. Admins can enter a manual Steam ID for existing signups whose profile URL does not contain one. Steam links are admin-only; after signing up, players can choose to visit the Season 2 Player Sign Ups page. Admins can edit signup answers, assign a team, set separate Skater and Goalie Values in euros, and set the Ice Cap and Team Cap amounts. Every signup automatically appears as an editable player slot, including unassigned players; the Players tab lets admins edit its team, position, in-game name, Discord username, jersey number, and values. The caps appear between the signed-in player's entry and the public signup list. Team budgets and assigned Season 2 player values are shown in Teams. Duplicate Discord usernames or Steam profiles are rejected; players can use Player Login with the Steam account on their existing signup, or ask staff for help.
- The Player Stats page lists every Season 2 signup, including unassigned players. Admins can edit linked players' goals, assists, and saves in the Players tab; later game-mod events continue adding to those totals. The game mod records linked-player goals and assists, plus goalie saves when both the MHL mod (Workshop ID `3788905426`) and StatsTooltip (Workshop ID `3608968085`) are active on the authoritative server, the game has started, and at least six players are in the game. One point is awarded per two saves. The page has player/position filters, value sorting, search, and Pug Stats/Season 2 Stats views; Season 2 stats display as dashes until tracking is added.
- The game mod uses `GET /api/mod/roster` for linked Steam IDs and player values, and `POST /api/mod/stats` for authenticated stat events. Eligible game events are uploaded in batches during play and flushed when the game ends. Unsent events are persisted as `MHLGameStatsPending.json` in the `MHL Stats` folder beside the game's data folder (for example, `C:\Program Files (x86)\Steam\steamapps\common\Puck\MHL Stats`) and retried. Admins can select this file in Admin > Players; the page reads and previews it before import. Imports use the same event-ID deduplication as live uploads and credit only linked signups. Both mod endpoints require `Authorization: Bearer <MHL_MOD_API_KEY>`. The roster endpoint does not include Steam profile URLs or other signup details; stats responses report how many events were credited or unmatched.
- The website can optionally poll pending stats JSON files over SFTP. Configure `MHL_STATS_SFTP_CONFIG` with the SFTP host, port, username, pinned SHA-256 host-key fingerprint, one authentication environment-variable name, and a `sources` array containing each selected server's name and full JSON path. Use either `privateKeyBase64Env` (recommended) or `passwordEnv`; store the referenced secret in the hosting provider's environment settings, not in this file. `MHL_STATS_SFTP_POLL_SECONDS` is optional (default 60; allowed range 30-3600). The poller is read-only: it does not delete or alter remote files, and repeated imports are deduplicated by event ID. The mod may remove a pending file after a successful direct API upload, so SFTP polling only sees files that remain pending.
- Player Profile: the top-right Steam button becomes the player's profile picture when signed in. The profile page shows Discord and roster goals, assists, and points above the editable Season 2 signup. This does not change Admin login.
- Settings: season name and Discord link (leave it empty to hide the Discord button).

Public Season 2 signups are saved in the same persistent `data.json` as the rest of the site. Optional profile pictures are stored in `uploads/`, alongside team images, and are retained when admin changes are saved. Existing signups without position, team, or Steam profile remain unassigned/blank.

Existing single signup Values are carried into both the Skater and Goalie Values until an admin changes them. A displayed value of zero appears as a dash on the public board.

Steam sign-in uses OpenID and never collects player passwords. It is not required to submit a signup. For existing custom Steam `/id/` links, admins can enter the player's Steam ID in Admin, or set the optional `STEAM_API_KEY` on the host so Player Login can resolve those links; numeric `/profiles/` links work without it. Admin login remains separate.

## Points

- 2-0 win: 3 points for the winner, 0 for the loser
- 2-1 win: 2 points for the winner, 1 for the loser

Tied games don't count, and a game 3 after a 2-0 is ignored.
If teams have the same points it goes by games won, then head to head, then series won, then goal difference, then goals scored.

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

On the first start it copies `data.json` and `uploads/` onto the disk, after that the disk is what counts.
So content changes go through `/admin` on the live site, and code/design changes get pushed to GitHub (redeploying doesn't touch the content).

Back up `data.json` and `uploads/` from the disk every now and then.

## Security

Only the admin can change anything, and uploads have to be real images.
5 wrong passwords locks login for 5 minutes. Logins last 12 hours, restarting the server logs everyone out.
