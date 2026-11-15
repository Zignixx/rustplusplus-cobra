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

const Builder = require('@discordjs/builders');

const Config = require('../../config');
const DiscordEmbeds = require('../discordTools/discordEmbeds.js');
const RaidCall = require('../util/raidCall.js');

module.exports = {
    name: 'raidcall',

    getData(client, guildId) {
        return new Builder.SlashCommandBuilder()
            .setName('raidcall')
            .setDescription('Telegram call when a Smart Alarm goes off (raid alarm).')
            .addSubcommand(subcommand => subcommand
                .setName('status')
                .setDescription('Show whether raid calls are on and who gets called.'))
            .addSubcommand(subcommand => subcommand
                .setName('on')
                .setDescription('Turn raid calls on for this Discord server.'))
            .addSubcommand(subcommand => subcommand
                .setName('off')
                .setDescription('Turn raid calls off for this Discord server (e.g. while you are online).'))
            .addSubcommand(subcommand => subcommand
                .setName('test')
                .setDescription('Place a test call now.'));
    },

    async execute(client, interaction) {
        const verifyId = Math.floor(100000 + Math.random() * 900000);
        client.logInteraction(interaction, verifyId, 'slashCommand');

        if (!await client.validatePermissions(interaction)) return;
        await interaction.deferReply({ ephemeral: true });

        const guildId = interaction.guildId;
        const sub = interaction.options.getSubcommand();
        const reply = async (text, error = false) => {
            await client.interactionEditReply(interaction, DiscordEmbeds.getActionInfoEmbed(error ? 1 : 0, text));
        };

        if (!RaidCall.configured) {
            await reply('Raid calls are not set up: set RPP_RAID_CALL_TELEGRAM (Telegram @username or phone ' +
                'number) for the bot and restart it. Every receiver has to send /start to @CallMeBot_txtbot ' +
                'in Telegram once.', true);
            return;
        }

        switch (sub) {
            case 'on':
            case 'off': {
                RaidCall.setEnabled(guildId, sub === 'on');
                client.log('Raid call', `Raid calls turned ${sub} for guild ${guildId}.`);
                await reply(`Raid calls are now **${sub}**.`);
            } break;

            case 'test': {
                const results = await RaidCall.call('Test vom Raid Alarm. Wenn du das hörst, funktioniert der Anruf.');
                await reply(`Test call placed:\n${results.map(r => `• ${r}`).join('\n')}`);
            } break;

            default: {
                const alarms = Config.raidCall.alarms.length ? Config.raidCall.alarms.join(', ') : 'every Smart Alarm';
                await reply(`Raid calls are **${RaidCall.isEnabled(guildId) ? 'on' : 'off'}**.\n` +
                    `Calls: ${Config.raidCall.telegram.join(', ')}\n` +
                    `Alarms: ${alarms}\n` +
                    `Cooldown: ${Config.raidCall.cooldownSeconds} s · Voice: ${Config.raidCall.lang}`);
            } break;
        }

        client.log(client.intlGet(null, 'infoCap'), `raidcall ${sub} (verifyId ${verifyId})`);
    },
};
