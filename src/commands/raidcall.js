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
                .setName('add')
                .setDescription('Add someone to call: Telegram @username or phone number with country code.')
                .addStringOption(option => option
                    .setName('telegram')
                    .setDescription('@username or +49... (they have to send /start to @CallMeBot_txtbot once)')
                    .setRequired(true)))
            .addSubcommand(subcommand => subcommand
                .setName('remove')
                .setDescription('Remove someone added with /raidcall add.')
                .addStringOption(option => option
                    .setName('telegram')
                    .setDescription('@username or phone number')
                    .setRequired(true)))
            .addSubcommand(subcommand => subcommand
                .setName('on')
                .setDescription('Turn raid calls on for this Discord server.'))
            .addSubcommand(subcommand => subcommand
                .setName('off')
                .setDescription('Turn raid calls off for this Discord server (e.g. while you are online).'))
            .addSubcommand(subcommand => subcommand
                .setName('test')
                .setDescription('Place a test call now (also in-game with !raidtest).'));
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

        switch (sub) {
            case 'add': {
                const added = RaidCall.addReceiver(guildId, interaction.options.getString('telegram'));
                if (!added) {
                    await reply('That is neither a Telegram username (@name, 5-32 letters, digits or _) nor a ' +
                        'phone number with country code (+49...).', true);
                    break;
                }
                client.log('Raid call', `Receiver ${added} added for guild ${guildId}.`);
                await reply(`**${added}** gets raid calls now. They have to send /start to @CallMeBot_txtbot in ` +
                    'Telegram once. Try it with /raidcall test or !raidtest in-game.');
            } break;

            case 'remove': {
                const input = interaction.options.getString('telegram');
                if (RaidCall.removeReceiver(guildId, input)) {
                    client.log('Raid call', `Receiver ${input} removed for guild ${guildId}.`);
                    await reply(`**${input}** gets no raid calls anymore.`);
                }
                else if (Config.raidCall.telegram.some(r => r.toLowerCase() === `${input}`.trim().toLowerCase())) {
                    await reply(`${input} is set in RPP_RAID_CALL_TELEGRAM; remove it there and restart the bot.`, true);
                }
                else {
                    await reply(`${input} is not in the list.`, true);
                }
            } break;

            case 'on':
            case 'off': {
                RaidCall.setEnabled(guildId, sub === 'on');
                client.log('Raid call', `Raid calls turned ${sub} for guild ${guildId}.`);
                await reply(`Raid calls are now **${sub}**.`);
            } break;

            case 'test': {
                const results = await RaidCall.test(guildId, interaction.member ? interaction.member.displayName : null);
                if (typeof results === 'string') await reply(results, true);
                else await reply(`Test call placed:\n${results.map(r => `• ${r}`).join('\n')}`);
            } break;

            default: {
                const receivers = RaidCall.receivers(guildId);
                const alarms = Config.raidCall.alarms.length ? Config.raidCall.alarms.join(', ') : 'every Smart Alarm';
                await reply(`Raid calls are **${RaidCall.isEnabled(guildId) ? 'on' : 'off'}**.\n` +
                    `Calls: ${receivers.length ? receivers.join(', ') : 'nobody yet (add with /raidcall add)'}\n` +
                    `Alarms: ${alarms}\n` +
                    `Cooldown: ${Config.raidCall.cooldownSeconds} s · Voice: ${Config.raidCall.lang}`);
            } break;
        }

        client.log(client.intlGet(null, 'infoCap'), `raidcall ${sub} (verifyId ${verifyId})`);
    },
};
