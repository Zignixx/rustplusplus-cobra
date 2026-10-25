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

const Utils = require('../util/utils.js');

const CACHE_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 50;
const RUST_GAME_NAME = 'Rust';
const RUST_APP_ID = '252490';
const STEAM_API = 'https://api.steampowered.com';

/* Friend lists by profile url, so repeated checks (dashboard refresh) don't hit Steam every time. */
const cache = new Map();

/**
 *  Steam profile url from what a user pastes: a profile link (/profiles/<id> or /id/<name>), a SteamID64 or a
 *  custom url name. Returns null when it is none of those.
 */
function profileUrl(input) {
    const s = `${input || ''}`.trim();
    if (/^\d{17}$/.test(s)) return `https://steamcommunity.com/profiles/${s}`;
    const m = s.match(/steamcommunity\.com\/(profiles|id)\/([^/?#\s]+)/i);
    if (m) {
        let part = m[2];
        try { part = decodeURIComponent(part); } catch (e) { /* keep as is */ }
        if (m[1].toLowerCase() === 'profiles' && !/^\d{17}$/.test(part)) return null;
        return `https://steamcommunity.com/${m[1].toLowerCase()}/${encodeURIComponent(part)}`;
    }
    if (/^[A-Za-z0-9_-]{2,32}$/.test(s)) return `https://steamcommunity.com/id/${s}`;
    return null;
}

/* The public friends page lists every friend with SteamID, name, online state and the game being played. */
function parseFriendsPage(html) {
    const profile = { steamId: null, name: null, url: null };
    const data = html.match(/g_rgProfileData = (\{.*?\});/);
    if (data) {
        try {
            const json = JSON.parse(data[1]);
            profile.steamId = json.steamid || null;
            profile.name = json.personaname || null;
            profile.url = json.url || null;
        }
        catch (e) { /* ignore */ }
    }

    const friends = [];
    const blocks = html.split(/(?=<div[^>]*class="selectable friend_block_v2)/).slice(1);
    for (const block of blocks) {
        const steamId = (block.match(/data-steamid="(\d{17})"/) || [])[1];
        const name = (block.match(/<div class="friend_block_content">([^<]*)<br/) || [])[1];
        if (!steamId || name === undefined) continue;
        const state = (block.match(/friend_block_v2 persona ([a-z-]+)/) || [])[1] || 'offline';
        const game = (block.match(/<span class="friend_game_link">([^<]*)<\/span>/) || [])[1];
        const avatar = (block.match(/<img src="([^"]+)"/) || [])[1];
        friends.push({
            steamId: steamId,
            name: Utils.decodeHtml(name.trim()),
            state: state,
            game: game ? Utils.decodeHtml(game.trim()) : null,
            avatar: avatar || null
        });
    }

    return {
        profile: profile,
        private: friends.length === 0 && /profile_private_info|friends_private/.test(html),
        friends: friends
    };
}

/* With a Steam Web API key: the official friend list and player summaries (names, state, current game). */
async function getFriendsWithKey(url, key) {
    const get = (path, params) => Axios.get(`${STEAM_API}${path}`, { params: Object.assign({ key: key }, params), timeout: 15000 });

    let steamId = (url.match(/\/profiles\/(\d{17})$/) || [])[1];
    try {
        if (!steamId) {
            const vanity = decodeURIComponent(url.split('/id/')[1]);
            const res = await get('/ISteamUser/ResolveVanityURL/v1/', { vanityurl: vanity });
            if (!res.data || !res.data.response || res.data.response.success !== 1) return { error: 'notFound' };
            steamId = res.data.response.steamid;
        }

        let ids = [];
        let isPrivate = false;
        try {
            const res = await get('/ISteamUser/GetFriendList/v1/', { steamid: steamId, relationship: 'friend' });
            ids = ((res.data && res.data.friendslist && res.data.friendslist.friends) || []).map(f => f.steamid);
        }
        catch (e) {
            /* 401: the friend list is private */
            if (e.response && e.response.status === 401) isPrivate = true;
            else if (e.response && e.response.status === 403) return { error: 'badKey' };
            else throw e;
        }

        const summaries = new Object();
        const all = [steamId, ...ids];
        for (let i = 0; i < all.length; i += 100) {
            const res = await get('/ISteamUser/GetPlayerSummaries/v2/', { steamids: all.slice(i, i + 100).join(',') });
            for (const p of (res.data && res.data.response && res.data.response.players) || []) summaries[p.steamid] = p;
        }

        const me = summaries[steamId] || {};
        return {
            profile: { steamId: steamId, name: me.personaname || null, url: me.profileurl || url },
            private: isPrivate,
            friends: ids.map(id => summaries[id]).filter(p => p).map(p => ({
                steamId: p.steamid,
                name: p.personaname || '',
                state: p.gameid ? 'in-game' : (p.personastate > 0 ? 'online' : 'offline'),
                game: p.gameid === RUST_APP_ID ? RUST_GAME_NAME : (p.gameextrainfo || null),
                avatar: p.avatarmedium || null
            }))
        };
    }
    catch (e) {
        if (e.response && e.response.status === 403) return { error: 'badKey' };
        return { error: 'unreachable' };
    }
}

/**
 *  Friends of a Steam profile. With an API key the Steam Web API is used, without one the public friends page.
 *  Either way the friend list has to be public (except for the key owner's own list).
 */
async function getFriends(input, apiKey = null) {
    const url = profileUrl(input);
    if (!url) return { error: 'invalid' };

    const key = apiKey && /^[A-Fa-f0-9]{32}$/.test(`${apiKey}`.trim()) ? `${apiKey}`.trim() : null;
    if (apiKey && !key) return { error: 'badKey' };
    const cacheKey = `${key ? 'api' : 'page'}:${url}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.data;

    if (key) {
        const data = await getFriendsWithKey(url, key);
        if (data.error) return data;
        data.source = 'api';
        data.fetchedAt = Date.now();
        if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
        cache.set(cacheKey, { at: Date.now(), data: data });
        return data;
    }

    let response;
    try {
        response = await Axios.get(`${url}/friends/`, {
            timeout: 15000,
            maxRedirects: 5,
            headers: { 'Accept-Language': 'en-US,en;q=0.8' },
            responseType: 'text'
        });
    }
    catch (e) {
        return { error: 'unreachable' };
    }
    if (response.status !== 200 || typeof response.data !== 'string') return { error: 'unreachable' };
    if (/The specified profile could not be found/.test(response.data)) return { error: 'notFound' };

    const data = Object.assign(parseFriendsPage(response.data), { source: 'page', fetchedAt: Date.now() });
    if (!data.profile.url) data.profile.url = url;
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(cacheKey, { at: Date.now(), data: data });
    return data;
}

const STATUS_CACHE_MS = 60 * 1000;
const statusCache = new Map();
/* Steam persona states: 0 offline, 1 online, 2 busy, 3 away, 4 snooze, 5 looking to trade, 6 looking to play */
const PERSONA_STATES = ['offline', 'online', 'online', 'away', 'away', 'online', 'online'];

function xmlTag(xml, tag) {
    const m = xml.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`));
    return m ? m[1].trim() : null;
}

/* Online state of one profile from its public XML (no API key needed) */
async function statusFromXml(url) {
    let response;
    try {
        response = await Axios.get(`${url}?xml=1`, { timeout: 15000, responseType: 'text' });
    }
    catch (e) {
        return { error: 'unreachable' };
    }
    const xml = `${response.data || ''}`;
    if (xmlTag(xml, 'error')) return { error: 'notFound' };
    const steamId = xmlTag(xml, 'steamID64');
    if (!steamId) return { error: 'unreachable' };
    const online = xmlTag(xml, 'onlineState') || 'offline';
    const game = xmlTag(xml, 'gameName');
    const state = online === 'in-game' ? 'in-game' : online === 'online' ? 'online' : 'offline';
    return {
        steamId: steamId,
        name: Utils.decodeHtml(xmlTag(xml, 'steamID') || ''),
        avatar: xmlTag(xml, 'avatarMedium'),
        state: /away|snooze/i.test(xmlTag(xml, 'stateMessage') || '') && state === 'online' ? 'away' : state,
        game: game ? Utils.decodeHtml(game) : null,
        private: xmlTag(xml, 'privacyState') !== 'public'
    };
}

/**
 *  Online state of several Steam profiles (links, SteamID64s or custom URL names): offline, online, away or
 *  in-game with the game. One API call for all with a key, one public profile request each without. Results
 *  are cached for a minute.
 */
async function getStatuses(inputs, apiKey = null) {
    const key = apiKey && /^[A-Fa-f0-9]{32}$/.test(`${apiKey}`.trim()) ? `${apiKey}`.trim() : null;
    if (apiKey && !key) return { error: 'badKey' };

    const results = inputs.map(input => ({ input: `${input}`, url: profileUrl(input) }));
    const now = Date.now();
    const pending = results.filter(r => {
        if (!r.url) { r.status = { error: 'invalid' }; return false; }
        const cached = statusCache.get(r.url);
        if (cached && now - cached.at < STATUS_CACHE_MS) { r.status = cached.data; return false; }
        return true;
    });

    if (key && pending.length > 0) {
        const get = (path, params) => Axios.get(`${STEAM_API}${path}`, { params: Object.assign({ key: key }, params), timeout: 15000 });
        try {
            for (const r of pending) {
                r.steamId = (r.url.match(/\/profiles\/(\d{17})$/) || [])[1];
                if (r.steamId) continue;
                const res = await get('/ISteamUser/ResolveVanityURL/v1/', { vanityurl: decodeURIComponent(r.url.split('/id/')[1]) });
                if (res.data && res.data.response && res.data.response.success === 1) r.steamId = res.data.response.steamid;
                else r.status = { error: 'notFound' };
            }
            const ids = pending.filter(r => r.steamId).map(r => r.steamId);
            const summaries = new Object();
            for (let i = 0; i < ids.length; i += 100) {
                const res = await get('/ISteamUser/GetPlayerSummaries/v2/', { steamids: ids.slice(i, i + 100).join(',') });
                for (const p of (res.data && res.data.response && res.data.response.players) || []) summaries[p.steamid] = p;
            }
            for (const r of pending) {
                if (!r.steamId) continue;
                const p = summaries[r.steamId];
                if (!p) { r.status = { error: 'notFound' }; continue; }
                r.status = {
                    steamId: p.steamid,
                    name: p.personaname || '',
                    avatar: p.avatarmedium || null,
                    state: p.gameid ? 'in-game' : (PERSONA_STATES[p.personastate] || 'offline'),
                    game: p.gameid === RUST_APP_ID ? RUST_GAME_NAME : (p.gameextrainfo || null),
                    private: p.communityvisibilitystate !== 3,
                    lastLogoff: p.lastlogoff ? p.lastlogoff * 1000 : null
                };
            }
        }
        catch (e) {
            if (e.response && e.response.status === 403) return { error: 'badKey' };
            for (const r of pending) if (!r.status) r.status = { error: 'unreachable' };
        }
    }
    else {
        for (const r of pending) r.status = await statusFromXml(r.url);
    }

    for (const r of pending) if (r.status && !r.status.error) statusCache.set(r.url, { at: now, data: r.status });
    if (statusCache.size > 500) statusCache.clear();

    return {
        source: key ? 'api' : 'page',
        players: results.map(r => Object.assign({ input: r.input }, r.status, r.status && r.status.steamId ? {
            playingRust: r.status.state === 'in-game' && r.status.game === RUST_GAME_NAME,
            profileUrl: `https://steamcommunity.com/profiles/${r.status.steamId}`
        } : {}))
    };
}

/* Names compared case-insensitively, also without invisible characters and extra spaces. */
function normName(name) {
    return `${name || ''}`.normalize('NFKC').toLowerCase().replace(/[​-‍﻿]/g, '')
        .replace(/\s+/g, ' ').trim();
}

/* Spellings of a name to compare: as is, without a leading clan tag ("[TAG] name") and the name part of
   "TAG | name", reduced to letters and digits. */
function nameVariants(name) {
    const n = normName(name);
    const variants = new Set([n]);
    const untagged = n.replace(/^[[({<][^\])}>]{1,12}[\])}>]\s*/, '');
    /* "TAG | name": the part after the last bar is the name; the tag alone must not match other clan members */
    const parts = untagged.split('|');
    for (const v of [untagged, parts[parts.length - 1]]) {
        const core = v.replace(/[^\p{L}\p{N}]+/gu, '');
        if (core) variants.add(core);
    }
    return [...variants].filter(v => v.length > 0);
}

function coreName(name) {
    return normName(name).replace(/[^\p{L}\p{N}]+/gu, '');
}

function levenshtein(a, b, max) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        let rowMin = i;
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            if (cur[j] < rowMin) rowMin = cur[j];
        }
        if (rowMin > max) return max + 1;
        prev = cur;
    }
    return prev[b.length];
}

/**
 *  How alike two player names are, 0..1. 1 = same name (ignoring case and spacing); also compares the names
 *  without clan tags and symbols, and counts a name contained in the other (e.g. with an added clan tag).
 *  Returns 0 below `min`, so callers can skip work early.
 */
function similarity(a, b, min = 0) {
    return similarityOf(prepareName(a), prepareName(b), min);
}

/* Normalized name and its variants, computed once per name when comparing many names. */
function prepareName(name) {
    return { n: normName(name), variants: nameVariants(name) };
}

function similarityOf(a, b, min = 0) {
    if (!a.n || !b.n) return 0;
    if (a.n === b.n) return 1;
    let best = 0;
    for (const x of a.variants) {
        for (const y of b.variants) {
            if (x === y) { best = Math.max(best, 0.97); continue; }
            const long = Math.max(x.length, y.length);
            const short = Math.min(x.length, y.length);
            if (short >= 4 && (x.includes(y) || y.includes(x))) best = Math.max(best, 0.8 + 0.15 * (short / long));
            const maxDist = Math.floor(long * (1 - Math.max(min, best)) + 1e-9);
            if (long - short > maxDist) continue;
            const d = levenshtein(x, y, maxDist);
            if (d <= maxDist) best = Math.max(best, 1 - d / long);
        }
    }
    return best >= min ? best : 0;
}

module.exports = {
    RUST_GAME_NAME: RUST_GAME_NAME,
    profileUrl: profileUrl,
    parseFriendsPage: parseFriendsPage,
    getFriends: getFriends,
    getStatuses: getStatuses,
    normName: normName,
    coreName: coreName,
    similarity: similarity,
    prepareName: prepareName,
    similarityOf: similarityOf
};
