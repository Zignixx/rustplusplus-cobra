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

const Dgram = require('dgram');

/* Valve server query (A2S), the public protocol every Steam game server answers without a password:
   https://developer.valvesoftware.com/wiki/Server_queries */

const SINGLE = 0xFFFFFFFF;
const SPLIT = 0xFFFFFFFE;
const A2S_PLAYER = 0x55;
const S2A_PLAYER = 0x44;
const S2C_CHALLENGE = 0x41;

function request(type, challenge) {
    const buf = Buffer.alloc(9);
    buf.writeUInt32LE(SINGLE, 0);
    buf.writeUInt8(type, 4);
    buf.writeInt32LE(challenge, 5);
    return buf;
}

/* Players: index, name, score, duration (seconds connected). The count byte overflows on servers with more than
   255 players, so the list is read until the packet ends. */
function parsePlayers(buf) {
    let offset = 6; /* header (4) + type (1) + count (1) */
    const players = [];
    while (offset < buf.length) {
        offset += 1; /* index, always 0 on most servers */
        const end = buf.indexOf(0, offset);
        if (end === -1) break;
        const name = buf.toString('utf8', offset, end);
        offset = end + 1;
        if (offset + 8 > buf.length) break;
        const score = buf.readInt32LE(offset);
        const duration = buf.readFloatLE(offset + 4);
        offset += 8;
        players.push({ name: name, score: score, seconds: Math.max(0, Math.round(duration)) });
    }
    return players;
}

/**
 *  The player list of a game server.
 *  @returns {Promise<Array<{name, score, seconds}>>} rejects on timeout or a malformed answer
 */
function queryPlayers(host, port, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        const socket = Dgram.createSocket('udp4');
        const parts = new Map();
        let total = 0;
        let done = false;
        const finish = (err, value) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { socket.close(); } catch (e) { /* already closed */ }
            if (err) reject(err);
            else resolve(value);
        };
        const timer = setTimeout(() => finish(new Error('timeout')), timeoutMs);

        const handle = (packet) => {
            if (packet.length < 5) return finish(new Error('short packet'));
            const type = packet.readUInt8(4);
            if (type === S2C_CHALLENGE && packet.length >= 9) {
                socket.send(request(A2S_PLAYER, packet.readInt32LE(5)), port, host);
            }
            else if (type === S2A_PLAYER) {
                finish(null, parsePlayers(packet));
            }
            else {
                finish(new Error(`unexpected answer 0x${type.toString(16)}`));
            }
        };

        socket.on('error', err => finish(err));
        socket.on('message', (msg) => {
            if (msg.length < 4) return;
            const header = msg.readUInt32LE(0);
            if (header === SINGLE) return handle(msg);
            if (header !== SPLIT || msg.length < 12) return finish(new Error('unknown packet'));

            /* Source split packet: id (4), total (1), number (1), max size (2), payload */
            const id = msg.readUInt32LE(4);
            if (id & 0x80000000) return finish(new Error('compressed answers are not supported'));
            total = msg.readUInt8(8);
            parts.set(msg.readUInt8(9), msg.subarray(12));
            if (parts.size === total) {
                const whole = Buffer.concat([...Array(total).keys()].map(i => parts.get(i) || Buffer.alloc(0)));
                handle(whole);
            }
        });

        socket.send(request(A2S_PLAYER, -1), port, host, err => { if (err) finish(err); });
    });
}

module.exports = {
    queryPlayers: queryPlayers,
    parsePlayers: parsePlayers
};
