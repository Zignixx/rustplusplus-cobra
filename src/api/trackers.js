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

const Config = require('../../config');
const Constants = require('../util/constants.js');
const DiscordMessages = require('../discordTools/discordMessages.js');
const DiscordTools = require('../discordTools/discordTools.js');
const Scrape = require('../util/scrape.js');
const SteamFriends = require('./steamFriends.js');
const ServerQuery = require('./serverQuery.js');

/* Battlemetrics trackers for the HTTP API: the same data and actions as the tracker messages and buttons in
   Discord. Every change goes through the instance file and refreshes the tracker message in Discord. */

class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function bmEnabled() {
    return Config.battlemetrics.token !== '';
}

function secondsOf(timeResult) {
    return Array.isArray(timeResult) ? timeResult[0] : null;
}

/** Battlemetrics instance of the server the bot is connected to (or of a given Battlemetrics id). */
function getBm(client, guildId, rustplus, battlemetricsId = null) {
    let bmId = battlemetricsId;
    if (!bmId && rustplus) {
        const instance = client.getInstance(guildId);
        const server = instance && instance.serverList ? instance.serverList[rustplus.serverId] : null;
        bmId = server ? server.battlemetricsId : null;
    }
    if (!bmId) return { bmId: null, bm: null };
    return { bmId: bmId, bm: client.battlemetricsInstances[bmId] || null };
}

function playerStatus(bm, playerId) {
    if (!bm || !bm.lastUpdateSuccessful || !playerId || !bm.players.hasOwnProperty(playerId)) {
        return { status: 'unknown', seconds: null, bmName: null };
    }
    const player = bm.players[playerId];
    const online = player.status === true;
    return {
        status: online ? 'online' : 'offline',
        /* Online: seconds online in this session; offline: seconds since logout (null if never seen leaving) */
        seconds: secondsOf(online ? bm.getOnlineTime(playerId) : bm.getOfflineTime(playerId)),
        bmName: player.name || null
    };
}

/* Online status from the server's own player list, by tracked name or Battlemetrics name */
function serverStatus(query, names) {
    if (!query || !query.players) return null;
    const hit = ServerQuery.find(query, names);
    if (hit) return { online: true, name: hit.name, seconds: hit.seconds, lastSeen: null };
    const last = ServerQuery.lastSeen(query, names);
    return { online: false, name: null, seconds: last ? Math.round((Date.now() - last) / 1000) : null, lastSeen: last };
}

function serializeTracker(client, trackerId, tracker, currentServerId = null, guildId = null) {
    const bm = client.battlemetricsInstances[tracker.battlemetricsId] || null;
    const current = currentServerId !== null && tracker.serverId === currentServerId;
    const query = current && guildId ? ServerQuery.get(guildId, currentServerId) : null;
    const players = tracker.players.map(p => {
        const bmStatus = playerStatus(bm, p.playerId);
        const server = serverStatus(query, [p.name, bmStatus.bmName]);
        const entry = Object.assign({
            name: p.name,
            steamId: p.steamId,
            playerId: p.playerId,
            steamUrl: p.steamId ? `${Constants.STEAM_PROFILES_URL}${p.steamId}` : null,
            battlemetricsUrl: p.playerId ? `${Constants.BATTLEMETRICS_PROFILE_URL}${p.playerId}` : null,
            server: server
        }, bmStatus);
        /* Players only the server list knows (no Battlemetrics id): their status comes from there */
        if (!p.playerId && server) {
            entry.status = server.online ? 'online' : (server.lastSeen ? 'offline' : 'unknown');
            entry.seconds = server.seconds;
        }
        return entry;
    });

    return {
        id: `${trackerId}`,
        name: tracker.name,
        serverId: tracker.serverId,
        title: tracker.title,
        battlemetricsId: tracker.battlemetricsId,
        /* Trackers keep the Battlemetrics data of the server they were made for (e.g. an older wipe) */
        current: current,
        clanTag: tracker.clanTag,
        online: players.filter(p => p.status === 'online').length,
        players: players
    };
}

/* Which trackers already contain a player, by Battlemetrics id and by SteamID */
function trackedIndex(instance) {
    const byPlayer = new Object(), bySteam = new Object();
    for (const [trackerId, tracker] of Object.entries(instance.trackers || {})) {
        for (const p of tracker.players) {
            if (p.playerId) (byPlayer[p.playerId] = byPlayer[p.playerId] || []).push(`${trackerId}`);
            if (p.steamId) (bySteam[p.steamId] = bySteam[p.steamId] || []).push(`${trackerId}`);
        }
    }
    return { byPlayer: byPlayer, bySteam: bySteam };
}

function onlinePlayer(bm, p, trackedBy) {
    return {
        playerId: `${p.id}`,
        name: p.name,
        onlineSeconds: secondsOf(bm.getOnlineTime(p.id)),
        firstTime: p.firstTime === true,
        battlemetricsUrl: `${Constants.BATTLEMETRICS_PROFILE_URL}${p.id}`,
        trackedBy: trackedBy[p.id] || []
    };
}

function currentBmOrThrow(client, guildId, rustplus) {
    if (!bmEnabled()) throw new ApiError(409, 'Battlemetrics is disabled (no RPP_BATTLEMETRICS_TOKEN)');
    const { bmId, bm } = getBm(client, guildId, rustplus);
    if (!bmId) throw new ApiError(409, 'The server has no Battlemetrics id');
    if (!bm || !bm.lastUpdateSuccessful) throw new ApiError(503, 'Battlemetrics data is not available yet');
    return { bmId, bm };
}

const STEAM_ERRORS = {
    invalid: [400, 'Not a Steam profile link, SteamID64 or custom URL name'],
    notFound: [404, 'Steam profile not found'],
    badKey: [400, 'Steam rejected the API key'],
    unreachable: [502, 'Steam could not be reached, try again in a moment']
};

module.exports = {
    ApiError: ApiError,

    /** Trackers and Battlemetrics status, also part of the state snapshot */
    build: function (client, guildId, rustplus) {
        const instance = client.getInstance(guildId);
        const { bmId, bm } = getBm(client, guildId, rustplus);

        return {
            enabled: bmEnabled(),
            battlemetrics: {
                id: bmId,
                available: !!(bm && bm.lastUpdateSuccessful),
                updatedAt: bm ? bm.updatedAt : null,
                streamerMode: bm ? bm.streamerMode : null,
                onlinePlayers: bm && bm.lastUpdateSuccessful ? bm.onlinePlayers.length : null
            },
            currentServerId: rustplus ? rustplus.serverId : null,
            trackers: Object.entries(instance && instance.trackers ? instance.trackers : {})
                .map(([id, tracker]) => serializeTracker(client, id, tracker, rustplus ? rustplus.serverId : null, guildId))
                .sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0))
        };
    },

    /** Players currently online on the server according to Battlemetrics, optionally filtered by name */
    searchOnline: function (client, guildId, rustplus, query, limit = 100) {
        const { bmId, bm } = currentBmOrThrow(client, guildId, rustplus);
        const trackedBy = trackedIndex(client.getInstance(guildId)).byPlayer;

        const q = (query || '').trim().toLowerCase();
        const players = bm.getOnlinePlayerIdsOrderedByTime()
            .map(id => bm.players[id])
            .filter(p => p && (!q || `${p.name}`.toLowerCase().includes(q) || `${p.id}` === q))
            .slice(0, limit)
            .map(p => onlinePlayer(bm, p, trackedBy));

        return {
            battlemetricsId: bmId,
            updatedAt: bm.updatedAt,
            streamerMode: bm.streamerMode,
            total: bm.onlinePlayers.length,
            players: players
        };
    },

    /**
     *  Friends of a Steam profile that are on the server right now. Battlemetrics only knows in-game names, so
     *  friends are matched by name: every online player whose name is at least `minScore` alike (0.5..1) is a
     *  candidate, best first. Friends that Steam shows playing Rust without a match are listed separately.
     */
    steamFriendsOnServer: async function (client, guildId, rustplus, body) {
        const { bmId, bm } = currentBmOrThrow(client, guildId, rustplus);
        const minScore = Math.min(Math.max(Number(body.minScore) || 0.8, 0.5), 1);

        const data = await SteamFriends.getFriends(body.profile, body.steamApiKey || null);
        if (data.error) throw new ApiError(...STEAM_ERRORS[data.error]);

        const tracked = trackedIndex(client.getInstance(guildId));
        const online = bm.getOnlinePlayerIdsOrderedByTime().map(id => bm.players[id]).filter(p => p)
            .map(p => ({ p: p, prepared: SteamFriends.prepareName(p.name) }));

        const onServer = [], playingRustElsewhere = [];
        for (let i = 0; i < data.friends.length; i++) {
            /* Large friend lists take a moment; let the bot breathe in between */
            if (i > 0 && i % 100 === 0) await new Promise(resolve => setImmediate(resolve));
            const friend = data.friends[i];
            const prepared = SteamFriends.prepareName(friend.name);
            const candidates = [];
            for (const o of online) {
                const score = SteamFriends.similarityOf(prepared, o.prepared, minScore);
                if (score > 0) candidates.push(Object.assign({ score: Math.round(score * 100) / 100 }, onlinePlayer(bm, o.p, tracked.byPlayer)));
            }
            const entry = Object.assign({}, friend, {
                playingRust: friend.game === SteamFriends.RUST_GAME_NAME,
                profileUrl: `${Constants.STEAM_PROFILES_URL}${friend.steamId}`,
                trackedBy: tracked.bySteam[friend.steamId] || []
            });
            if (candidates.length > 0) {
                candidates.sort((a, b) => b.score - a.score);
                onServer.push(Object.assign(entry, { candidates: candidates.slice(0, 8) }));
            }
            else if (entry.playingRust) {
                playingRustElsewhere.push(entry);
            }
        }
        /* Best matches first; among equal ones the unambiguous, then those Steam shows playing Rust */
        onServer.sort((a, b) => b.candidates[0].score - a.candidates[0].score || a.candidates.length - b.candidates.length ||
            (b.playingRust ? 1 : 0) - (a.playingRust ? 1 : 0));

        return {
            profile: data.profile,
            source: data.source,
            private: data.private,
            friendCount: data.friends.length,
            fetchedAt: data.fetchedAt,
            battlemetricsId: bmId,
            streamerMode: bm.streamerMode,
            onlineCount: online.length,
            minScore: minScore,
            onServer: onServer,
            playingRustElsewhere: playingRustElsewhere
        };
    },

    /**
     *  The server's own player list (public server query), each player cross-checked with Battlemetrics: the
     *  online Battlemetrics player with the same name (at least 97 % alike) and the trackers they are in.
     */
    serverPlayers: function (client, guildId, rustplus, query, limit = 500) {
        if (!rustplus) throw new ApiError(409, 'No Rust server connected');
        const st = ServerQuery.get(guildId, rustplus.serverId);
        const { bmId, bm } = getBm(client, guildId, rustplus);
        const bmOk = bmEnabled() && bm && bm.lastUpdateSuccessful;
        const instance = client.getInstance(guildId);
        const tracked = trackedIndex(instance);
        const byName = new Object();
        for (const [trackerId, tracker] of Object.entries(instance.trackers || {})) {
            if (tracker.serverId !== rustplus.serverId) continue;
            for (const p of tracker.players) {
                const n = SteamFriends.normName(p.name);
                (byName[n] = byName[n] || []).push(`${trackerId}`);
            }
        }

        const bmOnline = bmOk ? bm.getOnlinePlayerIdsOrderedByTime().map(id => bm.players[id]).filter(p => p)
            .map(p => ({ p: p, prepared: SteamFriends.prepareName(p.name) })) : [];
        const q = (query || '').trim().toLowerCase();
        const list = (st && st.players ? st.players : [])
            .filter(p => !q || `${p.name}`.toLowerCase().includes(q))
            .sort((a, b) => a.seconds - b.seconds)
            .slice(0, limit)
            .map(p => {
                const prepared = SteamFriends.prepareName(p.name);
                let best = null, bestScore = 0;
                for (const o of bmOnline) {
                    const score = SteamFriends.similarityOf(prepared, o.prepared, 0.97);
                    if (score > bestScore) { best = o.p; bestScore = score; }
                }
                const trackers = new Set(byName[SteamFriends.normName(p.name)] || []);
                if (best) for (const t of tracked.byPlayer[best.id] || []) trackers.add(t);
                return {
                    name: p.name,
                    seconds: p.seconds,
                    score: p.score,
                    battlemetrics: best ? onlinePlayer(bm, best, tracked.byPlayer) : null,
                    trackedBy: [...trackers]
                };
            });

        return {
            available: !!(st && st.players),
            error: st ? st.error : (Config.api.serverQueryIntervalMs ? 'The first server query is still running' : 'The server query is turned off (RPP_SERVER_QUERY_INTERVAL=0)'),
            host: st ? st.host : null,
            port: st ? st.port : null,
            queriedAt: st ? st.queriedAt : null,
            total: st && st.players ? st.players.length : 0,
            battlemetrics: { id: bmId, available: !!bmOk, onlinePlayers: bmOk ? bm.onlinePlayers.length : null },
            players: list
        };
    },

    createTracker: async function (client, guildId, rustplus, name) {
        if (!bmEnabled()) throw new ApiError(409, 'Battlemetrics is disabled (no RPP_BATTLEMETRICS_TOKEN)');
        if (!rustplus) throw new ApiError(409, 'No Rust server connected');
        const instance = client.getInstance(guildId);
        const server = instance.serverList[rustplus.serverId];
        if (!server || !server.battlemetricsId) throw new ApiError(409, 'The server has no Battlemetrics id');

        const trackerId = client.findAvailableTrackerId(guildId);
        instance.trackers[trackerId] = {
            name: `${name || 'Tracker'}`.trim().slice(0, 50) || 'Tracker',
            serverId: rustplus.serverId,
            battlemetricsId: server.battlemetricsId,
            title: server.title,
            img: server.img,
            clanTag: '',
            everyone: false,
            inGame: true,
            players: [],
            messageId: null
        };
        client.setInstance(guildId, instance);
        await DiscordMessages.sendTrackerMessage(guildId, trackerId);
        return serializeTracker(client, trackerId, client.getInstance(guildId).trackers[trackerId], rustplus.serverId, guildId);
    },

    deleteTracker: async function (client, guildId, trackerId) {
        const instance = client.getInstance(guildId);
        const tracker = instance.trackers[trackerId];
        if (!tracker) throw new ApiError(404, 'Tracker not found');

        await DiscordTools.deleteMessageById(guildId, instance.channelId.trackers, tracker.messageId);
        delete instance.trackers[trackerId];
        client.setInstance(guildId, instance);
    },

    /** Same rules as the "Add player" modal: a SteamID64 or a Battlemetrics player id */
    addPlayer: async function (client, guildId, trackerId, body, rustplus = null) {
        const instance = client.getInstance(guildId);
        const tracker = instance.trackers[trackerId];
        if (!tracker) throw new ApiError(404, 'Tracker not found');

        /* Only a name (a player from the server's own list that Battlemetrics doesn't know) */
        if (!body.steamId && !body.playerId) {
            const name = `${body.name || ''}`.trim().slice(0, 64);
            if (!name) throw new ApiError(400, 'name, steamId or playerId required');
            if (!tracker.players.some(e => SteamFriends.normName(e.name) === SteamFriends.normName(name))) {
                tracker.players.push({ name: name, steamId: null, playerId: null });
                client.setInstance(guildId, instance);
                await DiscordMessages.sendTrackerMessage(guildId, trackerId);
            }
            return serializeTracker(client, trackerId, tracker, rustplus ? rustplus.serverId : null, guildId);
        }

        const id = `${body.steamId || body.playerId || ''}`.trim();
        if (!/^\d+$/.test(id)) throw new ApiError(400, 'steamId or playerId (digits) required');
        /* Both known (a Steam friend matched to a player on the server): keep both */
        const both = body.steamId && body.playerId && /^\d+$/.test(`${body.playerId}`) &&
            `${body.steamId}`.length === Constants.STEAMID64_LENGTH ? { steamId: `${body.steamId}`, playerId: `${body.playerId}` } : null;

        const isSteamId64 = id.length === Constants.STEAMID64_LENGTH;
        if ((isSteamId64 && tracker.players.some(e => e.steamId === id)) ||
            (!isSteamId64 && tracker.players.some(e => e.playerId === id)) ||
            (both && tracker.players.some(e => e.playerId === both.playerId))) {
            return serializeTracker(client, trackerId, tracker);
        }

        const bm = client.battlemetricsInstances[tracker.battlemetricsId];
        /* Players picked from the live search come from the connected server's Battlemetrics data */
        const currentBm = getBm(client, guildId, rustplus).bm;
        const knownName = playerId => [bm, currentBm].map(b => (b && b.players.hasOwnProperty(playerId) ? b.players[playerId]['name'] : null))
            .find(n => n) || null;
        let name = null, steamId = null, playerId = null;
        if (both) {
            steamId = both.steamId;
            playerId = both.playerId;
            name = knownName(playerId) || (body.name ? `${body.name}`.slice(0, 64) : '-');
        }
        else if (isSteamId64) {
            steamId = id;
            name = await Scrape.scrapeSteamProfileName(client, id) || (body.name ? `${body.name}`.slice(0, 64) : null);
            for (const b of [bm, currentBm]) {
                if (!name || !b || playerId) continue;
                playerId = Object.keys(b.players).find(e => b.players[e]['name'] === name) || null;
            }
        }
        else {
            playerId = id;
            name = knownName(id) || (body.name ? `${body.name}`.slice(0, 64) : '-');
        }

        /* Re-read: the Steam lookup awaited, the instance may have changed meanwhile */
        const fresh = client.getInstance(guildId);
        const freshTracker = fresh.trackers[trackerId];
        if (!freshTracker) throw new ApiError(404, 'Tracker not found');
        freshTracker.players.push({ name: name || '-', steamId: steamId, playerId: playerId });
        client.setInstance(guildId, fresh);
        await DiscordMessages.sendTrackerMessage(guildId, trackerId);
        return serializeTracker(client, trackerId, freshTracker, rustplus ? rustplus.serverId : null, guildId);
    },

    removePlayer: async function (client, guildId, trackerId, id, rustplus = null) {
        const instance = client.getInstance(guildId);
        const tracker = instance.trackers[trackerId];
        if (!tracker) throw new ApiError(404, 'Tracker not found');

        const before = tracker.players.length;
        tracker.players = tracker.players.filter(e => e.steamId !== id && e.playerId !== id);
        if (tracker.players.length === before) throw new ApiError(404, 'Player not in tracker');
        client.setInstance(guildId, instance);
        await DiscordMessages.sendTrackerMessage(guildId, trackerId);
        return serializeTracker(client, trackerId, tracker, rustplus ? rustplus.serverId : null, guildId);
    }
};
