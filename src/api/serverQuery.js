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

const A2S = require('./a2s.js');
const ApiEvents = require('./apiEvents.js');
const Config = require('../../config');
const SteamFriends = require('./steamFriends.js');

/* Rust's default Rust+ app port is the game port + 67; the query port is the game port or a port next to it. */
const APP_PORT_OFFSET = 67;
const QUERY_TIMEOUT_MS = 2500;
const MAX_LAST_SEEN = 5000;
/* Names this alike count as the same player (same name ignoring case, spacing and clan tags) */
const SAME_NAME = 0.97;

/**
 *  The server's own player list, read with the public Valve server query (no password, no Battlemetrics) every
 *  RPP_SERVER_QUERY_INTERVAL ms. It only holds in-game names and how long each player is connected; tracked
 *  players without a Battlemetrics id get their online status (and join/leave events) from it.
 */
class ServerQuery {
    constructor() {
        this.client = null;
        this.state = new Object();
        this.timer = null;
    }

    start(client) {
        this.client = client;
        if (!Config.api.serverQueryIntervalMs || this.timer) return;
        const tick = async () => {
            for (const guildId of Object.keys(client.rustplusInstances || {})) {
                try { await this.poll(guildId); }
                catch (e) { client.log('API', `Server query failed: ${e && e.message ? e.message : e}`, 'error'); }
            }
        };
        setTimeout(tick, 5000);
        this.timer = setInterval(tick, Config.api.serverQueryIntervalMs);
    }

    /* Where to ask: a port set in the dashboard, the query port Battlemetrics knows, then the usual ones */
    candidates(guildId, rustplus) {
        const instance = this.client.getInstance(guildId);
        const server = instance && instance.serverList ? instance.serverList[rustplus.serverId] : null;
        if (!server) return [];
        const list = [];
        const add = (host, port) => {
            port = parseInt(port);
            if (host && port > 0 && port < 65536 && !list.some(c => c.host === host && c.port === port)) list.push({ host, port });
        };
        if (server.queryPort) add(server.serverIp, server.queryPort);
        const bm = server.battlemetricsId ? this.client.battlemetricsInstances[server.battlemetricsId] : null;
        if (bm && bm.server_portQuery) {
            add(server.serverIp, bm.server_portQuery);
            if (bm.server_ip) add(bm.server_ip, bm.server_portQuery);
        }
        const appPort = parseInt(server.appPort);
        if (appPort > APP_PORT_OFFSET) {
            const game = appPort - APP_PORT_OFFSET;
            add(server.serverIp, game);
            add(server.serverIp, game + 2);
            add(server.serverIp, game + 1);
        }
        add(server.serverIp, 28015);
        add(server.serverIp, 28017);
        return list;
    }

    async poll(guildId) {
        const rustplus = this.client.rustplusInstances[guildId];
        if (!rustplus || !rustplus.serverId) return;

        let st = this.state[guildId];
        if (!st || st.serverId !== rustplus.serverId) {
            st = this.state[guildId] = {
                serverId: rustplus.serverId, host: null, port: null, players: null, queriedAt: null, error: null,
                lastSeen: new Map(), failures: 0
            };
        }

        const candidates = this.candidates(guildId, rustplus);
        /* The address that answered last time first; the others only while none answers */
        const order = st.port ? [{ host: st.host, port: st.port }, ...candidates.filter(c => c.host !== st.host || c.port !== st.port)] : candidates;
        let players = null, used = null, lastError = null;
        for (const c of (st.port && st.failures < 3 ? order.slice(0, 1) : order)) {
            try {
                players = await A2S.queryPlayers(c.host, c.port, QUERY_TIMEOUT_MS);
                used = c;
                break;
            }
            catch (e) {
                lastError = e;
            }
        }

        const now = Date.now();
        if (!players) {
            st.failures += 1;
            st.error = candidates.length === 0 ? 'No server address' :
                `The server does not answer the player query (${lastError ? lastError.message : 'no answer'}). Set its query port in the dashboard.`;
            return;
        }

        const previous = st.players;
        st.host = used.host;
        st.port = used.port;
        st.failures = 0;
        st.error = null;
        st.players = players;
        st.prepared = players.map(p => SteamFriends.prepareName(p.name));
        st.queriedAt = now;

        /* Remember when a name left, for "offline since" */
        const present = new Set(players.map(p => SteamFriends.normName(p.name)));
        if (previous) {
            for (const p of previous) {
                const n = SteamFriends.normName(p.name);
                if (!present.has(n)) st.lastSeen.set(n, now);
            }
        }
        for (const n of present) st.lastSeen.delete(n);
        if (st.lastSeen.size > MAX_LAST_SEEN) st.lastSeen.clear();

        if (previous) this.announce(guildId, rustplus, previous, players);
    }

    /* Join and leave events for tracked players that only the server list can see (no Battlemetrics id) */
    announce(guildId, rustplus, before, after) {
        const instance = this.client.getInstance(guildId);
        const prepare = list => list.map(p => SteamFriends.prepareName(p.name));
        const was = prepare(before), is = prepare(after);
        const seen = (prepared, list) => list.some(x => SteamFriends.similarityOf(prepared, x, SAME_NAME) > 0);
        for (const tracker of Object.values(instance.trackers || {})) {
            if (tracker.serverId !== rustplus.serverId) continue;
            for (const player of tracker.players) {
                if (player.playerId) continue;
                const prepared = SteamFriends.prepareName(player.name);
                const wasOn = seen(prepared, was), isOn = seen(prepared, is);
                if (wasOn === isOn) continue;
                const text = isOn ? `${player.name} just connected (${tracker.name}).` : `${player.name} just disconnected (${tracker.name}).`;
                ApiEvents.publish(guildId, 'tracker', {
                    kind: isOn ? 'online' : 'offline', name: player.name, steamId: player.steamId, tracker: tracker.name, text: text, source: 'server'
                });
            }
        }
    }

    get(guildId, serverId = null) {
        const st = this.state[guildId];
        if (!st || (serverId && st.serverId !== serverId)) return null;
        return st;
    }

    /**
     *  The online entry for a player by any of their names, or null. Same name means at least 97 % alike
     *  (case, spacing and clan tags ignored).
     */
    find(st, names) {
        if (!st || !st.players) return null;
        const prepared = names.filter(n => n).map(n => SteamFriends.prepareName(n));
        let best = null, bestScore = 0;
        st.players.forEach((p, i) => {
            for (const n of prepared) {
                const score = SteamFriends.similarityOf(n, st.prepared[i], SAME_NAME);
                if (score > bestScore) { best = p; bestScore = score; }
            }
        });
        return best;
    }

    lastSeen(st, names) {
        if (!st) return null;
        let latest = null;
        for (const n of names.filter(x => x)) {
            const t = st.lastSeen.get(SteamFriends.normName(n));
            if (t && (!latest || t > latest)) latest = t;
        }
        return latest;
    }

    /** Remembers a query port set in the dashboard (null = find it again) and asks right away */
    async setQueryPort(guildId, port) {
        const rustplus = this.client.rustplusInstances[guildId];
        if (!rustplus) return null;
        const instance = this.client.getInstance(guildId);
        const server = instance.serverList[rustplus.serverId];
        if (!server) return null;
        server.queryPort = port ? parseInt(port) : null;
        this.client.setInstance(guildId, instance);
        delete this.state[guildId];
        await this.poll(guildId);
        return this.get(guildId);
    }
}

module.exports = new ServerQuery();
