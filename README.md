# MHL website

Site for the Miniature Hockey League. Plain Node, nothing to npm install.

## Running it

You need Node 18+. In this folder:

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
- `/news`
- `/rules`
- `/admin`

## Admin

Remember to press **Save changes**, nothing goes live until you do.

- Teams: name, short code (shows on the scoreboards), colour, logo, team photo, page address.
  If you change the page address later, old links to that team stop working.
- Matches: rounds are optional. Each match is a best of 3, just type in the score of every game played.
  It shows you the result and points before saving.
  Under each match there is a **Goals** list with a row for every goal in the scores.
  Pick who scored and up to two assists, the player totals count themselves.
  Goals from a game that does not count (a tie, or a game 3 after 2-0) are not counted.
- Players: name, team, number, position. Their goal and assist totals add up from the matches.
- News: pinned posts stay on top, the newest one also shows on the home page.
- Rules: shown in the same order as in the admin.
- Settings: season name and Discord link (leave it empty to hide the Discord button).

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
   - `DATA_DIR=/data`
   - `TRUST_PROXY=1`

Check `https://your-site/healthz` says `ok` and that you can log in at `/admin`.

On the first start it copies `data.json` and `uploads/` onto the disk, after that the disk is what counts.
So content changes go through `/admin` on the live site, and code/design changes get pushed to GitHub (redeploying doesn't touch the content).

Back up `data.json` and `uploads/` from the disk every now and then.

## Security

Only the admin can change anything, and uploads have to be real images.
5 wrong passwords locks login for 5 minutes. Logins last 12 hours, restarting the server logs everyone out.
