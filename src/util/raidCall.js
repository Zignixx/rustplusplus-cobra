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
/* Twilio places a real phone call that reads the text aloud: https://www.twilio.com/docs/voice/api/call-resource */
const TWILIO_API = 'https://api.twilio.com/2010-04-01';

function twilioConfigured() {
    const t = Config.raidCall.twilio;
    return !!(t.accountSid && t.authToken && t.from);
}

function escapeXml(text) {
    return `${text}`.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const TEST_COOLDOWN_MS = 60 * 1000;

/* A Telegram username (@name, 5-32 letters, digits or _) or a phone number with country code (+49...) */
function normaliseReceiver(input) {
    let s = `${input || ''}`.trim().replace(/\s+/g, '');
    if (/^\+\d{6,15}$/.test(s)) return s;
    if (/^00\d{6,15}$/.test(s)) return `+${s.slice(2)}`;
    if (!s.startsWith('@')) s = `@${s}`;
    return /^@[A-Za-z0-9_]{5,32}$/.test(s) ? s : null;
}

/**
 *  Raid call: when a Smart Alarm goes off (or the raid alarm plugin fires), call people on Telegram. Discord
 *  bots cannot call users, so this goes through CallMeBot. Receivers come from RPP_RAID_CALL_TELEGRAM and from
 *  /raidcall add (per Discord server); /raidcall turns it on/off and !raidtest in-game places a test call.
 */
class RaidCall {
    constructor() {
        this.client = null;
        this.lastCall = new Object();
        this.lastTest = new Object();
        this.started = false;
    }

    /** Everyone to call for a Discord server: RPP_RAID_CALL_TELEGRAM plus the ones added with /raidcall add */
    receivers(guildId) {
        const instance = this.client && guildId ? this.client.getInstance(guildId) : null;
        const added = instance && Array.isArray(instance.raidCallTelegram) ? instance.raidCallTelegram : [];
        return [...new Set([...Config.raidCall.telegram, ...added])];
    }

    /** Adds a receiver for a Discord server; returns the stored form, or null when the input is not valid */
    addReceiver(guildId, input) {
        const receiver = normaliseReceiver(input);
        if (!receiver) return null;
        const instance = this.client.getInstance(guildId);
        /* Adding a name again with other capitals replaces it (CallMeBot may compare the exact spelling) */
        const list = (Array.isArray(instance.raidCallTelegram) ? instance.raidCallTelegram : [])
            .filter(r => r.toLowerCase() !== receiver.toLowerCase());
        list.push(receiver);
        instance.raidCallTelegram = list;
        this.client.setInstance(guildId, instance);
        return receiver;
    }

    /** Removes a receiver added with /raidcall add; false when it is not in that list */
    removeReceiver(guildId, input) {
        const receiver = normaliseReceiver(input) || `${input || ''}`.trim();
        const instance = this.client.getInstance(guildId);
        const list = Array.isArray(instance.raidCallTelegram) ? instance.raidCallTelegram : [];
        const kept = list.filter(r => r.toLowerCase() !== receiver.toLowerCase());
        if (kept.length === list.length) return false;
        instance.raidCallTelegram = kept;
        this.client.setInstance(guildId, instance);
        return true;
    }

    start(client) {
        this.client = client;
        if (this.started) return;
        this.started = true;
        if (twilioConfigured()) client.log('Raid call', `Phone calls through Twilio from ${Config.raidCall.twilio.from}.`);
        if (Config.raidCall.telegram.length) {
            client.log('Raid call', `Raid calls for ${Config.raidCall.telegram.join(', ')}` +
                (Config.raidCall.alarms.length ? ` (alarms: ${Config.raidCall.alarms.join(', ')})` : ' (all Smart Alarms)'));
        }
        /* Always listen: receivers can also be added later with /raidcall add */
        ApiEvents.on('event', (event) => {
            if (event.type !== 'alarm') return;
            this.onAlarm(event).catch(e => client.log('Raid call', `Failed: ${e && e.message ? e.message : e}`, 'error'));
        });
    }

    /** Twilio is set up: phone numbers get real phone calls */
    get twilioReady() {
        return twilioConfigured();
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
        if (this.receivers(guildId).length === 0 || !this.isEnabled(guildId) || !this.matches(event.name)) return;

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
        await this.call(guildId, text);
    }

    /**
     *  Test call for /raidcall test and !raidtest: calls every receiver even while calls are off, at most once a
     *  minute. Returns the result lines, or a reason string when nothing was called.
     */
    async test(guildId, by = null) {
        if (this.receivers(guildId).length === 0) return 'No receivers yet: add one with /raidcall add in Discord.';
        const now = Date.now();
        if (this.lastTest[guildId] && now - this.lastTest[guildId] < TEST_COOLDOWN_MS) {
            return `A test call was placed less than a minute ago, try again in ${Math.ceil((TEST_COOLDOWN_MS - (now - this.lastTest[guildId])) / 1000)} s.`;
        }
        this.lastTest[guildId] = now;
        return this.call(guildId, `Raid Alarm Test${by ? ` von ${by}` : ''}. Wenn du das hörst, funktioniert der Anruf.`);
    }

    /**
     *  Calls every receiver of the Discord server: phone numbers through Twilio when it is set up, everything
     *  else through CallMeBot (Telegram). Returns one line per receiver for logs and replies.
     */
    async call(guildId, text) {
        const results = [];
        for (const user of this.receivers(guildId)) {
            if (user.startsWith('+') && twilioConfigured()) {
                results.push(`${user} (phone): ${await this.twilioCall(user, text)}`);
                continue;
            }
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
                /* CallMeBot answers with an HTML page; keep its visible text (without scripts) for the log */
                const answer = `${response.data || ''}`
                    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
                    .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
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

    /* A phone call that says the text a few times; the person can hang up any time */
    async twilioCall(to, text) {
        const t = Config.raidCall.twilio;
        const say = `<Say voice="${escapeXml(t.voice)}" language="${escapeXml(t.language)}">${escapeXml(text)}</Say>`;
        const twiml = `<Response>${say}<Pause length="1"/>`.concat(
            Array(Math.max(Config.raidCall.repeat - 1, 0)).fill(`${say}<Pause length="1"/>`).join(''), '</Response>');
        try {
            const response = await Axios.post(`${TWILIO_API}/Accounts/${encodeURIComponent(t.accountSid)}/Calls.json`,
                new URLSearchParams({ To: to, From: t.from, Twiml: twiml, Timeout: '45' }).toString(), {
                    auth: { username: t.accountSid, password: t.authToken },
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    timeout: 30000
                });
            return `call started (${response.data && response.data.status ? response.data.status : 'queued'})`;
        }
        catch (e) {
            const data = e.response && e.response.data ? e.response.data : null;
            /* Twilio explains what is wrong, e.g. an unverified number on a trial account */
            return `failed (${data && data.message ? data.message : (e.response ? `HTTP ${e.response.status}` : e.message)})`;
        }
    }
}

module.exports = new RaidCall();
