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

const EventEmitter = require('events');

const MAX_RECENT_EVENTS = 100;

/* Collects notifications (map events, alarms, team activity, team chat) per guild for the HTTP API and lets the API
   push them to stream subscribers. Publishing is cheap and never throws, so call sites in the bot don't need guards. */
class ApiEvents extends EventEmitter {
    constructor() {
        super();
        this.setMaxListeners(0);
        this.recent = new Object();
        this.nextId = 1;
    }

    /**
     *  Publish a notification.
     *  @param {string} guildId The guild the event belongs to.
     *  @param {string} type event | alarm | connection | death | chat
     *  @param {object} data Event specific fields, should contain a human readable `text`.
     */
    publish(guildId, type, data = {}) {
        try {
            const event = Object.assign({ id: this.nextId++, guildId: guildId, type: type, time: Date.now() }, data);

            if (!this.recent.hasOwnProperty(guildId)) this.recent[guildId] = [];
            this.recent[guildId].unshift(event);
            if (this.recent[guildId].length > MAX_RECENT_EVENTS) this.recent[guildId].length = MAX_RECENT_EVENTS;

            this.emit('event', event);
        }
        catch (e) { /* The API must never break the bot. */ }
    }

    /* Called after every completed poll of a rustplus instance, so stream subscribers get a fresh state. */
    pollFinished(guildId) {
        try {
            this.emit('poll', guildId);
        }
        catch (e) { /* The API must never break the bot. */ }
    }

    getRecent(guildId, limit = MAX_RECENT_EVENTS) {
        return (this.recent[guildId] || []).slice(0, limit);
    }
}

module.exports = new ApiEvents();
