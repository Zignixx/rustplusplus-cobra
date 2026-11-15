# Raid call (Telegram)

Discord bots cannot call people, so the bot calls you on **Telegram** instead when a Smart Alarm goes off. It uses the free service [CallMeBot](https://www.callmebot.com): your phone rings like a normal Telegram call and a voice reads out the alarm, e.g. *"Raid Alarm! Main Base: Your base is under attack! Server Rustafied EU."*

## Setup

1. In Telegram, send `/start` to **@CallMeBot_txtbot** once (from every account that should be called). Without this CallMeBot is not allowed to call you.
2. Add the people to call in Discord, as many as you like: `/raidcall add receiver:@name` (Telegram) or `/raidcall add receiver:+49…` (phone number: a real phone call when Twilio is set up, see below). Alternatively set them for the bot with `RPP_RAID_CALL_TELEGRAM`; both lists are used.
3. Optional settings for the bot:

   | Variable | Default | Meaning |
   | --- | --- | --- |
   | `RPP_RAID_CALL_TELEGRAM` | *(empty)* | Extra receivers for every Discord server: Telegram usernames (`@name`) or phone numbers (`+49…`), comma separated. |
   | `RPP_RAID_CALL_ALARMS` | *(empty)* | Only alarms whose name contains one of these words (comma separated, not case sensitive). Empty = every Smart Alarm. |
   | `RPP_RAID_CALL_COOLDOWN` | `180` | Seconds without a new call after one, since alarms often fire several times during a raid. |
   | `RPP_RAID_CALL_LANG` | `de-DE-Standard-A` | Voice of the spoken text (a Google text-to-speech voice, e.g. `en-GB-Standard-B`). |
   | `RPP_RAID_CALL_REPEAT` | `2` | How often the text is repeated in the call (1–5). |

4. Test it: `/raidcall test` in Discord or **`!raidtest`** in the in-game team chat (at most once a minute).

## Real phone calls with Twilio

For receivers that are **phone numbers** (`+49…`) the bot can place a real phone call through [Twilio](https://www.twilio.com) instead of a Telegram call. This is a paid service (a phone number per month plus a few cents per call), but it does not depend on a free service being busy.

1. Create an account on twilio.com.
2. In the Twilio Console, buy a phone number with **Voice** (Phone Numbers → Buy a number). A US number is the easiest, numbers of some countries need documents first.
3. Allow calls to your country: Voice → Settings → **Geo permissions**, tick e.g. Germany.
4. Trial accounts can only call **verified numbers** (Phone Numbers → Verified Caller IDs) and play a trial notice first that asks you to press a key; add credit to the account to remove both.
5. Set for the bot and restart it:

   | Variable | Example | Meaning |
   | --- | --- | --- |
   | `RPP_TWILIO_ACCOUNT_SID` | `ACxxxxxxxx…` | Account SID (Console start page) |
   | `RPP_TWILIO_AUTH_TOKEN` | | Auth Token (Console start page) |
   | `RPP_TWILIO_FROM` | `+1xxxxxxxxxx` | The Twilio number that calls |
   | `RPP_TWILIO_VOICE` | `Polly.Vicki` | Optional: voice of the spoken text |
   | `RPP_TWILIO_LANGUAGE` | `de-DE` | Optional: language of the spoken text |

6. Add the phone number: `/raidcall add receiver:+491701234567`, then test with `/raidcall test` or `!raidtest`. If Twilio refuses the call, the reply says why (e.g. an unverified number).

Receivers that are Telegram usernames keep getting Telegram calls through CallMeBot.

## What triggers a call

* A Smart Alarm of the connected server goes off.
* A Smart Alarm of another paired server, when the setting for Smart Alarm notifications of other servers (`fcmAlarmNotificationEnabled`) is on.
* The [raid alarm plugin](https://umod.org/plugins/raid-alarm) notification ("You're getting raided!").

The alarm has to reach the bot: pair the Smart Alarm with the bot in-game and wire it to something that detects the raid (e.g. an HBHF sensor or a tripwire).

## Commands

* `/raidcall status`: on or off, who is called, which alarms
* `/raidcall add receiver:…` / `/raidcall remove receiver:…`: who gets called (per Discord server), a phone number or a Telegram @username
* `/raidcall on` / `/raidcall off`: turn calls on or off for this Discord server (e.g. while you are online)
* `/raidcall test` or `!raidtest` in-game: place a test call now (also while calls are off)
