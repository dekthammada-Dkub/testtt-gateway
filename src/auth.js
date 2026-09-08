'use strict';

const crypto = require('crypto');
const db = require('./database');
const config = require('../config');
const logger = require('./logger');

class Auth {
  /**
   * Called by plugin REST API when a player joins the game.
   * Generates a 64-char hex token valid for sessionTtlSeconds.
   */
  async createSession(uuid, username, serverId = 'default') {
    const token = crypto.randomBytes(32).toString('hex'); // 64 hex chars
    const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1000);

    await db.createSession(uuid, username, token, serverId, expiresAt);
    logger.info(`[Auth] Session created for ${username} (${uuid}) on ${serverId}`);

    return token;
  }

  /**
   * Called during WebSocket handshake from web client.
   */
  async validateSession(uuid, token) {
    if (!uuid || !token || token.length !== 64) return null;
    const session = await db.getSession(uuid, token);
    if (!session) {
      logger.warn(`[Auth] Invalid/expired session for UUID ${uuid}`);
      return null;
    }
    return {
      uuid: session.uuid,
      username: session.username,
      serverId: session.server_id,
    };
  }

  /**
   * Called by plugin REST API when player quits.
   */
  async revokeSession(uuid) {
    await db.revokeSession(uuid);
    logger.info(`[Auth] Session revoked for UUID ${uuid}`);
  }

  /**
   * Generate a short display token to show the player in-game.
   * This is the 8-char prefix for readability.
   */
  static tokenPreview(token) {
    return token.substring(0, 8).toUpperCase();
  }
}

module.exports = new Auth();
