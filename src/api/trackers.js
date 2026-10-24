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

function serializeTracker(client, trackerId, tracker, currentServerId = null) {
    const bm = client.battlemetricsInstances[tracker.battlemetricsId] || null;
    const players = tracker.players.map(p => Object.assign({
        name: p.name,
        steamId: p.steamId,
        playerId: p.playerId,
        steamUrl: p.steamId ? `${Constants.STEAM_PROFILES_URL}${p.steamId}` : null,
        battlemetricsUrl: p.playerId ? `${Constants.BATTLEMETRICS_PROFILE_URL}${p.playerId}` : null
    }, playerStatus(bm, p.playerId)));

    return {
        id: `${trackerId}`,
        name: tracker.name,
        serverId: tracker.serverId,
        title: tracker.title,
        battlemetricsId: tracker.battlemetricsId,
        /* Trackers keep the Battlemetrics data of the server they were made for (e.g. an older wipe) */
        current: currentServerId !== null && tracker.serverId === currentServerId,
        clanTag: tracker.clanTag,
        online: players.filter(p => p.status === 'online').length,
        players: players
    };
}

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
                .map(([id, tracker]) => serializeTracker(client, id, tracker, rustplus ? rustplus.serverId : null))
                .sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0))
        };
    },

    /** Players currently online on the server according to Battlemetrics, optionally filtered by name */
    searchOnline: function (client, guildId, rustplus, query, limit = 100) {
        if (!bmEnabled()) throw new ApiError(409, 'Battlemetrics is disabled (no RPP_BATTLEMETRICS_TOKEN)');
        const { bmId, bm } = getBm(client, guildId, rustplus);
        if (!bmId) throw new ApiError(409, 'The server has no Battlemetrics id');
        if (!bm || !bm.lastUpdateSuccessful) throw new ApiError(503, 'Battlemetrics data is not available yet');

        const instance = client.getInstance(guildId);
        const trackedBy = new Object();
        for (const [trackerId, tracker] of Object.entries(instance.trackers || {})) {
            for (const p of tracker.players) {
                if (!p.playerId) continue;
                if (!trackedBy[p.playerId]) trackedBy[p.playerId] = [];
                trackedBy[p.playerId].push(`${trackerId}`);
            }
        }

        const q = (query || '').trim().toLowerCase();
        const players = bm.getOnlinePlayerIdsOrderedByTime()
            .map(id => bm.players[id])
            .filter(p => p && (!q || `${p.name}`.toLowerCase().includes(q) || `${p.id}` === q))
            .slice(0, limit)
            .map(p => ({
                playerId: `${p.id}`,
                name: p.name,
                onlineSeconds: secondsOf(bm.getOnlineTime(p.id)),
                firstTime: p.firstTime === true,
                battlemetricsUrl: `${Constants.BATTLEMETRICS_PROFILE_URL}${p.id}`,
                trackedBy: trackedBy[p.id] || []
            }));

        return {
            battlemetricsId: bmId,
            updatedAt: bm.updatedAt,
            streamerMode: bm.streamerMode,
            total: bm.onlinePlayers.length,
            players: players
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
        return serializeTracker(client, trackerId, client.getInstance(guildId).trackers[trackerId], rustplus.serverId);
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
        if (!bmEnabled()) throw new ApiError(409, 'Battlemetrics is disabled (no RPP_BATTLEMETRICS_TOKEN)');
        const instance = client.getInstance(guildId);
        const tracker = instance.trackers[trackerId];
        if (!tracker) throw new ApiError(404, 'Tracker not found');

        const id = `${body.steamId || body.playerId || ''}`.trim();
        if (!/^\d+$/.test(id)) throw new ApiError(400, 'steamId or playerId (digits) required');

        const isSteamId64 = id.length === Constants.STEAMID64_LENGTH;
        if ((isSteamId64 && tracker.players.some(e => e.steamId === id)) ||
            (!isSteamId64 && tracker.players.some(e => e.playerId === id))) {
            return serializeTracker(client, trackerId, tracker);
        }

        const bm = client.battlemetricsInstances[tracker.battlemetricsId];
        /* Players picked from the live search come from the connected server's Battlemetrics data */
        const currentBm = getBm(client, guildId, rustplus).bm;
        const knownName = playerId => [bm, currentBm].map(b => (b && b.players.hasOwnProperty(playerId) ? b.players[playerId]['name'] : null))
            .find(n => n) || null;
        let name = null, steamId = null, playerId = null;
        if (isSteamId64) {
            steamId = id;
            name = await Scrape.scrapeSteamProfileName(client, id);
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
        return serializeTracker(client, trackerId, freshTracker, rustplus ? rustplus.serverId : null);
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
        return serializeTracker(client, trackerId, tracker, rustplus ? rustplus.serverId : null);
    }
};
