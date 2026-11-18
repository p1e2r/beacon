# Beacon

Play on **Minecraft Java 26.x servers from a browser tab**. Beacon is a multiplayer-only
web client (no singleplayer) plus a small proxy that you host. Players open your page,
paste the key you gave them, and join any 26.1 / 26.2 / 26.3 server.

```
browser ──wss:// (TLS)──► Cloudflare ──tunnel──► Beacon proxy ──TCP──► any Minecraft server
           key checked here ───────────────────────┘
```

Browsers can't open raw TCP connections, so the proxy turns a WebSocket into a TCP
connection. It only does that for people holding a key you created.

## What works

- Offline-mode (cracked) servers on **26.1 (775), 26.2 (776), 26.3 (777)**, auto-detected by
  pinging the server first. Other versions work if the server runs ViaVersion.
- Login, configuration phase (registries, code of conduct, resource-pack prompts), compression,
  keep-alives, chunk batches, transfers to another server.
- World rendering with lighting and ambient occlusion. Textures and block models come from your
  own **client .jar or a resource pack** (Beacon ships none of Mojang's assets); without one,
  blocks are drawn in flat colours from their real shapes.
- Vanilla-style movement (walk/sprint/sneak/jump, swimming, ladders, step-up, sneak at edges,
  creative/spectator flying), breaking (instant in creative, timed in survival), placing,
  using items, attacking and interacting with entities, picking blocks.
- Chat with colours and translations, commands (`/login`, `/register` for AuthMe), titles,
  action bar, tab list, health/food/XP, death screen + respawn, F3 debug.
- Other players and mobs as simple boxes with name tags.
- Server list with MOTD, icon, player count and ping.

Not yet: online-mode (premium) servers, moving items in inventories/chests (they're view-only),
sounds, entity models/skins, signs and other block-entity text, crafting UI.

## Hosting the proxy (Docker)

1. Start it with [`docker-compose.yml`](docker-compose.yml) (`docker compose up -d`). It's
   standalone and publishes two ports on the host: **7320** (players) and **9108** (admin).
2. In your Cloudflare tunnel, point a public hostname (e.g. `mc.example.com`) at
   `http://<server-lan-ip>:7320`. Use `http://localhost:7320` if cloudflared runs on the same
   machine, or `http://beacon:7320` if it's in the same compose network. cloudflared can run
   anywhere that can reach that port. **Don't** route port 9108.
3. Open the admin panel from your home network: `http://<server-lan-ip>:9108`.
4. In **Settings**, set *Public address* to `https://mc.example.com` (used for invite links).
5. Under **Keys**, create a key per friend and send them the key or the invite link.

Without Cloudflare: any reverse proxy that terminates TLS and sets `X-Forwarded-Proto: https`
(Caddy, nginx, Traefik) works the same way. Friends on your LAN can use
`http://<server-lan-ip>:7320` directly.

Players just open `https://mc.example.com`, pick a username, paste the key and add servers.

### Admin panel

Only answers direct requests from localhost or private network addresses. Anything carrying
tunnel/proxy headers, or coming from a public IP, gets a 404. It shows live connections
(player, server, key, IP, traffic) and lets you create, rename, disable, expire and delete keys,
disconnect players, unblock IPs, and change settings. Disabling or deleting a key kicks
everyone using it straight away. For an extra lock, set `admin_token` in `data/config.json`.

Keys can also be managed from the command line, and a running proxy picks up the change:

```sh
docker exec -u beacon beacon beacon-proxy key create "Budi" --days 30 --max 1
docker exec -u beacon beacon beacon-proxy key list
docker exec -u beacon beacon beacon-proxy key disable <id>
```

### Security notes

- Keys are 32 random bytes. Only their SHA-256 hash is stored, they're compared in constant
  time, and they travel in the WebSocket handshake rather than the URL. Five wrong keys in a
  minute block that IP for 10 minutes.
- By default the proxy refuses keys over plain `ws://` from the internet. Through the
  Cloudflare tunnel the browser→Cloudflare hop is TLS.
- The proxy refuses to connect to private/LAN/loopback addresses, so key holders can't use it
  to reach other devices on your network. Use *Always-allowed servers* (or *Allow
  private-network servers*) for a Minecraft server on the same LAN.
- **The proxy can see everything a player sends**, including `/login` passwords, because
  offline-mode Minecraft isn't encrypted. The same is true for the hop from the proxy to the
  game server. Only use proxies you trust, and use a password you don't use anywhere else.

### Settings (`data/config.json`)

| key | default | |
|---|---|---|
| `name` | `Beacon proxy` | shown to players |
| `public_url` | | for invite links |
| `require_key` | `true` | |
| `allowed_ports` | `1024-65535` | target ports |
| `allowed_hosts` / `blocked_hosts` | `[]` | exact or `*.domain` |
| `allow_private_targets` | `false` | |
| `max_connections`, `max_connections_per_ip` | `0`, `4` | 0 = unlimited |
| `max_failures_per_minute` | `5` | wrong keys before a 10-minute block |
| `allow_insecure` | `false` | allow keys over plain ws:// from the internet |
| `trust_proxy_headers` | `true` | real player IP from CF-Connecting-IP when the peer is local |
| `admin_token` | | optional extra admin password |

Environment: `BEACON_LISTEN` (`0.0.0.0:7320`), `BEACON_ADMIN_LISTEN` (`0.0.0.0:9108`),
`BEACON_DATA` (`/data`), `BEACON_WEB` (`/app/web`).

### Textures for everyone

Players load their own `.jar` once (it stays in their browser). As the owner you can also put a
resource pack at `web/pack.zip` inside the container; clients without their own pack use it.

## Controls

WASD move · mouse look · Space jump (double-tap to fly in creative) · Shift sneak · Ctrl sprint ·
left click break/attack · right click place/use · middle click pick block · 1–9 / wheel hotbar ·
Q drop · F swap hands · T or Enter chat · `/` command · E inventory · Tab players · F3 debug ·
Esc menu.

## Development

```sh
cd client && npm ci && npm run dev        # http://localhost:5173 (needs a running proxy)
cd proxy && cargo run                     # proxy on :7320, admin on :9108
cd client && npm test && npm run build    # unit tests (codec, chunk format, physics) + build
```

`client/data-src/<version>` holds minecraft-data JSON (protocol, blocks, collision shapes,
entities, items, language); `npm run data` compacts it into `public/data`. To add a version,
drop its folder in and rebuild.

`tools/e2e` runs a tiny offline 26.1 test server and a headless Chrome that joins it through the
proxy, chats, runs a command and walks around.

## License

MIT. Not an official Minecraft product; not approved by or associated with Mojang or Microsoft.
