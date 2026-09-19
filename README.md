# Danychat

Chat, watch videos and play games with friends. Real accounts (username + password), real friends, real chat and real video posts.
The only simulated "person" is **DANY AI**, a scripted bot every account starts as friends with.

## Run

```bash
node server.js            # needs Node 18+, no npm install required
# → http://localhost:8000
```

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `8000` | Port to listen on |
| `HOST` | `127.0.0.1` | Use `0.0.0.0` to accept connections from other machines |
| `DATA_DIR` | `./data` | Where `db.json` and uploaded `videos/` live |
| `TRUST_PROXY` | unset | Set to `1` behind a reverse proxy (HTTPS / real client IPs) |

## Logo

The logo is text: **Dany / Fuad / Dahan**, one word per line, in the header and on the login screen (`.text-logo` in `styles.css`, markup in `index.html` and `textLogo()` in `app.js`).

## Going public

Friends can only join if they can reach the server, so it needs to be hosted somewhere (a small VPS, Fly.io, Render, …) **behind HTTPS**.
HTTPS also matters for security (passwords are sent to the server) and for the in-app camera recorder, which browsers only allow on secure origins.
Back up the `DATA_DIR` folder — it is the whole database.

## Moderators, shop and streaks

- **Moderators** are set on the server by username (`MODS=name1,name2`, default `grantclark`). They get a 🔨 MOD badge, can remove any video they can see, and have a "Claim 100 🪙" button. Make sure those accounts exist before opening the app to other people.
- **Dan Shop**: pets for your avatar, premium emoji stickers (sent from any chat) and name tags (cosmetic only). Coins come from a daily bonus, posting, playing, and making new friends.
- **Streaks** grow by one for every calendar day on which *both* friends have messaged each other, and end if a day is missed (server-local days).

## Notes

- Passwords are hashed with scrypt; sessions are random tokens in `HttpOnly` cookies; login attempts are rate limited.
- Data is a single JSON file, which is fine for a few hundred users. Past that, swap it for a real database.
- Game scores are reported by the browser, so they're trust-based — fine for friends, not for a public competition.
