# HTTP API

rustplusplus can serve a small HTTP API, for example for a dashboard on a second screen
(the Corsair Xenon Edge dashboard has a widget for it). It is disabled until a token is set.

| Variable | Default | Description |
| --- | --- | --- |
| `RPP_API_TOKEN` | *(empty, API disabled)* | Secret token, at least 16 characters. Generate one with `openssl rand -hex 32`. |
| `RPP_API_PORT` | `24343` | Port of the HTTP server. |
| `RPP_API_HOST` | `0.0.0.0` | Interface to listen on. |
| `RPP_API_LIVE_INTERVAL` | `2000` | While a dashboard is connected to `/stream`, team and map marker positions are fetched this often (ms, min 1000, 2 Rust+ tokens each). `0` turns it off; positions then update with `RPP_POLLING_INTERVAL`. |
| `RPP_SERVER_QUERY_INTERVAL` | `60000` | How often the server's own player list is read with the public Valve server query (ms, min 15000, no Rust+ tokens). `0` turns it off. |

With Docker, publish the port (`-p 24343:24343` or `ports:` in `docker-compose.yml`). The API speaks plain HTTP and the
token can change trackers: only expose it in your LAN or put it behind a reverse proxy with TLS.

## Authentication

Every endpoint except `/api/v1/health` needs the token, either as header `Authorization: Bearer <token>` or as
query parameter `?token=<token>`.

## Endpoints

All endpoints accept an optional `?guild=<discord guild id>`. Without it, the first connected Rust server is used.

| Endpoint | Description |
| --- | --- |
| `GET /api/v1/health` | `{ "ok": true }`, no token needed. |
| `GET /api/v1/servers` | Rust servers the bot is connected to, one per Discord guild. |
| `GET /api/v1/state` | Full state: server info, in-game time (with `secondsTillNight` and `secondsTillDay` once the bot has seen a full in-game day), team, map markers, oil rigs, smart devices, timers. |
| `GET /api/v1/events?limit=50` | Last notifications (newest first, max 100). They are kept in `instances/api_events.cache`, so they survive a bot restart. |
| `GET /api/v1/map.jpg` | Map image of the server. Supports `If-None-Match`. |
| `GET /api/v1/stream` | [Server-Sent Events](https://developer.mozilla.org/docs/Web/API/Server-sent_events): `state` after every poll of the bot and every live position update (default every 2 s), `notification` for every new event. |

### Battlemetrics trackers

The same trackers as in the Discord `#trackers` channel; every change also updates the tracker message there.
Needs `RPP_BATTLEMETRICS_TOKEN`.

| Endpoint | Description |
| --- | --- |
| `GET /api/v1/trackers` | Trackers with every player's status (`online` / `offline` / `unknown`) and seconds online or offline. Also part of `/state` as `trackers`. |
| `GET /api/v1/battlemetrics/online?q=name&limit=100` | Players online on the connected server right now (Battlemetrics), with the trackers they are in. |
| `GET /api/v1/server/players?q=name&limit=500` | The server's own player list, read every minute with the public Valve server query (A2S, no password): in-game name and seconds connected. Each player is cross-checked with the online Battlemetrics players (same name, at least 97 % alike) and the trackers they are in. The query port comes from Battlemetrics or is probed (game port, +1, +2, 28015, 28017); `error` says when the server does not answer. |
| `POST /api/v1/server/query-port` `{port}` | Sets the server's query port when it isn't found automatically (`null` = find it again). |
| `POST /api/v1/battlemetrics/steam-friends` `{profile, steamApiKey?, minScore?}` | Friends of a Steam profile (link, SteamID64 or custom URL name) who are on the server right now. Battlemetrics only knows in-game names, so friends are matched by name similarity (`minScore` 0.5..1, default 0.8); every candidate comes with its `score`. With `steamApiKey` the Steam Web API is used, without it the public friends page. The friend list has to be public. Friends Steam shows playing Rust without a match are in `playingRustElsewhere`. Results are cached 10 minutes. |
| `POST /api/v1/steam/status` `{profiles: [...], steamApiKey?}` | Steam online state of up to 50 profiles (links, SteamID64s or custom URL names): `offline`, `online`, `away` or `in-game` with `game` and `playingRust`. One Steam API call with a key, the public profile of each without. Cached for a minute. Works without a connected Rust server. |
| `POST /api/v1/trackers` | Create a tracker for the connected server. Body: `{ "name": "Neighbours" }` |
| `DELETE /api/v1/trackers/:id` | Delete a tracker. |
| `POST /api/v1/trackers/:id/players` | Add a player. Body: `{ "playerId": "<Battlemetrics id>" }` or `{ "steamId": "<SteamID64>" }`, or both (e.g. a Steam friend matched to a player on the server), or only `{ "name": "..." }` for a player only the server list knows. Every tracked player has a `server` field (online on the server list, seconds) next to the Battlemetrics status; players without a Battlemetrics id take their status from the server list. |
| `DELETE /api/v1/trackers/:id/players/:playerIdOrSteamId` | Remove a player. |

Tracker players coming online or going offline are pushed as notifications with `type: "tracker"`
(`kind`, `name`, `playerId`, `tracker`).

All positions come as world coordinates (`x`, `y`), grid (`grid`, e.g. `D8`) and normalized map image coordinates
(`nx`, `ny` from 0 to 1, origin top left), so they can be drawn directly on `map.jpg`.

### Notifications

```json
{ "id": 12, "guildId": "…", "type": "event", "time": 1760530000000,
  "category": "small", "setting": "heavyScientistCalledSetting", "text": "Heavy Scientists got called to Small Oil Rig at D8." }
```

| `type` | Extra fields |
| --- | --- |
| `event` | `category` (`cargo`, `heli`, `small`, `large`, `chinook`, `vendor` or `null`), `setting` (notification setting key), `color`, `image` |
| `alarm` | `name`, `entityId` (Smart Alarm) or `raidAlarm: true` (raid alarm plugin) |
| `connection` | `kind` (`online`, `offline`, `joined`, `left`), `steamId`, `name` |
| `death` | `steamId`, `name`, `location` |
| `chat` | `steamId`, `name` (team chat, without bot commands) |
| `tracker` | `kind` (`online`, `offline`), `name`, `playerId`, `tracker` (tracker name) |

### Example

```bash
curl -H "Authorization: Bearer $RPP_API_TOKEN" http://localhost:24343/api/v1/state
curl -N -H "Authorization: Bearer $RPP_API_TOKEN" http://localhost:24343/api/v1/stream
```
