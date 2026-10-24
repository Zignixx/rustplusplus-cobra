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

const Map = require('../util/map.js');
const Trackers = require('./trackers.js');
const TimeLib = require('../util/timer.js');

/* Builds the JSON state that the HTTP API serves for one rustplus instance. Every section is built defensively:
   while the bot is (re)connecting, map/info/team/markers can still be null. All positions are given in world
   coordinates (x, y) and normalized to the map image (nx, ny in 0..1, origin top left), so clients can draw them
   directly on /api/v1/map.jpg. */

function toIso(unixSeconds) {
    if (!unixSeconds) return null;
    return new Date(unixSeconds * 1000).toISOString();
}

function timerLeftMs(timer) {
    try {
        if (timer && timer.getStateRunning()) return Math.max(0, Math.round(timer.getTimeLeft()));
    }
    catch (e) { /* ignore */ }
    return null;
}

function createProjector(rustplus) {
    const map = rustplus.map;
    const info = rustplus.info;
    if (!map || !info || !map.width || !map.height || !info.mapSize) return null;

    const width = map.width;
    const height = map.height;
    const margin = map.oceanMargin;
    const mapSize = info.mapSize;

    return function (x, y) {
        /* Same projection as Map.calculateImageXY, normalized to the image size. */
        const px = x * ((width - 2 * margin) / mapSize) + margin;
        const py = height - (y * ((height - 2 * margin) / mapSize) + margin);
        return { nx: +(px / width).toFixed(5), ny: +(py / height).toFixed(5) };
    };
}

function position(rustplus, project, x, y) {
    const pos = { x: x, y: y, nx: null, ny: null, grid: null };
    if (project && typeof x === 'number' && typeof y === 'number') {
        Object.assign(pos, project(x, y));
    }
    try {
        if (rustplus.info && typeof x === 'number' && typeof y === 'number') {
            pos.grid = Map.getPos(x, y, rustplus.info.correctedMapSize, rustplus).location;
        }
    }
    catch (e) { /* ignore */ }
    return pos;
}

function buildServer(client, rustplus, server) {
    const info = rustplus.info;
    return {
        title: server ? server.title : null,
        name: info ? info.name : (server ? server.title : null),
        players: info ? info.players : null,
        maxPlayers: info ? info.maxPlayers : null,
        queuedPlayers: info ? info.queuedPlayers : null,
        mapSize: info ? info.mapSize : null,
        seed: info ? info.seed : null,
        wipeTime: info ? toIso(info.wipeTime) : null,
        url: info ? info.url : null,
        headerImage: info ? info.headerImage : null,
        battlemetricsId: server ? server.battlemetricsId || null : null
    };
}

function buildTime(rustplus) {
    const time = rustplus.time;
    if (!time) return null;

    let secondsTillTransition = null;
    try {
        const str = time.getTimeTillDayOrNight();
        if (str !== null) secondsTillTransition = TimeLib.getSecondsFromStringTime(str);
    }
    catch (e) { /* ignore */ }

    return {
        time: time.time,
        sunrise: time.sunrise,
        sunset: time.sunset,
        isDay: time.isDay(),
        dayLengthMinutes: time.dayLengthMinutes,
        timeScale: time.timeScale,
        secondsTillTransition: secondsTillTransition
    };
}

function buildMap(client, rustplus) {
    const map = rustplus.map;
    if (!map || !rustplus.info) return null;

    const project = createProjector(rustplus);
    const image = client.rustplusMaps[rustplus.guildId];

    const monuments = [];
    for (const monument of map.monuments || []) {
        const name = map.monumentInfo && map.monumentInfo[monument.token] ?
            map.monumentInfo[monument.token].clean : null;
        monuments.push(Object.assign({ token: monument.token, name: name }, position(rustplus, project, monument.x, monument.y)));
    }

    return {
        width: map.width,
        height: map.height,
        oceanMargin: map.oceanMargin,
        mapSize: rustplus.info.mapSize,
        /* Changes whenever the map image changes (new wipe / other server), for client side caching. */
        imageVersion: image ? `${rustplus.serverId}-${map.width}x${map.height}-${image.length}` : null,
        monuments: monuments
    };
}

function buildTeam(rustplus, project, live) {
    const team = rustplus.team;
    if (!team) return null;

    return {
        leaderSteamId: team.leaderSteamId,
        players: team.players.map(player => {
            /* Positions from the faster API live poll, when newer than the bot's poll */
            const fresh = live ? live.players.get(player.steamId) : null;
            const p = fresh ? Object.assign({}, { isOnline: player.isOnline, isAlive: player.isAlive }, fresh) : player;
            return Object.assign({
                steamId: player.steamId,
                name: player.name,
                isOnline: p.isOnline,
                isAlive: p.isAlive,
                isLeader: player.steamId === team.leaderSteamId,
                isAfk: player.isOnline && typeof player.isAfk === 'function' ? player.isAfk() : false,
                afkSeconds: player.afkSeconds,
                spawnTime: toIso(player.spawnTime),
                deathTime: toIso(player.deathTime),
                wentOfflineTime: player.wentOfflineTime instanceof Date ? player.wentOfflineTime.toISOString() : null
            }, position(rustplus, project, p.x, p.y));
        })
    };
}

function buildMarkers(rustplus, project, live) {
    const mm = rustplus.mapMarkers;
    if (!mm) return null;

    const base = marker => {
        const id = typeof marker.id === 'object' && marker.id !== null ? marker.id.toString() : marker.id;
        const fresh = live ? live.markers.get(`${id}`) : null;
        const m = fresh || marker;
        return Object.assign({ id: id, rotation: m.rotation }, position(rustplus, project, m.x, m.y));
    };

    return {
        cargoShips: mm.cargoShips.map(marker => Object.assign(base(marker), {
            isDocked: marker.isDocked === true,
            isHalted: marker.isHalted === true,
            onItsWayOut: marker.onItsWayOut === true,
            egressInMs: timerLeftMs(mm.cargoShipEgressTimers[marker.id])
        })),
        patrolHelicopters: mm.patrolHelicopters.map(base),
        ch47s: mm.ch47s.map(marker => Object.assign(base(marker), { ch47Type: marker.ch47Type || null })),
        travelingVendors: mm.travelingVendors.map(marker => Object.assign(base(marker), {
            isHalted: marker.isHalted === true
        })),
        crates: mm.crates.map(marker => Object.assign(base(marker), { crateType: marker.crateType || null })),
        vendingMachines: mm.vendingMachines.map(marker => Object.assign(base(marker), {
            name: marker.name,
            outOfStock: marker.outOfStock === true
        }))
    };
}

function buildOilRigs(client, rustplus, project, server) {
    const mm = rustplus.mapMarkers;
    if (!mm || !rustplus.map || !rustplus.info) return [];

    const unlockTotalMs = server ? server.oilRigLockedCrateUnlockTimeMs : null;
    const rigs = [];
    for (const rig of mm.getAllOilRigs()) {
        const timerEntry = mm.oilRigCrateTimers[rig.location];
        const unlockInMs = timerEntry && timerEntry.size === rig.size ? timerLeftMs(timerEntry.unlockTimer) : null;
        const triggeredAt = mm.timeSinceOilRigWasTriggered[rig.location];

        rigs.push(Object.assign(position(rustplus, project, rig.x, rig.y), {
            size: rig.size,
            location: rig.location,
            crateUnlockInMs: unlockInMs,
            crateUnlockTotalMs: unlockTotalMs,
            cratePresent: mm.oilRigCratePresence[rig.location] === true,
            triggeredAt: triggeredAt instanceof Date ? triggeredAt.toISOString() : null
        }));
    }
    return rigs;
}

function buildEventTimes(rustplus) {
    const mm = rustplus.mapMarkers;
    if (!mm) return null;

    const iso = date => (date instanceof Date ? date.toISOString() : null);
    return {
        cargoShipLastSeen: iso(mm.timeSinceCargoShipWasOut),
        ch47LastSeen: iso(mm.timeSinceCH47WasOut),
        smallOilRigTriggered: iso(mm.timeSinceSmallOilRigWasTriggered),
        largeOilRigTriggered: iso(mm.timeSinceLargeOilRigWasTriggered),
        patrolHelicopterLastSeen: iso(mm.timeSincePatrolHelicopterWasOnMap),
        patrolHelicopterDestroyed: iso(mm.timeSincePatrolHelicopterWasDestroyed),
        patrolHelicopterDestroyedLocation: mm.patrolHelicopterDestroyedLocation || null,
        travelingVendorLastSeen: iso(mm.timeSinceTravelingVendorWasOnMap)
    };
}

function buildDevices(rustplus, server) {
    if (!server) return null;

    const switches = Object.entries(server.switches || {}).map(([id, device]) => ({
        id: id,
        name: device.name,
        active: device.active,
        reachable: device.reachable,
        location: device.location
    }));

    const alarms = Object.entries(server.alarms || {}).map(([id, device]) => ({
        id: id,
        name: device.name,
        message: device.message,
        active: device.active,
        reachable: device.reachable,
        lastTrigger: toIso(device.lastTrigger),
        location: device.location
    }));

    const storageMonitors = Object.entries(server.storageMonitors || {}).map(([id, device]) => {
        const live = rustplus.storageMonitors[id];
        const expiry = live && live.expiry ? live.expiry : null;
        return {
            id: id,
            name: device.name,
            type: device.type,
            reachable: device.reachable,
            decaying: device.decaying,
            location: device.location,
            /* For tool cupboards: when the upkeep runs out. */
            protectionExpiry: toIso(expiry),
            itemCount: live && Array.isArray(live.items) ? live.items.length : null,
            capacity: live ? live.capacity : null
        };
    });

    return { switches: switches, alarms: alarms, storageMonitors: storageMonitors };
}

function buildTimers(rustplus) {
    return Object.entries(rustplus.timers || {}).map(([id, entry]) => ({
        id: id,
        message: entry.message,
        leftMs: timerLeftMs(entry.timer)
    })).filter(timer => timer.leftMs !== null);
}

function buildTrackersSafe(client, rustplus) {
    try {
        return Trackers.build(client, rustplus.guildId, rustplus);
    }
    catch (e) {
        return null;
    }
}

module.exports = {
    /**
     *  @param {object|null} live Positions from the API live poll ({ players: Map, markers: Map }), newer than
     *      the bot's last poll, or null.
     */
    build: function (client, rustplus, live = null) {
        const instance = client.getInstance(rustplus.guildId);
        const server = instance && instance.serverList ? instance.serverList[rustplus.serverId] : null;
        const project = createProjector(rustplus);

        return {
            generatedAt: new Date().toISOString(),
            guildId: rustplus.guildId,
            serverId: rustplus.serverId,
            connected: rustplus.isOperational === true,
            server: buildServer(client, rustplus, server),
            time: buildTime(rustplus),
            map: buildMap(client, rustplus),
            team: buildTeam(rustplus, project, live),
            markers: buildMarkers(rustplus, project, live),
            oilRigs: buildOilRigs(client, rustplus, project, server),
            lastEvents: buildEventTimes(rustplus),
            devices: buildDevices(rustplus, server),
            timers: buildTimers(rustplus),
            trackers: buildTrackersSafe(client, rustplus)
        };
    }
};
