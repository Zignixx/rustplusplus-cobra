/*
    Copyright (C) 2022 Alexander Emanuelsson (alexemanuelol)

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

const Constants = require('../util/constants.js');
const Map = require('../util/map.js');
const Timer = require('../util/timer');

class MapMarkers {
    constructor(mapMarkers, rustplus, client) {
        this._markers = mapMarkers.markers;

        this._rustplus = rustplus;
        this._client = client;

        this._types = {
            Player: 1,
            Explosion: 2,
            VendingMachine: 3,
            CH47: 4,
            CargoShip: 5,
            Crate: 6,
            GenericRadius: 7,
            PatrolHelicopter: 8,
            TravelingVendor: 9
        }

        this._players = [];
        this._vendingMachines = [];
        this._ch47s = [];
        this._cargoShips = [];
        this._crates = [];
        this._genericRadiuses = [];
        this._patrolHelicopters = [];
        this._travelingVendors = [];

        /* Timers */
        this.cargoShipEgressTimers = new Object();
        this.oilRigCrateTimers = new Object();

        /* Tracks whether a Locked Crate is currently present at each Oil Rig, keyed by
           the Oil Rig grid location (e.g. "D8"). Used to detect when a crate respawns
           (state goes from "no crate" to "crate present"). */
        this.oilRigCratePresence = new Object();

        /* Tracks the last time Heavy Scientists were called (a CH47 dropped them off) at
           each Oil Rig, keyed by the Oil Rig grid location (e.g. "D8"). Used by the
           !small / !large commands to report the status of every Oil Rig individually. */
        this.timeSinceOilRigWasTriggered = new Object();

        /* Event dates */
        this.timeSinceCargoShipWasOut = null;
        this.timeSinceCH47WasOut = null;
        this.timeSinceSmallOilRigWasTriggered = null;
        this.timeSinceLargeOilRigWasTriggered = null;
        this.timeSincePatrolHelicopterWasOnMap = null;
        this.timeSincePatrolHelicopterWasDestroyed = null;
        this.timeSinceTravelingVendorWasOnMap = null;

        /* Event location */
        this.patrolHelicopterDestroyedLocation = null;

        /* Vending Machine variables */
        this.knownVendingMachines = [];

        this.updateMapMarkers(mapMarkers);
    }

    /* Getters and Setters */
    get markers() { return this._markers; }
    set markers(markers) { this._markers = markers; }
    get rustplus() { return this._rustplus; }
    set rustplus(rustplus) { this._rustplus = rustplus; }
    get client() { return this._client; }
    set client(client) { this._client = client; }
    get types() { return this._types; }
    set types(types) { this._types = types; }
    get players() { return this._players; }
    set players(players) { this._players = players; }
    get vendingMachines() { return this._vendingMachines; }
    set vendingMachines(vendingMachines) { this._vendingMachines = vendingMachines; }
    get ch47s() { return this._ch47s; }
    set ch47s(ch47s) { this._ch47s = ch47s; }
    get cargoShips() { return this._cargoShips; }
    set cargoShips(cargoShips) { this._cargoShips = cargoShips; }
    get crates() { return this._crates; }
    set crates(crates) { this._crates = crates; }
    get genericRadiuses() { return this._genericRadiuses; }
    set genericRadiuses(genericRadiuses) { this._genericRadiuses = genericRadiuses; }
    get patrolHelicopters() { return this._patrolHelicopters; }
    set patrolHelicopters(patrolHelicopters) { this._patrolHelicopters = patrolHelicopters; }
    get travelingVendors() { return this._travelingVendors; }
    set travelingVendors(travelingVendors) { this._travelingVendors = travelingVendors; }

    getType(type) {
        if (!Object.values(this.types).includes(type)) {
            return null;
        }

        switch (type) {
            case this.types.Player: {
                return this.players;
            } break;

            case this.types.VendingMachine: {
                return this.vendingMachines;
            } break;

            case this.types.CH47: {
                return this.ch47s;
            } break;

            case this.types.CargoShip: {
                return this.cargoShips;
            } break;

            case this.types.Crate: {
                return this.crates;
            } break;

            case this.types.GenericRadius: {
                return this.genericRadiuses;
            } break;

            case this.types.PatrolHelicopter: {
                return this.patrolHelicopters;
            } break;

            case this.types.TravelingVendor: {
                return this.travelingVendors;
            } break;

            default: {
                return null;
            } break;
        }
    }

    getMarkersOfType(type, markers) {
        if (!Object.values(this.types).includes(type)) {
            return [];
        }

        let markersOfType = [];
        for (let marker of markers) {
            if (marker.type === type) {
                markersOfType.push(marker);
            }
        }

        return markersOfType;
    }

    getMarkerByTypeId(type, id) {
        return this.getType(type).find(e => e.id === id);
    }

    getMarkerByTypeXY(type, x, y) {
        return this.getType(type).find(e => e.x === x && e.y === y);
    }

    isMarkerPresentByTypeId(type, id, markers = null) {
        if (markers) {
            return markers.some(e => e.id === id);
        }
        else {
            return this.getType(type).some(e => e.id === id);
        }
    }

    getNewMarkersOfTypeId(type, markers) {
        let newMarkersOfType = [];

        for (let marker of this.getMarkersOfType(type, markers)) {
            if (!this.isMarkerPresentByTypeId(type, marker.id)) {
                newMarkersOfType.push(marker);
            }
        }

        return newMarkersOfType
    }

    getLeftMarkersOfTypeId(type, markers) {
        let leftMarkersOfType = this.getType(type).slice();

        for (let marker of this.getMarkersOfType(type, markers)) {
            if (this.isMarkerPresentByTypeId(type, marker.id)) {
                leftMarkersOfType = leftMarkersOfType.filter(e => e.id !== marker.id);
            }
        }

        return leftMarkersOfType;
    }

    getRemainingMarkersOfTypeId(type, markers) {
        let remainingMarkersOfType = [];

        for (let marker of markers) {
            if (this.isMarkerPresentByTypeId(type, marker.id)) {
                remainingMarkersOfType.push(marker);
            }
        }

        return remainingMarkersOfType;
    }

    isMarkerPresentByTypeXY(type, x, y, markers = null) {
        if (markers) {
            return markers.some(e => e.x === x && e.y === y);
        }
        else {
            return this.getType(type).some(e => e.x === x && e.y === y);
        }
    }

    getNewMarkersOfTypeXY(type, markers) {
        let newMarkersOfType = [];

        for (let marker of this.getMarkersOfType(type, markers)) {
            if (!this.isMarkerPresentByTypeXY(type, marker.x, marker.y)) {
                newMarkersOfType.push(marker);
            }
        }

        return newMarkersOfType;
    }

    getLeftMarkersOfTypeXY(type, markers) {
        let leftMarkersOfType = this.getType(type).slice();

        for (let marker of this.getMarkersOfType(type, markers)) {
            if (this.isMarkerPresentByTypeXY(type, marker.x, marker.y)) {
                leftMarkersOfType = leftMarkersOfType.filter(e => e.x !== marker.x) || e.y !== marker.y;
            }
        }

        return leftMarkersOfType;
    }

    getRemainingMarkersOfTypeXY(type, markers) {
        let remainingMarkersOfType = [];

        for (let marker of markers) {
            if (this.isMarkerPresentByTypeXY(type, marker.x, marker.y)) {
                remainingMarkersOfType.push(marker);
            }
        }

        return remainingMarkersOfType;
    }




    /* Update event map markers */

    updateMapMarkers(mapMarkers) {
        this.updatePlayers(mapMarkers);
        this.updateCargoShips(mapMarkers);
        this.updatePatrolHelicopters(mapMarkers);
        this.updateCH47s(mapMarkers);
        this.updateCrates(mapMarkers);
        this.updateVendingMachines(mapMarkers);
        this.updateGenericRadiuses(mapMarkers);
        this.updateTravelingVendors(mapMarkers);
    }

    updatePlayers(mapMarkers) {
        let newMarkers = this.getNewMarkersOfTypeId(this.types.Player, mapMarkers.markers);
        let leftMarkers = this.getLeftMarkersOfTypeId(this.types.Player, mapMarkers.markers);
        let remainingMarkers = this.getRemainingMarkersOfTypeId(this.types.Player, mapMarkers.markers);

        /* Player markers that are new. */
        for (let marker of newMarkers) {
            let mapSize = this.rustplus.info.correctedMapSize;
            let pos = Map.getPos(marker.x, marker.y, mapSize, this.rustplus);

            marker.location = pos;

            this.players.push(marker);
        }

        /* Player markers that have left. */
        for (let marker of leftMarkers) {
            this.players = this.players.filter(e => e.id !== marker.id);
        }

        /* Player markers that still remains. */
        for (let marker of remainingMarkers) {
            let mapSize = this.rustplus.info.correctedMapSize;
            let pos = Map.getPos(marker.x, marker.y, mapSize, this.rustplus);
            let player = this.getMarkerByTypeId(this.types.Player, marker.id);

            player.x = marker.x;
            player.y = marker.y;
            player.location = pos;
        }
    }

    updateVendingMachines(mapMarkers) {
        let newMarkers = this.getNewMarkersOfTypeXY(this.types.VendingMachine, mapMarkers.markers);
        let leftMarkers = this.getLeftMarkersOfTypeXY(this.types.VendingMachine, mapMarkers.markers);
        let remainingMarkers = this.getRemainingMarkersOfTypeXY(this.types.VendingMachine, mapMarkers.markers);

        /* VendingMachine markers that are new. */
        for (let marker of newMarkers) {
            let mapSize = this.rustplus.info.correctedMapSize;
            let pos = Map.getPos(marker.x, marker.y, mapSize, this.rustplus);

            marker.location = pos;

            if (!this.rustplus.isFirstPoll) {
                if (!this.knownVendingMachines.some(e => e.x === marker.x && e.y === marker.y)) {
                    this.rustplus.sendEvent(
                        this.rustplus.notificationSettings.vendingMachineDetectedSetting,
                        this.client.intlGet(this.rustplus.guildId, 'newVendingMachine', { location: pos.string }),
                        null,
                        Constants.COLOR_NEW_VENDING_MACHINE);
                }
            }

            this.knownVendingMachines.push({ x: marker.x, y: marker.y });
            this.vendingMachines.push(marker);
        }

        /* VendingMachine markers that have left. */
        for (let marker of leftMarkers) {
            this.vendingMachines = this.vendingMachines.filter(e => e.x !== marker.x) || e.y !== marker.y;
        }

        /* VendingMachine markers that still remains. */
        for (let marker of remainingMarkers) {
            let mapSize = this.rustplus.info.correctedMapSize;
            let pos = Map.getPos(marker.x, marker.y, mapSize, this.rustplus);
            let vendingMachine = this.getMarkerByTypeXY(this.types.VendingMachine, marker.x, marker.y);

            vendingMachine.id = marker.id;
            vendingMachine.location = pos;
            vendingMachine.sellOrders = marker.sellOrders;
        }
    }

    updateCH47s(mapMarkers) {
        let newMarkers = this.getNewMarkersOfTypeId(this.types.CH47, mapMarkers.markers);
        let leftMarkers = this.getLeftMarkersOfTypeId(this.types.CH47, mapMarkers.markers);
        let remainingMarkers = this.getRemainingMarkersOfTypeId(this.types.CH47, mapMarkers.markers);

        /* CH47 markers that are new. */
        for (let marker of newMarkers) {
            let mapSize = this.rustplus.info.correctedMapSize;
            let pos = Map.getPos(marker.x, marker.y, mapSize, this.rustplus);

            marker.location = pos;

            let smallOilRig = [], largeOilRig = [];
            for (let monument of this.rustplus.map.monuments) {
                if (monument.token === 'oil_rig_small') {
                    smallOilRig.push({ x: monument.x, y: monument.y })
                }
                else if (monument.token === 'large_oil_rig') {
                    largeOilRig.push({ x: monument.x, y: monument.y })
                }
            }

            let found = false;
            if (!this.rustplus.isFirstPoll) {
                for (let oilRig of smallOilRig) {
                    if (Map.getDistance(marker.x, marker.y, oilRig.x, oilRig.y) <=
                        Constants.OIL_RIG_CHINOOK_47_MAX_SPAWN_DISTANCE) {
                        found = true;
                        let oilRigLocation = Map.getPos(oilRig.x, oilRig.y, mapSize, this.rustplus);
                        marker.ch47Type = 'smallOilRig';

                        this.rustplus.sendEvent(
                            this.rustplus.notificationSettings.heavyScientistCalledSetting,
                            this.client.intlGet(this.rustplus.guildId, 'heavyScientistsCalledSmall',
                                { location: oilRigLocation.location }),
                            'small',
                            Constants.COLOR_HEAVY_SCIENTISTS_CALLED_SMALL,
                            this.rustplus.isFirstPoll,
                            'small_oil_rig_logo.png');

                        let instance = this.client.getInstance(this.rustplus.guildId);
                        let smallUnlockTimeMs =
                            instance.serverList[this.rustplus.serverId].oilRigLockedCrateUnlockTimeMs;

                        this.startOilRigCrateTimers('small', oilRigLocation.location, smallUnlockTimeMs);

                        this.timeSinceSmallOilRigWasTriggered = new Date();
                        this.timeSinceOilRigWasTriggered[oilRigLocation.location] = new Date();
                        break;
                    }
                }
            }

            if (!found && !this.rustplus.isFirstPoll) {
                for (let oilRig of largeOilRig) {
                    if (Map.getDistance(marker.x, marker.y, oilRig.x, oilRig.y) <=
                        Constants.OIL_RIG_CHINOOK_47_MAX_SPAWN_DISTANCE) {
                        found = true;
                        let oilRigLocation = Map.getPos(oilRig.x, oilRig.y, mapSize, this.rustplus);
                        marker.ch47Type = 'largeOilRig';

                        this.rustplus.sendEvent(
                            this.rustplus.notificationSettings.heavyScientistCalledSetting,
                            this.client.intlGet(this.rustplus.guildId, 'heavyScientistsCalledLarge',
                                { location: oilRigLocation.location }),
                            'large',
                            Constants.COLOR_HEAVY_SCIENTISTS_CALLED_LARGE,
                            this.rustplus.isFirstPoll,
                            'large_oil_rig_logo.png');

                        let instance = this.client.getInstance(this.rustplus.guildId);
                        let largeUnlockTimeMs =
                            instance.serverList[this.rustplus.serverId].oilRigLockedCrateUnlockTimeMs;

                        this.startOilRigCrateTimers('large', oilRigLocation.location, largeUnlockTimeMs);

                        this.timeSinceLargeOilRigWasTriggered = new Date();
                        this.timeSinceOilRigWasTriggered[oilRigLocation.location] = new Date();
                        break;
                    }
                }
            }

            if (!found) {
                /* Offset that is used to determine if CH47 just spawned */
                let offset = 4 * Map.gridDiameter;

                /* If CH47 is located outside the grid system + the offset */
                if (Map.isOutsideGridSystem(marker.x, marker.y, mapSize, offset)) {
                    this.rustplus.sendEvent(
                        this.rustplus.notificationSettings.chinook47DetectedSetting,
                        this.client.intlGet(this.rustplus.guildId, 'chinook47EntersMap', { location: pos.string }),
                        'chinook',
                        Constants.COLOR_CHINOOK47_ENTERS_MAP);
                }
                else {
                    this.rustplus.sendEvent(
                        this.rustplus.notificationSettings.chinook47DetectedSetting,
                        this.client.intlGet(this.rustplus.guildId, 'chinook47Located', { location: pos.string }),
                        'chinook',
                        Constants.COLOR_CHINOOK47_LOCATED);
                }
                marker.ch47Type = 'crate';
            }

            this.ch47s.push(marker);
        }

        /* CH47 markers that have left. */
        for (let marker of leftMarkers) {
            if (marker.ch47Type === 'crate') {
                this.timeSinceCH47WasOut = new Date();
                this.rustplus.log(this.client.intlGet(null, 'eventCap'),
                    this.client.intlGet(null, 'chinook47LeftMap', { location: marker.location.string }));
            }

            this.ch47s = this.ch47s.filter(e => e.id !== marker.id);
        }

        /* CH47 markers that still remains. */
        for (let marker of remainingMarkers) {
            let mapSize = this.rustplus.info.correctedMapSize;
            let pos = Map.getPos(marker.x, marker.y, mapSize, this.rustplus);
            let ch47 = this.getMarkerByTypeId(this.types.CH47, marker.id);

            ch47.x = marker.x;
            ch47.y = marker.y;
            ch47.location = pos;
        }
    }

    updateCargoShips(mapMarkers) {
        let newMarkers = this.getNewMarkersOfTypeId(this.types.CargoShip, mapMarkers.markers);
        let leftMarkers = this.getLeftMarkersOfTypeId(this.types.CargoShip, mapMarkers.markers);
        let remainingMarkers = this.getRemainingMarkersOfTypeId(this.types.CargoShip, mapMarkers.markers);

        /* CargoShip markers that are new. */
        for (let marker of newMarkers) {
            let mapSize = this.rustplus.info.correctedMapSize;
            let pos = Map.getPos(marker.x, marker.y, mapSize, this.rustplus);

            this.rustplus.cargoShipTracers[marker.id] = [{ x: marker.x, y: marker.y }];

            marker.location = pos;
            marker.onItsWayOut = false;
            marker.isDocked = false;

            /* Offset that is used to determine if CargoShip just spawned */
            let offset = 4 * Map.gridDiameter;

            /* If CargoShip is located outside the grid system + the offset */
            if (Map.isOutsideGridSystem(marker.x, marker.y, mapSize, offset)) {
                this.rustplus.sendEvent(
                    this.rustplus.notificationSettings.cargoShipDetectedSetting,
                    this.client.intlGet(this.rustplus.guildId, 'cargoShipEntersMap', { location: pos.string }),
                    'cargo',
                    Constants.COLOR_CARGO_SHIP_ENTERS_MAP);

                let instance = this.client.getInstance(this.rustplus.guildId);
                this.cargoShipEgressTimers[marker.id] = new Timer.timer(
                    this.notifyCargoShipEgress.bind(this),
                    instance.serverList[this.rustplus.serverId].cargoShipEgressTimeMs,
                    marker.id);
                this.cargoShipEgressTimers[marker.id].start();
            }
            else {
                this.rustplus.sendEvent(
                    this.rustplus.notificationSettings.cargoShipDetectedSetting,
                    this.client.intlGet(this.rustplus.guildId, 'cargoShipLocated', { location: pos.string }),
                    'cargo',
                    Constants.COLOR_CARGO_SHIP_LOCATED);
            }

            this.cargoShips.push(marker);
        }

        /* CargoShip markers that have left. */
        for (let marker of leftMarkers) {
            this.rustplus.sendEvent(
                this.rustplus.notificationSettings.cargoShipLeftSetting,
                this.client.intlGet(this.rustplus.guildId, 'cargoShipLeftMap', { location: marker.location.string }),
                'cargo',
                Constants.COLOR_CARGO_SHIP_LEFT_MAP);

            if (this.cargoShipEgressTimers[marker.id]) {
                this.cargoShipEgressTimers[marker.id].stop();
                delete this.cargoShipEgressTimers[marker.id];
            }

            this.timeSinceCargoShipWasOut = new Date();

            this.cargoShips = this.cargoShips.filter(e => e.id !== marker.id);
            delete this.rustplus.cargoShipTracers[marker.id];
        }

        /* CargoShip markers that still remains. */
        for (let marker of remainingMarkers) {
            let mapSize = this.rustplus.info.correctedMapSize;
            let pos = Map.getPos(marker.x, marker.y, mapSize, this.rustplus);
            let cargoShip = this.getMarkerByTypeId(this.types.CargoShip, marker.id);

            this.rustplus.cargoShipTracers[marker.id].push({ x: marker.x, y: marker.y });

            const harbors = [];
            for (const monument of this.rustplus.map.monuments) {
                if (/harbor/.test(monument.token)) {
                    harbors.push({ x: monument.x, y: monument.y })
                }
            }

            /* If CargoShip is docked at Harbor */
            if (!this.rustplus.isFirstPoll && !cargoShip.isDocked) {
                for (const harbor of harbors) {
                    if (Map.getDistance(marker.x, marker.y, harbor.x, harbor.y) <= Constants.HARBOR_DOCK_DISTANCE) {
                        if (marker.x === cargoShip.x && marker.y === cargoShip.y) {
                            /* CargoShip is now docked. */
                            const harborLocation = Map.getPos(harbor.x, harbor.y, mapSize, this.rustplus);
                            cargoShip.isDocked = true;
                            this.rustplus.sendEvent(
                                this.rustplus.notificationSettings.cargoShipDockingAtHarborSetting,
                                this.client.intlGet(this.rustplus.guildId, 'cargoShipDockingAtHarbor',
                                    { location: harborLocation.location }), 'cargo', Constants.COLOR_CARGO_SHIP_DOCKED
                            );
                        }
                    }
                }
            }
            else if (!this.rustplus.isFirstPoll && cargoShip.isDocked) {
                for (const harbor of harbors) {
                    if (Map.getDistance(marker.x, marker.y, harbor.x, harbor.y) <= Constants.HARBOR_DOCK_DISTANCE) {
                        if (marker.x !== cargoShip.x || marker.y !== cargoShip.y) {
                            const harborLocation = Map.getPos(harbor.x, harbor.y, mapSize, this.rustplus);
                            cargoShip.isDocked = false;
                            this.rustplus.sendEvent(
                                this.rustplus.notificationSettings.cargoShipDockingAtHarborSetting,
                                this.client.intlGet(this.rustplus.guildId, 'cargoShipLeftHarbor',
                                    { location: harborLocation.location }), 'cargo', Constants.COLOR_CARGO_SHIP_DOCKED
                            );
                        }
                    }
                }
            }

            cargoShip.x = marker.x;
            cargoShip.y = marker.y;
            cargoShip.location = pos;
        }
    }

    updateCrates(mapMarkers) {
        let newMarkers = this.getNewMarkersOfTypeId(this.types.Crate, mapMarkers.markers);
        let leftMarkers = this.getLeftMarkersOfTypeId(this.types.Crate, mapMarkers.markers);
        let remainingMarkers = this.getRemainingMarkersOfTypeId(this.types.Crate, mapMarkers.markers);
        let mapSize = this.rustplus.info.correctedMapSize;

        /* Keep the internal crate list in sync with the current markers. */
        for (let marker of newMarkers) {
            marker.location = Map.getPos(marker.x, marker.y, mapSize, this.rustplus);
            let oilRig = this.getClosestOilRig(marker.x, marker.y);
            marker.crateType = oilRig !== null ? 'oilRig' : 'other';
            this.crates.push(marker);
        }

        for (let marker of leftMarkers) {
            this.crates = this.crates.filter(e => e.id !== marker.id);
        }

        for (let marker of remainingMarkers) {
            let crate = this.getMarkerByTypeId(this.types.Crate, marker.id);
            crate.x = marker.x;
            crate.y = marker.y;
            crate.location = Map.getPos(marker.x, marker.y, mapSize, this.rustplus);
        }

        /* Detect Locked Crate respawns per Oil Rig. For each Oil Rig we track whether a
           crate is currently present. When the state changes from "no crate" to
           "crate present", the Locked Crate has respawned at that Oil Rig. */
        for (const oilRig of this.getAllOilRigs()) {
            const cratePresent = this.crates.some(crate =>
                Map.getDistance(crate.x, crate.y, oilRig.x, oilRig.y) <=
                Constants.OIL_RIG_LOCKED_CRATE_MAX_DISTANCE);

            const wasPresent = this.oilRigCratePresence[oilRig.location] === true;

            if (cratePresent && !wasPresent && !this.rustplus.isFirstPoll) {
                this.rustplus.sendEvent(
                    this.rustplus.notificationSettings.lockedCrateOilRigRespawnedSetting,
                    this.client.intlGet(this.rustplus.guildId, 'lockedCrateOilRigRespawned',
                        { location: oilRig.location }),
                    null,
                    Constants.COLOR_LOCKED_CRATE_OILRIG_RESPAWNED,
                    this.rustplus.isFirstPoll,
                    'locked_crate_logo.png');
            }

            this.oilRigCratePresence[oilRig.location] = cratePresent;
        }
    }

    updateGenericRadiuses(mapMarkers) {
        let newMarkers = this.getNewMarkersOfTypeId(this.types.GenericRadius, mapMarkers.markers);
        let leftMarkers = this.getLeftMarkersOfTypeId(this.types.GenericRadius, mapMarkers.markers);
        let remainingMarkers = this.getRemainingMarkersOfTypeId(this.types.GenericRadius, mapMarkers.markers);

        /* GenericRadius markers that are new. */
        for (let marker of newMarkers) {
            this.genericRadiuses.push(marker);
        }

        /* GenericRadius markers that have left. */
        for (let marker of leftMarkers) {
            this.genericRadiuses = this.genericRadiuses.filter(e => e.id !== marker.id);
        }

        /* GenericRadius markers that still remains. */
        for (let marker of remainingMarkers) {
            let genericRadius = this.getMarkerByTypeId(this.types.GenericRadius, marker.id);

            genericRadius.x = marker.x;
            genericRadius.y = marker.y;
        }
    }

    updatePatrolHelicopters(mapMarkers) {
        let newMarkers = this.getNewMarkersOfTypeId(this.types.PatrolHelicopter, mapMarkers.markers);
        let leftMarkers = this.getLeftMarkersOfTypeId(this.types.PatrolHelicopter, mapMarkers.markers);
        let remainingMarkers = this.getRemainingMarkersOfTypeId(this.types.PatrolHelicopter, mapMarkers.markers);

        /* PatrolHelicopter markers that are new. */
        for (let marker of newMarkers) {
            let mapSize = this.rustplus.info.correctedMapSize;
            let pos = Map.getPos(marker.x, marker.y, mapSize, this.rustplus);

            this.rustplus.patrolHelicopterTracers[marker.id] = [{ x: marker.x, y: marker.y }];

            marker.location = pos;

            /* Offset that is used to determine if PatrolHelicopter just spawned */
            let offset = 4 * Map.gridDiameter;

            /* If PatrolHelicopter is located outside the grid system + the offset */
            if (Map.isOutsideGridSystem(marker.x, marker.y, mapSize, offset)) {
                this.rustplus.sendEvent(
                    this.rustplus.notificationSettings.patrolHelicopterDetectedSetting,
                    this.client.intlGet(this.rustplus.guildId, 'patrolHelicopterEntersMap', {
                        location: pos.string
                    }),
                    'heli',
                    Constants.COLOR_PATROL_HELICOPTER_ENTERS_MAP);
            }
            else {
                this.rustplus.sendEvent(
                    this.rustplus.notificationSettings.patrolHelicopterDetectedSetting,
                    this.client.intlGet(this.rustplus.guildId, 'patrolHelicopterLocatedAt', {
                        location: pos.string
                    }),
                    'heli',
                    Constants.COLOR_PATROL_HELICOPTER_LOCATED_AT);
            }

            this.patrolHelicopters.push(marker);
        }

        /* PatrolHelicopter markers that have left. */
        for (let marker of leftMarkers) {
            let mapSize = this.rustplus.info.correctedMapSize;

            if (Map.isOutsideGridSystem(marker.x, marker.y, mapSize)) {
                this.rustplus.sendEvent(
                    this.rustplus.notificationSettings.patrolHelicopterLeftSetting,
                    this.client.intlGet(this.rustplus.guildId, 'patrolHelicopterLeftMap', {
                        location: marker.location.string
                    }),
                    'heli',
                    Constants.COLOR_PATROL_HELICOPTER_LEFT_MAP);

                this.timeSincePatrolHelicopterWasOnMap = new Date();
            }
            else {
                this.rustplus.sendEvent(
                    this.rustplus.notificationSettings.patrolHelicopterDestroyedSetting,
                    this.client.intlGet(this.rustplus.guildId, 'patrolHelicopterTakenDown', {
                        location: marker.location.string
                    }),
                    'heli',
                    Constants.COLOR_PATROL_HELICOPTER_TAKEN_DOWN);

                this.timeSincePatrolHelicopterWasDestroyed = new Date();
                this.timeSincePatrolHelicopterWasOnMap = new Date();

                this.patrolHelicopterDestroyedLocation = Map.getGridPos(marker.x, marker.y, mapSize);
            }

            this.patrolHelicopters = this.patrolHelicopters.filter(e => e.id !== marker.id);
            delete this.rustplus.patrolHelicopterTracers[marker.id];
        }

        /* PatrolHelicopter markers that still remains. */
        for (let marker of remainingMarkers) {
            let mapSize = this.rustplus.info.correctedMapSize;
            let pos = Map.getPos(marker.x, marker.y, mapSize, this.rustplus);
            let patrolHelicopter = this.getMarkerByTypeId(this.types.PatrolHelicopter, marker.id);

            this.rustplus.patrolHelicopterTracers[marker.id].push({ x: marker.x, y: marker.y });

            patrolHelicopter.x = marker.x;
            patrolHelicopter.y = marker.y;
            patrolHelicopter.location = pos;
        }
    }

    updateTravelingVendors(mapMarkers) {
        let newMarkers = this.getNewMarkersOfTypeId(this.types.TravelingVendor, mapMarkers.markers);
        let leftMarkers = this.getLeftMarkersOfTypeId(this.types.TravelingVendor, mapMarkers.markers);
        let remainingMarkers = this.getRemainingMarkersOfTypeId(this.types.TravelingVendor, mapMarkers.markers);

        /* TravelingVendor markers that are new. */
        for (let marker of newMarkers) {
            let mapSize = this.rustplus.info.correctedMapSize;
            let pos = Map.getPos(marker.x, marker.y, mapSize, this.rustplus);

            marker.location = pos;
            marker.isHalted = false;

            this.rustplus.sendEvent(
                this.rustplus.notificationSettings.travelingVendorDetectedSetting,
                this.client.intlGet(this.rustplus.guildId, 'travelingVendorSpawnedAt', { location: pos.string }),
                'vendor',
                Constants.COLOR_TRAVELING_VENDOR_LOCATED_AT);

            this.travelingVendors.push(marker);
        }
        
        /* TravelingVendor markers that have left. */
        for (let marker of leftMarkers) {
            this.rustplus.sendEvent(
                this.rustplus.notificationSettings.travelingVendorLeftSetting,
                this.client.intlGet(this.rustplus.guildId, 'travelingVendorLeftMap', { location: marker.location.string }),
                'vendor',
                Constants.COLOR_TRAVELING_VENDOR_LEFT_MAP);

            this.timeSinceTravelingVendorWasOnMap = new Date();

            this.travelingVendors = this.travelingVendors.filter(e => e.id !== marker.id);
        }

        /* TravelingVendor markers that still remains. */
        for (let marker of remainingMarkers) {
            let mapSize = this.rustplus.info.correctedMapSize;
            let pos = Map.getPos(marker.x, marker.y, mapSize, this.rustplus);
            let travelingVendor = this.getMarkerByTypeId(this.types.TravelingVendor, marker.id);

            /* If TravelingVendor is halted */
            if (!this.rustplus.isFirstPoll && !travelingVendor.isHalted) {
                if (marker.x === travelingVendor.x && marker.y === travelingVendor.y) {
                    travelingVendor.isHalted = true;
                    this.rustplus.sendEvent(
                        this.rustplus.notificationSettings.travelingVendorHaltedSetting,
                        this.client.intlGet(this.rustplus.guildId, 'travelingVendorHaltedAt', { location: pos.string }),
                        'vendor',
                        Constants.COLOR_TRAVELING_VENDOR_HALTED);
                }
            }
            /* If TravelingVendor is moving again */
            else if (!this.rustplus.isFirstPoll && travelingVendor.isHalted) {
                if (marker.x !== travelingVendor.x || marker.y !== travelingVendor.y) {
                    travelingVendor.isHalted = false;
                    this.rustplus.sendEvent(
                        this.rustplus.notificationSettings.travelingVendorHaltedSetting,
                        this.client.intlGet(this.rustplus.guildId, 'travelingVendorResumedAt', { location: pos.string }),
                        'vendor',
                        Constants.COLOR_TRAVELING_VENDOR_MOVING);
                }
            }
            travelingVendor.x = marker.x;
            travelingVendor.y = marker.y;
            travelingVendor.location = pos;
        }
    }



    /* Timer notification functions */

    notifyCargoShipEgress(args) {
        let id = args[0];
        let marker = this.getMarkerByTypeId(this.types.CargoShip, id);

        this.rustplus.sendEvent(
            this.rustplus.notificationSettings.cargoShipEgressSetting,
            this.client.intlGet(this.rustplus.guildId, 'cargoShipEntersEgressStage', {
                location: marker.location.string
            }),
            'cargo',
            Constants.COLOR_CARGO_SHIP_ENTERS_EGRESS_STAGE);

        if (this.cargoShipEgressTimers[id]) {
            this.cargoShipEgressTimers[id].stop();
            delete this.cargoShipEgressTimers[id];
        }

        marker.onItsWayOut = true;
    }

    startOilRigCrateTimers(size, oilRigLocation, unlockTimeMs) {
        /* Starts (or restarts) the Locked Crate unlock timer and the hacking countdown
           timers for a single Oil Rig. Timers are keyed by the Oil Rig grid location so
           that several Oil Rigs of the same size run independently of each other. */

        /* If this exact Oil Rig is already being hacked (e.g. a new CH47 arrives),
           stop the previous timers before starting fresh ones. */
        this.stopOilRigCrateTimers(oilRigLocation);

        const unlockTimer = new Timer.timer(
            this.notifyCrateOilRigOpen.bind(this),
            unlockTimeMs,
            size,
            oilRigLocation);
        unlockTimer.start();

        const countdownTimers = [];
        for (const remainingMs of Constants.OIL_RIG_LOCKED_CRATE_COUNTDOWN_TIMES_MS) {
            /* Only schedule countdowns that occur before the crate unlocks. */
            if (remainingMs >= unlockTimeMs) continue;

            const delayMs = unlockTimeMs - remainingMs;
            const timer = new Timer.timer(
                this.notifyCrateOilRigCountdown.bind(this),
                delayMs,
                size,
                oilRigLocation,
                remainingMs);
            timer.start();
            countdownTimers.push(timer);
        }

        this.oilRigCrateTimers[oilRigLocation] = { size: size, unlockTimer: unlockTimer, countdownTimers: countdownTimers };
    }

    stopOilRigCrateTimers(oilRigLocation) {
        /* Stops and removes all timers associated with a single Oil Rig location. */
        const entry = this.oilRigCrateTimers[oilRigLocation];
        if (!entry) return;

        if (entry.unlockTimer) entry.unlockTimer.stop();
        for (const timer of entry.countdownTimers) timer.stop();
        delete this.oilRigCrateTimers[oilRigLocation];
    }

    getActiveOilRigCrateTimers(size) {
        /* Returns an array of { location, unlockTimer } for every currently running
           Locked Crate unlock timer of the given size ('small' or 'large'). */
        const active = [];
        for (const [location, entry] of Object.entries(this.oilRigCrateTimers)) {
            if (entry.size === size && entry.unlockTimer) {
                active.push({ location: location, unlockTimer: entry.unlockTimer });
            }
        }
        return active;
    }

    getOilRigStatuses(size) {
        /* Returns the status of every Oil Rig of the given size ('small' or 'large').
           Each entry: { location, unlockTimer, cratePresent, triggeredAt }.
           - unlockTimer: the running unlock timer (or null if none is active).
           - cratePresent: whether a Locked Crate is currently present at the rig.
           - triggeredAt: the last time Heavy Scientists were called at the rig (or null). */
        const statuses = [];
        for (const oilRig of this.getAllOilRigs()) {
            if (oilRig.size !== size) continue;

            const timerEntry = this.oilRigCrateTimers[oilRig.location];
            const unlockTimer = (timerEntry && timerEntry.size === size && timerEntry.unlockTimer)
                ? timerEntry.unlockTimer : null;

            statuses.push({
                location: oilRig.location,
                unlockTimer: unlockTimer,
                cratePresent: this.oilRigCratePresence[oilRig.location] === true,
                triggeredAt: this.timeSinceOilRigWasTriggered[oilRig.location] || null
            });
        }
        return statuses;
    }

    notifyCrateOilRigOpen(args) {
        let size = args[0];
        let oilRigLocation = args[1];

        const message = size === 'small' ? 'lockedCrateSmallOilRigUnlocked' : 'lockedCrateLargeOilRigUnlocked';
        const color = size === 'small'
            ? Constants.COLOR_LOCKED_CRATE_SMALL_OILRIG_UNLOCKED
            : Constants.COLOR_LOCKED_CRATE_LARGE_OILRIG_UNLOCKED;

        this.rustplus.sendEvent(
            this.rustplus.notificationSettings.lockedCrateOilRigUnlockedSetting,
            this.client.intlGet(this.rustplus.guildId, message, {
                location: oilRigLocation
            }),
            size,
            color,
            this.rustplus.isFirstPoll,
            size === 'small' ? 'locked_crate_small_oil_rig_logo.png' : 'locked_crate_large_oil_rig_logo.png');

        this.stopOilRigCrateTimers(oilRigLocation);
    }

    notifyCrateOilRigCountdown(args) {
        let size = args[0];
        let oilRigLocation = args[1];
        let remainingMs = args[2];

        const time = Timer.secondsToFullScale(remainingMs / 1000);
        const message = size === 'small' ? 'lockedCrateSmallOilRigCountdown' : 'lockedCrateLargeOilRigCountdown';

        this.rustplus.sendEvent(
            this.rustplus.notificationSettings.lockedCrateOilRigCountdownSetting,
            this.client.intlGet(this.rustplus.guildId, message, {
                time: time,
                location: oilRigLocation
            }),
            size,
            Constants.COLOR_LOCKED_CRATE_OILRIG_COUNTDOWN,
            this.rustplus.isFirstPoll,
            size === 'small' ? 'locked_crate_small_oil_rig_logo.png' : 'locked_crate_large_oil_rig_logo.png');
    }

    /* Help functions */

    getClosestMonument(x, y) {
        let minDistance = 1000000;
        let closestMonument = null;
        for (let monument of this.rustplus.map.monuments) {
            let distance = Map.getDistance(x, y, monument.x, monument.y);
            if (distance < minDistance && this.validCrateMonuments.includes(monument.token)) {
                minDistance = distance;
                closestMonument = monument;
            }
        }

        return closestMonument;
    }

    getClosestOilRig(x, y) {
        /* Returns the closest Oil Rig monument within the Locked Crate max distance, else null. */
        let minDistance = Constants.OIL_RIG_LOCKED_CRATE_MAX_DISTANCE;
        let closestOilRig = null;
        for (let monument of this.rustplus.map.monuments) {
            if (monument.token !== 'oil_rig_small' && monument.token !== 'large_oil_rig') continue;

            let distance = Map.getDistance(x, y, monument.x, monument.y);
            if (distance <= minDistance) {
                minDistance = distance;
                closestOilRig = monument;
            }
        }

        return closestOilRig;
    }

    getAllOilRigs() {
        /* Returns an array of all Oil Rig monuments with their size and grid location. */
        const mapSize = this.rustplus.info.correctedMapSize;
        const oilRigs = [];
        for (let monument of this.rustplus.map.monuments) {
            if (monument.token !== 'oil_rig_small' && monument.token !== 'large_oil_rig') continue;

            const pos = Map.getPos(monument.x, monument.y, mapSize, this.rustplus);
            oilRigs.push({
                size: monument.token === 'oil_rig_small' ? 'small' : 'large',
                x: monument.x,
                y: monument.y,
                location: pos.location
            });
        }
        return oilRigs;
    }

    reset() {
        this.players = [];
        this.vendingMachines = [];
        this.ch47s = [];
        this.cargoShips = [];
        this.crates = [];
        this.genericRadiuses = [];
        this.patrolHelicopters = [];
        this.travelingVendors = [];

        for (const [id, timer] of Object.entries(this.cargoShipEgressTimers)) {
            timer.stop();
        }
        this.cargoShipEgressTimers = new Object();

        for (const oilRigLocation of Object.keys(this.oilRigCrateTimers)) {
            this.stopOilRigCrateTimers(oilRigLocation);
        }
        this.oilRigCrateTimers = new Object();
        this.oilRigCratePresence = new Object();
        this.timeSinceOilRigWasTriggered = new Object();

        this.timeSinceCargoShipWasOut = null;
        this.timeSinceCH47WasOut = null;
        this.timeSinceSmallOilRigWasTriggered = null;
        this.timeSinceLargeOilRigWasTriggered = null;
        this.timeSincePatrolHelicopterWasOnMap = null;
        this.timeSincePatrolHelicopterWasDestroyed = null;
        this.timeSinceTravelingVendorWasOnMap = null;

        this.patrolHelicopterDestroyedLocation = null;

        this.knownVendingMachines = [];
        this.subscribedItemsId = [];
        this.foundItems = [];
    }
}

module.exports = MapMarkers;