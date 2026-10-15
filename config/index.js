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
        /* Read-only HTTP API for dashboards, disabled while RPP_API_TOKEN is empty. */
        token: cleanToken(process.env.RPP_API_TOKEN),
        port: parseInt(process.env.RPP_API_PORT) || 24343,
        host: process.env.RPP_API_HOST || '0.0.0.0'
    },
    battlemetrics: {
        token: cleanToken(process.env.RPP_BATTLEMETRICS_TOKEN)
    }
};
