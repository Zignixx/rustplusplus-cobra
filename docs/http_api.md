# HTTP API

rustplusplus can serve a small **read-only** HTTP API, for example for a dashboard on a second screen
(the Corsair Xenon Edge dashboard has a widget for it). It is disabled until a token is set.

| Variable | Default | Description |
| --- | --- | --- |
| `RPP_API_TOKEN` | *(empty, API disabled)* | Secret token, at least 16 characters. Generate one with `openssl rand -hex 32`. |
| `RPP_API_PORT` | `24343` | Port of the HTTP server. |
| `RPP_API_HOST` | `0.0.0.0` | Interface to listen on. |
| `RPP_API_LIVE_INTERVAL` | `2000` | While a dashboard is connected to `/stream`, team and map marker positions are fetched this often (ms, min 1000, 2 Rust+ tokens each). `0` turns it off; positions then update with `RPP_POLLING_INTERVAL`. |

With Docker, publish the port (`-p 24343:24343` or `ports:` in `docker-compose.yml`). The API speaks plain HTTP:
only expose it in your LAN or put it behind a reverse proxy with TLS.

## Authentication

Every endpoint except `/api/v1/health` needs the token, either as header `Authorization: Bearer <token>` or as
query parameter `?token=<token>`.

## Endpoints

All endpoints accept an optional `?guild=<discord guild id>`. Without it, the first connected Rust server is used.

| Endpoint | Description |
| --- | --- |
| `GET /api/v1/health` | `{ "ok": true }`, no token needed. |
| `GET /api/v1/servers` | Rust servers the bot is connected to, one per Discord guild. |
| `GET /api/v1/state` | Full state: server info, in-game time, team, map markers, oil rigs, smart devices, timers. |
| `GET /api/v1/events?limit=50` | Last notifications (newest first, max 100). |
| `GET /api/v1/map.jpg` | Map image of the server. Supports `If-None-Match`. |
| `GET /api/v1/stream` | [Server-Sent Events](https://developer.mozilla.org/docs/Web/API/Server-sent_events): `state` after every poll of the bot and every live position update (default every 2 s), `notification` for every new event. |

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

### Example

```bash
curl -H "Authorization: Bearer $RPP_API_TOKEN" http://localhost:24343/api/v1/state
curl -N -H "Authorization: Bearer $RPP_API_TOKEN" http://localhost:24343/api/v1/stream
```
