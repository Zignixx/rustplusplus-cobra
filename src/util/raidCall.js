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

const Axios = require('axios');

const ApiEvents = require('../api/apiEvents.js');
const Config = require('../../config');

/* CallMeBot places a real Telegram voice call that reads the text aloud: https://www.callmebot.com
   Each receiver has to allow it once by sending /start to @CallMeBot_txtbot in Telegram. */
const CALLMEBOT_URL = 'https://api.callmebot.com/start.php';

/**
 *  Raid call: when a Smart Alarm goes off (or the raid alarm plugin fires), call the configured people on
 *  Telegram. Discord bots cannot call users, so this goes through CallMeBot. Configured with RPP_RAID_CALL_*;
 *  /raidcall turns it on/off per Discord server and places a test call.
 */
class RaidCall {
    constructor() {
        this.client = null;
        this.lastCall = new Object();
        this.started = false;
    }

    get configured() {
        return Config.raidCall.telegram.length > 0;
    }

    start(client) {
        this.client = client;
        if (this.started) return;
        this.started = true;
        if (!this.configured) return;
        client.log('Raid call', `Telegram raid calls are on for ${Config.raidCall.telegram.join(', ')}` +
            (Config.raidCall.alarms.length ? ` (alarms: ${Config.raidCall.alarms.join(', ')})` : ' (all Smart Alarms)'));
        ApiEvents.on('event', (event) => {
            if (event.type !== 'alarm') return;
            this.onAlarm(event).catch(e => client.log('Raid call', `Failed: ${e && e.message ? e.message : e}`, 'error'));
        });
    }

    isEnabled(guildId) {
        const instance = this.client ? this.client.getInstance(guildId) : null;
        return !instance || instance.raidCallEnabled !== false;
    }

    setEnabled(guildId, enabled) {
        const instance = this.client.getInstance(guildId);
        instance.raidCallEnabled = enabled;
        this.client.setInstance(guildId, instance);
    }

    /* Only alarms whose name contains one of RPP_RAID_CALL_ALARMS (all alarms when it is empty) */
    matches(name) {
        if (Config.raidCall.alarms.length === 0) return true;
        const n = `${name || ''}`.toLowerCase();
        return Config.raidCall.alarms.some(a => n.includes(a.toLowerCase()));
    }

    async onAlarm(event) {
        const guildId = event.guildId;
        if (!this.isEnabled(guildId) || !this.matches(event.name)) return;

        /* One call per cooldown: alarms often fire several times in a row during a raid */
        const now = Date.now();
        if (this.lastCall[guildId] && now - this.lastCall[guildId] < Config.raidCall.cooldownSeconds * 1000) {
            this.client.log('Raid call', `Alarm "${event.name}" within the cooldown, no new call.`);
            return;
        }
        this.lastCall[guildId] = now;

        const rustplus = this.client.rustplusInstances ? this.client.rustplusInstances[guildId] : null;
        const server = rustplus && rustplus.info ? rustplus.info.name : null;
        const sentence = t => (/[.!?]$/.test(t) ? t : `${t}.`);
        const text = sentence(`Raid Alarm! ${event.name || 'Smart Alarm'}` +
            (event.text && event.text !== event.name ? `: ${event.text}` : '')) +
            (server ? ` Server ${server}.` : '');
        await this.call(text);
    }

    /** Calls everyone in RPP_RAID_CALL_TELEGRAM; returns one line per receiver for logs and /raidcall test */
    async call(text) {
        const results = [];
        for (const user of Config.raidCall.telegram) {
            try {
                const response = await Axios.get(CALLMEBOT_URL, {
                    params: {
                        user: user,
                        text: text.slice(0, 256),
                        lang: Config.raidCall.lang,
                        rpt: Config.raidCall.repeat
                    },
                    timeout: 30000,
                    responseType: 'text'
                });
                /* CallMeBot answers with a small HTML page; keep its text for the log */
                const answer = `${response.data || ''}`.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
                results.push(`${user}: ${answer || `HTTP ${response.status}`}`);
            }
            catch (e) {
                const status = e.response ? `HTTP ${e.response.status}` : (e.message || `${e}`);
                results.push(`${user}: failed (${status})`);
            }
        }
        for (const line of results) this.client.log('Raid call', line);
        return results;
    }
}

module.exports = new RaidCall();
