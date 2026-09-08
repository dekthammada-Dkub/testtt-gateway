'use strict';

/**
 * discordBridge.js — Discord Voice Chat Bridge (optional)
 *
 * Bridges Minecraft proximity voice chat with a Discord voice channel.
 * When enabled:
 *   - Notifies Discord text channel when players join/leave voice
 *   - Allows Discord members to hear Minecraft chat (text-to-voice notification)
 *   - Supports !vclink <minecraft_uuid> to link Discord ↔ Minecraft accounts
 *
 * Requires: npm install discord.js
 * Set DISCORD_BRIDGE_ENABLED=true and DISCORD_BOT_TOKEN in .env
 */

const config = require('../config');
const logger = require('./logger');
const db     = require('./database');

class DiscordBridge {
  constructor() {
    this.enabled = false;
    this.client  = null;
    this.guild   = null;
    this.voiceChannel  = null;
    this.textChannel   = null; // Optional status text channel
    this.onlinePlayers = new Map(); // uuid → { username, joinedAt }
  }

  async init() {
    if (!config.discord.enabled || !config.discord.botToken) {
      logger.info('[Discord] Bridge disabled (set DISCORD_BRIDGE_ENABLED=true to enable)');
      return;
    }

    let Client, GatewayIntentBits, Events;
    try {
      ({ Client, GatewayIntentBits, Events } = require('discord.js'));
    } catch {
      logger.warn('[Discord] discord.js not installed. Run: npm install discord.js');
      logger.warn('[Discord] Bridge disabled');
      return;
    }

    try {
      this.client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.GuildVoiceStates,
          GatewayIntentBits.MessageContent,
        ],
      });

      this.client.once(Events.ClientReady, async (c) => {
        logger.info(`[Discord] Logged in as ${c.user.tag}`);
        await this._setupGuild();
        this.enabled = true;
      });

      this.client.on(Events.MessageCreate, (msg) => this._handleMessage(msg));
      this.client.on(Events.VoiceStateUpdate, (oldState, newState) =>
        this._handleVoiceState(oldState, newState));
      this.client.on(Events.Error, (err) => logger.warn('[Discord] Error:', err.message));

      await this.client.login(config.discord.botToken);
    } catch (err) {
      logger.warn('[Discord] Failed to initialize:', err.message);
    }
  }

  async _setupGuild() {
    try {
      this.guild = await this.client.guilds.fetch(config.discord.guildId);
      if (config.discord.voiceChannelId) {
        this.voiceChannel = await this.guild.channels.fetch(config.discord.voiceChannelId);
      }
    } catch (err) {
      logger.warn('[Discord] Guild/channel setup failed:', err.message);
    }
  }

  // ─── Message Handler ──────────────────────────────────────────────────────

  async _handleMessage(msg) {
    if (msg.author.bot) return;
    if (!msg.content.startsWith('!vc')) return;

    const [cmd, ...args] = msg.content.slice(1).split(/\s+/);

    if (cmd === 'vclink') {
      const minecraftUuid = args[0];
      if (!minecraftUuid || !minecraftUuid.match(/^[0-9a-f-]{36}$/i)) {
        return msg.reply('❌ Usage: `!vclink <minecraft-uuid>`\nGet your UUID with `/voicechat` in-game.');
      }
      try {
        await db.setDiscordLink(minecraftUuid, msg.author.id, msg.author.tag);
        msg.reply(`✅ Linked to Minecraft UUID \`${minecraftUuid}\`!`);
        logger.info(`[Discord] Linked ${msg.author.tag} → ${minecraftUuid}`);
      } catch (err) {
        msg.reply('❌ Failed to link account. Please try again.');
      }
    }

    if (cmd === 'vcunlink') {
      const link = await db.getDiscordLinkByDiscordId(msg.author.id);
      if (!link) return msg.reply('❌ No linked Minecraft account found.');
      await db.removeDiscordLink(link.uuid);
      msg.reply('✅ Account unlinked.');
    }

    if (cmd === 'vcstatus') {
      const online = Array.from(this.onlinePlayers.values());
      if (online.length === 0) return msg.reply('🎙 No players in Minecraft voice chat.');
      const list = online.map(p => `• **${p.username}**`).join('\n');
      msg.reply(`🎙 **Players in Voice Chat (${online.size}):**\n${list}`);
    }
  }

  // ─── Voice State Handler ──────────────────────────────────────────────────

  async _handleVoiceState(oldState, newState) {
    // Discord member joined our voice channel
    if (newState.channelId === config.discord.voiceChannelId && !oldState.channelId) {
      const link = await db.getDiscordLinkByDiscordId(newState.id);
      if (link) {
        logger.info(`[Discord] ${newState.member?.displayName} (linked) joined voice`);
      }
    }
  }

  // ─── Public API (called from server.js) ──────────────────────────────────

  /** Called when a Minecraft player joins voice */
  onPlayerJoin(uuid, username) {
    this.onlinePlayers.set(uuid, { username, joinedAt: Date.now() });
    this._notifyText(`🎙 **${username}** joined Minecraft voice chat`);
  }

  /** Called when a Minecraft player leaves voice */
  onPlayerLeave(uuid, username) {
    const entry = this.onlinePlayers.get(uuid);
    this.onlinePlayers.delete(uuid);
    if (entry) {
      const mins = Math.round((Date.now() - entry.joinedAt) / 60000);
      this._notifyText(`🔇 **${username}** left voice chat (was online ${mins}m)`);
    }
  }

  /** Broadcast an important event to the Discord text channel */
  _notifyText(message) {
    if (!this.enabled || !this.textChannel) return;
    this.textChannel.send(message).catch(() => {});
  }

  async close() {
    if (this.client) await this.client.destroy().catch(() => {});
  }
}

module.exports = new DiscordBridge();
