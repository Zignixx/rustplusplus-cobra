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

/* Tolerate tokens pasted with surrounding quotes or a "Bearer " prefix (e.g. RPP_X="abc" in docker-compose). */
function cleanToken(value) {
    return (value || '').trim().replace(/^(['"])(.*)\1$/, '$2').replace(/^Bearer\s+/i, '').trim();
}

module.exports = {
    general: {
        language: process.env.RPP_LANGUAGE || 'en',
        pollingIntervalMs: process.env.RPP_POLLING_INTERVAL || 10000,
        showCallStackError: process.env.RPP_LOG_CALL_STACK || false,
        reconnectIntervalMs: process.env.RPP_RECONNECT_INTERVAL || 15000,
        debugMapMarkers: process.env.RPP_DEBUG_MAP_MARKERS === 'true', /* Write every new map marker to logs/markers-debug.log */
    },
    discord: {
        username: process.env.RPP_DISCORD_USERNAME || 'rustplusplus',
        clientId: process.env.RPP_DISCORD_CLIENT_ID || '',
        token: process.env.RPP_DISCORD_TOKEN || '',
        needAdminPrivileges: process.env.RPP_NEED_ADMIN_PRIVILEGES || true, /* If true, only admins can delete (server, switch..), manage credentials and reset a channel */
    },
    api: {
        /* HTTP API for dashboards (read-only except Battlemetrics trackers), disabled while RPP_API_TOKEN is empty. */
        token: cleanToken(process.env.RPP_API_TOKEN),
        port: parseInt(process.env.RPP_API_PORT) || 24343,
        host: process.env.RPP_API_HOST || '0.0.0.0',
        /* While a dashboard is connected, team and map marker positions are polled this often (2 Rust+ tokens
           each time). 0 disables it; positions then update with the normal polling interval. */
        liveIntervalMs: process.env.RPP_API_LIVE_INTERVAL === undefined ? 2000 :
            (parseInt(process.env.RPP_API_LIVE_INTERVAL) > 0 ? Math.max(parseInt(process.env.RPP_API_LIVE_INTERVAL), 1000) : 0),
        /* The server's own player list (public Valve query, no password) is read this often for the trackers.
           0 disables it. */
        serverQueryIntervalMs: process.env.RPP_SERVER_QUERY_INTERVAL === undefined ? 60000 :
            (parseInt(process.env.RPP_SERVER_QUERY_INTERVAL) > 0 ? Math.max(parseInt(process.env.RPP_SERVER_QUERY_INTERVAL), 15000) : 0)
    },
    battlemetrics: {
        token: cleanToken(process.env.RPP_BATTLEMETRICS_TOKEN)
    },
    raidCall: {
        /* Telegram call (CallMeBot) when a Smart Alarm goes off: Telegram usernames (@name) or phone numbers
           (+49...), comma separated. Empty = off. */
        telegram: (process.env.RPP_RAID_CALL_TELEGRAM || '').split(',').map(e => e.trim()).filter(e => e.length > 0),
        /* Only alarms whose name contains one of these words (comma separated); empty = every Smart Alarm */
        alarms: (process.env.RPP_RAID_CALL_ALARMS || '').split(',').map(e => e.trim()).filter(e => e.length > 0),
        /* No new call within this many seconds after the last one */
        cooldownSeconds: parseInt(process.env.RPP_RAID_CALL_COOLDOWN) >= 0 ? parseInt(process.env.RPP_RAID_CALL_COOLDOWN) : 180,
        /* Voice of the spoken text (Google TTS voice name) and how often it is repeated in the call */
        lang: process.env.RPP_RAID_CALL_LANG || 'de-DE-Standard-A',
        repeat: Math.min(Math.max(parseInt(process.env.RPP_RAID_CALL_REPEAT) || 2, 1), 5),
        /* Real phone calls through Twilio for receivers that are phone numbers (+49...). Without these, phone
           numbers are called through CallMeBot (Telegram) like usernames. */
        twilio: {
            accountSid: (process.env.RPP_TWILIO_ACCOUNT_SID || '').trim(),
            authToken: (process.env.RPP_TWILIO_AUTH_TOKEN || '').trim(),
            /* The Twilio number that calls, in international format (+1..., +49...) */
            from: (process.env.RPP_TWILIO_FROM || '').trim(),
            /* Voice and language of the spoken text (Twilio <Say>) */
            voice: process.env.RPP_TWILIO_VOICE || 'Polly.Vicki',
            language: process.env.RPP_TWILIO_LANGUAGE || 'de-DE'
        }
    }
};
