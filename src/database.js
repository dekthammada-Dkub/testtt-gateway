'use strict';

const mysql = require('mysql2/promise');
const config = require('../config');
const logger = require('./logger');

class Database {
  constructor() {
    this.pool = null;
  }

  async initialize() {
    this.pool = mysql.createPool({
      host: config.db.host,
      port: config.db.port,
      database: config.db.database,
      user: config.db.user,
      password: config.db.password,
      waitForConnections: config.db.waitForConnections,
      connectionLimit: config.db.poolMax,
      queueLimit: config.db.queueLimit,
      connectTimeout: config.db.connectTimeout,
      charset: 'utf8mb4',
      timezone: '+00:00',
    });

    // Test connection
    try {
      const conn = await this.pool.getConnection();
      logger.info('[DB] MySQL connected successfully');
      conn.release();
    } catch (err) {
      logger.error('[DB] Connection failed:', err.message);
      throw err;
    }

    await this._runMigrations();
  }

  async _runMigrations() {
    const fs = require('fs');
    const path = require('path');
    const schemaPath = path.join(__dirname, '../db/schema.sql');
    if (!fs.existsSync(schemaPath)) return;

    const sql = fs.readFileSync(schemaPath, 'utf8');
    const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0 && !s.startsWith('--'));
    const conn = await this.pool.getConnection();
    try {
      for (const stmt of statements) {
        try {
          await conn.query(stmt);
        } catch (e) {
          if (!e.message.includes('already exists') && !e.message.includes('Duplicate')) {
            logger.warn('[DB] Migration warning:', e.message);
          }
        }
      }
      logger.info('[DB] Schema migrations applied');
    } finally {
      conn.release();
    }
  }

  // ─── Sessions ────────────────────────────────────────────────────────────

  async createSession(uuid, username, token, serverId, expiresAt, ipAddress = null) {
    await this.pool.query(
      `INSERT INTO sessions (uuid, username, token, server_id, expires_at, ip_address)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE token = VALUES(token), username = VALUES(username),
         expires_at = VALUES(expires_at), revoked = 0, ws_connected = 0`,
      [uuid, username, token, serverId, expiresAt, ipAddress]
    );
    // Ensure player row exists
    await this.upsertPlayer(uuid, username);
  }

  async getSession(uuid, token) {
    const [rows] = await this.pool.query(
      `SELECT * FROM sessions
       WHERE uuid = ? AND token = ? AND revoked = 0 AND expires_at > NOW()
       LIMIT 1`,
      [uuid, token]
    );
    return rows[0] || null;
  }

  async getSessionByUuid(uuid) {
    const [rows] = await this.pool.query(
      `SELECT * FROM sessions WHERE uuid = ? AND revoked = 0 AND expires_at > NOW() LIMIT 1`,
      [uuid]
    );
    return rows[0] || null;
  }

  async revokeSession(uuid) {
    await this.pool.query(`UPDATE sessions SET revoked = 1 WHERE uuid = ?`, [uuid]);
  }

  async updateSessionWebSocket(uuid, connected) {
    await this.pool.query(
      `UPDATE sessions SET ws_connected = ? WHERE uuid = ?`,
      [connected ? 1 : 0, uuid]
    );
  }

  // ─── Players ─────────────────────────────────────────────────────────────

  async upsertPlayer(uuid, username, edition = 'java') {
    await this.pool.query(
      `INSERT INTO players (uuid, username, edition) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE username = VALUES(username), updated_at = NOW()`,
      [uuid, username, edition]
    );
  }

  async getPlayer(uuid) {
    const [rows] = await this.pool.query(
      `SELECT * FROM players WHERE uuid = ? LIMIT 1`,
      [uuid]
    );
    return rows[0] || null;
  }

  async getPlayerSettings(uuid) {
    const player = await this.getPlayer(uuid);
    if (!player) return null;
    return {
      micGain:          player.mic_gain,
      outputGain:       player.output_gain,
      voiceRange:       player.voice_range,
      isMuted:          !!player.is_muted,
      isDeafened:       !!player.is_deafened,
      noiseSuppression: !!player.noise_suppression,
      echoCancellation: !!player.echo_cancellation,
      autoGainControl:  !!player.auto_gain_control,
      pttEnabled:       !!player.ptt_enabled,
      pttKey:           player.ptt_key,
      deafenKey:        player.deafen_key,
      muteKey:          player.mute_key,
      deviceInputId:    player.device_input_id,
      deviceOutputId:   player.device_output_id,
      role:             player.role || 'player',
      forceMuted:       !!player.force_muted,
    };
  }

  async savePlayerSettings(uuid, settings) {
    const fields = {
      mic_gain:          settings.micGain,
      output_gain:       settings.outputGain,
      voice_range:       settings.voiceRange,
      is_muted:          settings.isMuted ? 1 : 0,
      noise_suppression: settings.noiseSuppression ? 1 : 0,
      echo_cancellation: settings.echoCancellation ? 1 : 0,
      auto_gain_control: settings.autoGainControl ? 1 : 0,
      ptt_enabled:       settings.pttEnabled ? 1 : 0,
      ptt_key:           settings.pttKey,
      deafen_key:        settings.deafenKey,
      mute_key:          settings.muteKey,
      device_input_id:   settings.deviceInputId || null,
      device_output_id:  settings.deviceOutputId || null,
    };

    const validFields = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null) validFields[k] = v;
    }

    if (Object.keys(validFields).length === 0) return;

    const setClause = Object.keys(validFields).map(k => `\`${k}\` = ?`).join(', ');
    const values = [...Object.values(validFields), uuid];
    await this.pool.query(`UPDATE players SET ${setClause} WHERE uuid = ?`, values);
  }

  async updatePlayerMute(uuid, muted) {
    await this.pool.query(`UPDATE players SET is_muted = ? WHERE uuid = ?`, [muted ? 1 : 0, uuid]);
  }

  // ─── Positions ───────────────────────────────────────────────────────────

  async upsertPositions(serverId, players) {
    if (!players || players.length === 0) return;
    const values = players.map(p => [p.uuid, serverId, p.world || 'world', p.x, p.y, p.z]);
    await this.pool.query(
      `INSERT INTO player_positions (uuid, server_id, world, x, y, z)
       VALUES ?
       ON DUPLICATE KEY UPDATE world = VALUES(world), x = VALUES(x), y = VALUES(y), z = VALUES(z), updated_at = NOW(3)`,
      [values]
    );
  }

  // ─── Roles ───────────────────────────────────────────────────────────

  async getPlayerRole(uuid) {
    if (!this.pool) return 'player';
    const [rows] = await this.pool.query(
      `SELECT role FROM players WHERE uuid = ? LIMIT 1`, [uuid]
    );
    return rows[0]?.role || 'player';
  }

  async setPlayerRole(uuid, role) {
    if (!this.pool) return;
    await this.pool.query(
      `UPDATE players SET role = ? WHERE uuid = ?`, [role, uuid]
    );
  }

  async forceMutePlayer(uuid, forceMuted, actorUuid = null) {
    if (!this.pool) return;
    await this.pool.query(
      `UPDATE players SET force_muted = ?, mute_count = mute_count + ? WHERE uuid = ?`,
      [forceMuted ? 1 : 0, forceMuted ? 1 : 0, uuid]
    );
  }

  // ─── Stats ───────────────────────────────────────────────────────────

  async incrementSessionCount(uuid) {
    if (!this.pool) return;
    await this.pool.query(
      `UPDATE players SET session_count = session_count + 1 WHERE uuid = ?`, [uuid]
    );
  }

  async addTalkTime(uuid, seconds) {
    if (!this.pool || seconds <= 0) return;
    await this.pool.query(
      `UPDATE players SET total_talk_seconds = total_talk_seconds + ? WHERE uuid = ?`,
      [Math.floor(seconds), uuid]
    );
  }

  async getPlayerStats(uuid) {
    if (!this.pool) return null;
    const player = await this.getPlayer(uuid);
    if (!player) return null;

    const [recent] = await this.pool.query(
      `SELECT join_time, leave_time, duration_s FROM session_history
       WHERE uuid = ? ORDER BY join_time DESC LIMIT 5`,
      [uuid]
    );

    return {
      uuid,
      username:          player.username,
      role:              player.role || 'player',
      totalTalkSeconds:  player.total_talk_seconds || 0,
      sessionCount:      player.session_count || 0,
      muteCount:         player.mute_count || 0,
      recentSessions:    recent,
      createdAt:         player.created_at,
    };
  }

  async getOnlineSessions() {
    if (!this.pool) return [];
    const [rows] = await this.pool.query(
      `SELECT s.uuid, s.username, s.server_id, s.created_at,
              p.role, p.is_muted, p.force_muted, p.session_count
       FROM sessions s
       LEFT JOIN players p ON p.uuid = s.uuid
       WHERE s.ws_connected = 1 AND s.revoked = 0 AND s.expires_at > NOW()
       ORDER BY s.created_at DESC`
    );
    return rows;
  }

  // ─── Activity Log ────────────────────────────────────────────────────

  async logVoiceActivity(uuid, username, action, serverId = 'default', metadata = null) {
    if (!this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO voice_activity_log (uuid, username, action, server_id, metadata)
         VALUES (?, ?, ?, ?, ?)`,
        [uuid, username, action, serverId, metadata ? JSON.stringify(metadata) : null]
      );
    } catch (e) {
      logger.warn('[DB] logVoiceActivity error:', e.message);
    }
  }

  async getVoiceActivityLogs(limit = 100, offset = 0, uuid = null) {
    if (!this.pool) return [];
    let sql = `SELECT * FROM voice_activity_log`;
    const params = [];
    if (uuid) { sql += ` WHERE uuid = ?`; params.push(uuid); }
    sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    const [rows] = await this.pool.query(sql, params);
    return rows;
  }

  // ─── Discord Links ───────────────────────────────────────────────────

  async getDiscordLink(uuid) {
    if (!this.pool) return null;
    const [rows] = await this.pool.query(
      `SELECT * FROM discord_links WHERE uuid = ? LIMIT 1`, [uuid]
    );
    return rows[0] || null;
  }

  async getDiscordLinkByDiscordId(discordId) {
    if (!this.pool) return null;
    const [rows] = await this.pool.query(
      `SELECT * FROM discord_links WHERE discord_id = ? LIMIT 1`, [discordId]
    );
    return rows[0] || null;
  }

  async setDiscordLink(uuid, discordId, discordTag = null) {
    if (!this.pool) return;
    await this.pool.query(
      `INSERT INTO discord_links (uuid, discord_id, discord_tag)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE discord_id = VALUES(discord_id), discord_tag = VALUES(discord_tag)`,
      [uuid, discordId, discordTag]
    );
  }

  async removeDiscordLink(uuid) {
    if (!this.pool) return;
    await this.pool.query(`DELETE FROM discord_links WHERE uuid = ?`, [uuid]);
  }

  // ─── History ─────────────────────────────────────────────────────────

  async recordSessionStart(uuid, username, serverId) {
    const [result] = await this.pool.query(
      `INSERT INTO session_history (uuid, username, server_id, join_time) VALUES (?, ?, ?, NOW())`,
      [uuid, username, serverId]
    );
    // Increment session counter
    this.incrementSessionCount(uuid).catch(() => {});
    return result.insertId;
  }

  async recordSessionEnd(historyId) {
    await this.pool.query(
      `UPDATE session_history
       SET leave_time = NOW(), duration_s = TIMESTAMPDIFF(SECOND, join_time, NOW())
       WHERE id = ?`,
      [historyId]
    );
  }

  // ─── Cleanup ─────────────────────────────────────────────────────────────

  async cleanupExpired() {
    const [result] = await this.pool.query(
      `DELETE FROM sessions WHERE expires_at < NOW() OR revoked = 1`
    );
    if (result.affectedRows > 0) {
      logger.info(`[DB] Cleaned up ${result.affectedRows} expired sessions`);
    }
  }

  async close() {
    if (this.pool) await this.pool.end();
  }
}

module.exports = new Database();
