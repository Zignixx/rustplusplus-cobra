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

const API_PREFIX = '/api/v1';
const STREAM_HEARTBEAT_MS = 20 * 1000;
const MIN_TOKEN_LENGTH = 16;

/* Read-only HTTP API for dashboards (e.g. the Corsair Xenon Edge widget).
 *
 *  GET /api/v1/health                 -> { ok: true }                            (no token needed)
 *  GET /api/v1/servers                -> rustplus instances the bot runs
 *  GET /api/v1/state?guild=ID         -> full state snapshot (see snapshot.js)
 *  GET /api/v1/events?guild=ID&limit= -> recent notifications, newest first
 *  GET /api/v1/map.jpg?guild=ID       -> map image of the connected server
 *  GET /api/v1/stream?guild=ID        -> Server-Sent Events: `state` after every poll, `notification` per event
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
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            return res.end();
        }

        const url = new URL(req.url, 'http://localhost');
        const path = url.pathname.replace(/\/+$/, '');

        if (req.method !== 'GET') return this.sendJson(res, 405, { error: 'Method not allowed' });
        if (path === `${API_PREFIX}/health`) return this.sendJson(res, 200, { ok: true });

        if (!this.isAuthorized(req, url)) {
            res.setHeader('WWW-Authenticate', 'Bearer');
            return this.sendJson(res, 401, { error: 'Invalid or missing token' });
        }

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
        return server;
    }
};
