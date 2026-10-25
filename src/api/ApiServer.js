/*
    Copyright (C) 2026 Cobra (Zignixx)

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.

    https://github.com/alexemanuelol/rustplusplus

*/

const Crypto = require('crypto');
const Http = require('http');

const ApiEvents = require('./apiEvents.js');
const Config = require('../../config');
const Snapshot = require('./snapshot.js');
const Trackers = require('./trackers.js');
const SteamFriends = require('./steamFriends.js');
const ServerQuery = require('./serverQuery.js');

const API_PREFIX = '/api/v1';
const STREAM_HEARTBEAT_MS = 20 * 1000;
const MIN_TOKEN_LENGTH = 16;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_STEAM_PROFILES = 50;

/* HTTP API for dashboards (e.g. the Corsair Xenon Edge widget).
 *
 *  GET /api/v1/health                 -> { ok: true }                            (no token needed)
 *  GET /api/v1/servers                -> rustplus instances the bot runs
 *  GET /api/v1/state?guild=ID         -> full state snapshot (see snapshot.js)
 *  GET /api/v1/events?guild=ID&limit= -> recent notifications, newest first
 *  GET /api/v1/map.jpg?guild=ID       -> map image of the connected server
 *  GET /api/v1/stream?guild=ID        -> Server-Sent Events: `state` after every poll, `notification` per event
 *
 *  Battlemetrics trackers (the same as the tracker messages in Discord, changes show up there too):
 *  GET    /api/v1/trackers                              -> trackers with every player's online status
 *  GET    /api/v1/battlemetrics/online?q=name           -> players online on the server right now
 *  POST   /api/v1/battlemetrics/steam-friends {profile, steamApiKey?, minScore?}
 *                                                       -> friends of a Steam profile that play on the server
 *  POST   /api/v1/trackers               {name}         -> create a tracker for the connected server
 *  DELETE /api/v1/trackers/:id
 *  POST   /api/v1/trackers/:id/players   {playerId} or {steamId} (or both)
 *  DELETE /api/v1/trackers/:id/players/:playerIdOrSteamId
 *
 *  GET    /api/v1/server/players?q=             -> the server's own player list (public query), with Battlemetrics matches
 *  POST   /api/v1/server/query-port   {port|null} -> set the server's query port if it isn't found automatically
 *  POST   /api/v1/steam/status       {profiles: [...], steamApiKey?} -> Steam online state (offline/online/away/in-game)
 *
 *  Authentication: `Authorization: Bearer <RPP_API_TOKEN>` (or `?token=` for clients that can't set headers).
 *  Without `guild`, the first connected instance is used.
 */

function tokenDigest(token) {
    return Crypto.createHash('sha256').update(String(token)).digest();
}

/* protobuf Long values and BigInts are not JSON serializable. */
function jsonReplacer(key, value) {
    if (typeof value === 'bigint') return value.toString();
    if (value && typeof value === 'object' && typeof value.low === 'number' && typeof value.high === 'number' &&
        typeof value.toString === 'function' && Object.keys(value).length <= 3) {
        return value.toString();
    }
    return value;
}

class ApiServer {
    constructor(client) {
        this.client = client;
        this.server = null;
        this.streams = new Set();
        /* Positions from the live poll per guild, dropped again when the bot's own poll is newer */
        this.live = new Object();
        this.liveRunning = false;
        this.tokenDigest = tokenDigest(Config.api.token);

        this.onEvent = this.onEvent.bind(this);
        this.onPoll = this.onPoll.bind(this);
    }

    start() {
        if (!Config.api.token) {
            this.client.log('API', 'HTTP API disabled (set RPP_API_TOKEN to enable it).');
            return false;
        }
        if (Config.api.token.length < MIN_TOKEN_LENGTH) {
            this.client.log('API', `RPP_API_TOKEN is shorter than ${MIN_TOKEN_LENGTH} characters, ` +
                'HTTP API disabled. Use a long random token.', 'error');
            return false;
        }

        this.server = Http.createServer((req, res) => {
            this.handle(req, res).catch(e => {
                this.client.log('API', `Request failed: ${e && e.stack ? e.stack : e}`, 'error');
                if (!res.headersSent) this.sendJson(res, 500, { error: 'Internal error' });
                else res.end();
            });
        });
        this.server.on('error', e => {
            this.client.log('API', `HTTP API could not start on port ${Config.api.port}: ${e.message}`, 'error');
        });
        this.server.listen(Config.api.port, Config.api.host, () => {
            this.client.log('API', `HTTP API listening on ${Config.api.host}:${Config.api.port}`);
        });

        ApiEvents.on('event', this.onEvent);
        ApiEvents.on('poll', this.onPoll);
        this.heartbeat = setInterval(() => {
            for (const stream of this.streams) stream.res.write(': ping\n\n');
        }, STREAM_HEARTBEAT_MS);
        return true;
    }

    /* Routing */

    async handle(req, res) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            return res.end();
        }

        const url = new URL(req.url, 'http://localhost');
        const path = url.pathname.replace(/\/+$/, '');

        if (!['GET', 'POST', 'DELETE'].includes(req.method)) return this.sendJson(res, 405, { error: 'Method not allowed' });
        if (path === `${API_PREFIX}/health`) return this.sendJson(res, 200, { ok: true });

        if (!this.isAuthorized(req, url)) {
            res.setHeader('WWW-Authenticate', 'Bearer');
            return this.sendJson(res, 401, { error: 'Invalid or missing token' });
        }

        if (path === `${API_PREFIX}/steam/status` && req.method === 'POST') {
            return this.handleSteamStatus(req, res);
        }
        if (path === `${API_PREFIX}/trackers` || path.startsWith(`${API_PREFIX}/trackers/`) ||
            path === `${API_PREFIX}/battlemetrics/online` || path === `${API_PREFIX}/battlemetrics/steam-friends` ||
            path === `${API_PREFIX}/server/players` || path === `${API_PREFIX}/server/query-port`) {
            return this.handleTrackers(req, res, url, path);
        }
        if (req.method !== 'GET') return this.sendJson(res, 405, { error: 'Method not allowed' });

        switch (path) {
            case `${API_PREFIX}/servers`: return this.handleServers(res);
            case `${API_PREFIX}/state`: return this.handleState(res, url);
            case `${API_PREFIX}/events`: return this.handleEvents(res, url);
            case `${API_PREFIX}/map.jpg`: return this.handleMap(req, res, url);
            case `${API_PREFIX}/stream`: return this.handleStream(req, res, url);
            default: return this.sendJson(res, 404, { error: 'Not found' });
        }
    }

    isAuthorized(req, url) {
        let token = null;
        const header = req.headers['authorization'];
        if (typeof header === 'string' && /^Bearer\s+/i.test(header)) {
            token = header.replace(/^Bearer\s+/i, '').trim();
        }
        else if (url.searchParams.has('token')) {
            token = url.searchParams.get('token');
        }
        if (!token) return false;

        return Crypto.timingSafeEqual(tokenDigest(token), this.tokenDigest);
    }

    /* Instances */

    getRustplus(guildId) {
        const instances = this.client.rustplusInstances;
        if (guildId) return instances[guildId] || null;

        const all = Object.values(instances).filter(rustplus => rustplus && !rustplus.isDeleted);
        return all.find(rustplus => rustplus.isOperational) || all[0] || null;
    }

    /* Handlers */

    handleServers(res) {
        const servers = [];
        for (const [guildId, rustplus] of Object.entries(this.client.rustplusInstances)) {
            if (!rustplus || rustplus.isDeleted) continue;
            const instance = this.client.getInstance(guildId);
            const server = instance && instance.serverList ? instance.serverList[rustplus.serverId] : null;
            servers.push({
                guildId: guildId,
                serverId: rustplus.serverId,
                title: server ? server.title : null,
                connected: rustplus.isOperational === true
            });
        }
        return this.sendJson(res, 200, { servers: servers });
    }

    handleState(res, url) {
        const rustplus = this.getRustplus(url.searchParams.get('guild'));
        if (!rustplus) return this.sendJson(res, 404, { error: 'No Rust server connected' });
        return this.sendJson(res, 200, Snapshot.build(this.client, rustplus, this.live[rustplus.guildId] || null));
    }

    handleEvents(res, url) {
        const rustplus = this.getRustplus(url.searchParams.get('guild'));
        if (!rustplus) return this.sendJson(res, 200, { events: [] });

        const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit')) || 50, 1), 100);
        return this.sendJson(res, 200, { events: ApiEvents.getRecent(rustplus.guildId, limit) });
    }

    handleMap(req, res, url) {
        const rustplus = this.getRustplus(url.searchParams.get('guild'));
        const image = rustplus ? this.client.rustplusMaps[rustplus.guildId] : null;
        if (!rustplus || !image) return this.sendJson(res, 404, { error: 'No map available' });

        const buffer = Buffer.from(image);
        const etag = `"${Crypto.createHash('sha1').update(buffer).digest('hex')}"`;
        if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, { 'ETag': etag });
            return res.end();
        }
        res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Content-Length': buffer.length,
            'Cache-Control': 'private, max-age=60',
            'ETag': etag
        });
        return res.end(buffer);
    }

    /* Steam online state of a watch list; works without a Rust server. POST, so the API key stays out of urls. */
    async handleSteamStatus(req, res) {
        const body = await this.readJson(req);
        const profiles = Array.isArray(body.profiles) ? body.profiles.slice(0, MAX_STEAM_PROFILES) : [];
        if (profiles.length === 0) return this.sendJson(res, 400, { error: 'profiles (array) required' });
        const result = await SteamFriends.getStatuses(profiles, body.steamApiKey || null);
        if (result.error === 'badKey') return this.sendJson(res, 400, { error: 'Steam rejected the API key' });
        return this.sendJson(res, 200, result);
    }

    async handleTrackers(req, res, url, path) {
        const rustplus = this.getRustplus(url.searchParams.get('guild'));
        const guildId = url.searchParams.get('guild') || (rustplus ? rustplus.guildId : null);
        if (!guildId || !this.client.getInstance(guildId)) return this.sendJson(res, 404, { error: 'No Rust server connected' });

        const parts = path.slice(API_PREFIX.length + 1).split('/').map(decodeURIComponent); /* e.g. trackers/12/players/34 */
        try {
            let result = null;
            let changed = false;
            if (parts[0] === 'server' && parts[1] === 'players' && req.method === 'GET') {
                const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit')) || 500, 1), 1000);
                result = Trackers.serverPlayers(this.client, guildId, rustplus, url.searchParams.get('q'), limit);
            }
            else if (parts[0] === 'server' && parts[1] === 'query-port' && req.method === 'POST') {
                const body = await this.readJson(req);
                const port = body.port === null || body.port === '' || body.port === undefined ? null : parseInt(body.port);
                if (port !== null && !(port > 0 && port < 65536)) return this.sendJson(res, 400, { error: 'port must be 1..65535 or null' });
                await ServerQuery.setQueryPort(guildId, port);
                result = Trackers.serverPlayers(this.client, guildId, rustplus, null, 1);
                changed = true;
            }
            else if (parts[0] === 'battlemetrics' && parts[1] === 'steam-friends' && req.method === 'POST') {
                /* POST, so the Steam API key travels in the body and not in urls or logs */
                result = await Trackers.steamFriendsOnServer(this.client, guildId, rustplus, await this.readJson(req));
            }
            else if (parts[0] === 'battlemetrics' && parts[1] === 'online' && req.method === 'GET') {
                const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit')) || 100, 1), 500);
                result = Trackers.searchOnline(this.client, guildId, rustplus, url.searchParams.get('q'), limit);
            }
            else if (parts.length === 1 && req.method === 'GET') {
                result = Trackers.build(this.client, guildId, rustplus);
            }
            else if (parts.length === 1 && req.method === 'POST') {
                const body = await this.readJson(req);
                result = await Trackers.createTracker(this.client, guildId, rustplus, body.name);
                changed = true;
            }
            else if (parts.length === 2 && req.method === 'DELETE') {
                await Trackers.deleteTracker(this.client, guildId, parts[1]);
                result = { ok: true };
                changed = true;
            }
            else if (parts.length === 3 && parts[2] === 'players' && req.method === 'POST') {
                const body = await this.readJson(req);
                result = await Trackers.addPlayer(this.client, guildId, parts[1], body, rustplus);
                changed = true;
            }
            else if (parts.length === 4 && parts[2] === 'players' && req.method === 'DELETE') {
                result = await Trackers.removePlayer(this.client, guildId, parts[1], parts[3], rustplus);
                changed = true;
            }
            else {
                return this.sendJson(res, 404, { error: 'Not found' });
            }

            if (changed) {
                this.client.log('API', `Tracker change via API: ${req.method} ${path}`);
                this.pushState(guildId);
            }
            return this.sendJson(res, 200, result);
        }
        catch (e) {
            if (e instanceof Trackers.ApiError) return this.sendJson(res, e.status, { error: e.message });
            throw e;
        }
    }

    readJson(req) {
        return new Promise((resolve, reject) => {
            let size = 0;
            const chunks = [];
            req.on('data', chunk => {
                size += chunk.length;
                if (size > MAX_BODY_BYTES) {
                    reject(new Trackers.ApiError(413, 'Body too large'));
                    req.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            req.on('end', () => {
                if (chunks.length === 0) return resolve({});
                try {
                    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    resolve(body && typeof body === 'object' ? body : {});
                }
                catch (e) {
                    reject(new Trackers.ApiError(400, 'Invalid JSON body'));
                }
            });
            req.on('error', reject);
        });
    }

    handleStream(req, res, url) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
        res.write('retry: 5000\n\n');

        const stream = { res: res, guildId: url.searchParams.get('guild') || null };
        this.streams.add(stream);
        req.on('close', () => this.streams.delete(stream));

        /* Start with a full state, so a client never has to wait for the next poll. */
        const rustplus = this.getRustplus(stream.guildId);
        if (rustplus) {
            this.writeStream(stream, 'state', Snapshot.build(this.client, rustplus, this.live[rustplus.guildId] || null));
        }
        this.startLivePoll();
    }

    /* Stream pushes */

    streamGuildId(stream) {
        if (stream.guildId) return stream.guildId;
        const rustplus = this.getRustplus(null);
        return rustplus ? rustplus.guildId : null;
    }

    /* Live poll: while a dashboard is connected, fetch only map markers and team positions every
       RPP_API_LIVE_INTERVAL ms (2 tokens), so positions update faster than the bot's 10 s poll. It never
       overlaps itself and leaves event detection to the bot's own poll. */
    startLivePoll() {
        if (this.liveRunning || !Config.api.liveIntervalMs) return;
        this.liveRunning = true;

        const tick = async () => {
            if (this.streams.size === 0) {
                this.liveRunning = false;
                return;
            }
            try {
                await this.livePoll();
            }
            catch (e) {
                this.client.log('API', `Live poll failed: ${e && e.message ? e.message : e}`, 'error');
            }
            setTimeout(tick, Config.api.liveIntervalMs);
        };
        setTimeout(tick, Config.api.liveIntervalMs);
    }

    async livePoll() {
        const guildIds = new Set();
        for (const stream of this.streams) {
            const guildId = this.streamGuildId(stream);
            if (guildId) guildIds.add(guildId);
        }

        for (const guildId of guildIds) {
            const rustplus = this.client.rustplusInstances[guildId];
            if (!rustplus || !rustplus.isOperational || rustplus.isFirstPoll || !rustplus.mapMarkers) continue;

            const markers = await rustplus.getMapMarkersAsync(5000);
            const team = await rustplus.getTeamInfoAsync(5000);
            const markerList = markers && markers.mapMarkers ? markers.mapMarkers.markers : null;
            const members = team && team.teamInfo ? team.teamInfo.members : null;
            if (!Array.isArray(markerList) || !Array.isArray(members)) continue;

            const live = { at: Date.now(), players: new Map(), markers: new Map() };
            for (const m of markerList) {
                live.markers.set(`${m.id}`, { x: m.x, y: m.y, rotation: m.rotation });
            }
            for (const m of members) {
                live.players.set(m.steamId.toString(), { x: m.x, y: m.y, isOnline: m.isOnline, isAlive: m.isAlive });
            }
            this.live[guildId] = live;
            this.pushState(guildId);
        }
    }

    onPoll(guildId) {
        /* The bot's own poll is newer than any live data */
        delete this.live[guildId];
        this.pushState(guildId);
    }

    pushState(guildId) {
        if (this.streams.size === 0) return;

        const rustplus = this.client.rustplusInstances[guildId];
        if (!rustplus) return;

        let state = null;
        for (const stream of this.streams) {
            if (this.streamGuildId(stream) !== guildId) continue;
            if (state === null) state = Snapshot.build(this.client, rustplus, this.live[guildId] || null);
            this.writeStream(stream, 'state', state);
        }
    }

    onEvent(event) {
        for (const stream of this.streams) {
            if (this.streamGuildId(stream) !== event.guildId) continue;
            this.writeStream(stream, 'notification', event);
        }
    }

    writeStream(stream, name, data) {
        try {
            stream.res.write(`event: ${name}\ndata: ${JSON.stringify(data, jsonReplacer)}\n\n`);
        }
        catch (e) {
            this.streams.delete(stream);
        }
    }

    sendJson(res, status, data) {
        const body = JSON.stringify(data, jsonReplacer);
        res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
        });
        res.end(body);
    }
}

module.exports = {
    start: function (client) {
        const server = new ApiServer(client);
        server.start();
        if (Config.api.token) ServerQuery.start(client);
        return server;
    }
};
