'use strict';

/**
 * adminApi.js — Express router for Admin Dashboard REST endpoints
 *
 * Authentication: POST /api/admin/login → returns JWT
 * All other routes require: Authorization: Bearer <jwt>
 */

const express = require('express');
const crypto  = require('crypto');
const config  = require('../config');
const logger  = require('./logger');
const db      = require('./database');
const permissions = require('./permissions');

const router = express.Router();

// ─── Simple JWT (no external library needed for HS256) ───────────────────────

function base64url(buf) {
  return buf.toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}

function signJwt(payload) {
  const header  = base64url(Buffer.from(JSON.stringify({ alg:'HS256', typ:'JWT' })));
  const body    = base64url(Buffer.from(JSON.stringify({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 8 * 3600, // 8h
  })));
  const sig = base64url(
    crypto.createHmac('sha256', config.admin.jwtSecret)
          .update(`${header}.${body}`)
          .digest()
  );
  return `${header}.${body}.${sig}`;
}

function verifyJwt(token) {
  try {
    const [header, body, sig] = token.split('.');
    const expected = base64url(
      crypto.createHmac('sha256', config.admin.jwtSecret)
            .update(`${header}.${body}`)
            .digest()
    );
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64').toString());
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const payload = verifyJwt(auth.slice(7));
  if (!payload || payload.role !== 'admin') return res.status(401).json({ error: 'Unauthorized' });
  req.admin = payload;
  next();
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

/** POST /api/admin/login — exchange password for JWT */
router.post('/login', (req, res) => {
  const { secret } = req.body;
  if (!secret || secret !== config.admin.secret) {
    logger.warn(`[Admin] Failed login attempt from ${req.ip}`);
    return res.status(403).json({ error: 'Invalid admin secret' });
  }
  const token = signJwt({ role: 'admin', ip: req.ip });
  logger.info(`[Admin] Login successful from ${req.ip}`);
  res.json({ token, expiresIn: 8 * 3600 });
});

/** GET /api/admin/verify — check token validity */
router.get('/verify', requireAdmin, (req, res) => {
  res.json({ ok: true, admin: req.admin });
});

// ─── Stats ────────────────────────────────────────────────────────────────────

/** GET /api/admin/stats — real-time gateway statistics */
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    // playerSockets & roomManager are injected via init()
    const { playerSockets, roomManager, startTime } = router._ctx;
    const stats = roomManager.getStats();
    const rooms = [];
    for (const [id, room] of roomManager.rooms) {
      rooms.push({
        id,
        key:    room.key,
        server: room.serverId,
        world:  room.world,
        players: room.players.size,
      });
    }

    const onlineSessions = await db.getOnlineSessions().catch(() => []);

    res.json({
      uptime:        process.uptime(),
      memoryMb:      Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      totalRooms:    stats.totalRooms,
      totalPlayers:  stats.totalPlayers,
      wsConnections: playerSockets.size,
      rooms,
      onlineSessions,
      timestamp:     Date.now(),
    });
  } catch (err) {
    logger.error('[Admin] Stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Players ──────────────────────────────────────────────────────────────────

/** GET /api/admin/players — list all currently voice-connected players */
router.get('/players', requireAdmin, async (req, res) => {
  try {
    const { playerSockets, roomManager } = router._ctx;
    const players = [];
    for (const [uuid, ws] of playerSockets) {
      const room = roomManager.getPlayerRoom(uuid);
      players.push({
        uuid,
        username:  ws.username,
        serverId:  ws.serverId,
        room:      room?.key || null,
        muted:     ws.muted,
        deafened:  ws.deafened,
        role:      ws.role || 'player',
        spectator: ws.spectator || false,
        connectedAt: ws.connectedAt,
        remoteAddr: ws.remoteAddr,
      });
    }
    res.json({ players, total: players.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/admin/mute/:uuid — force mute a player */
router.post('/mute/:uuid', requireAdmin, async (req, res) => {
  const { uuid } = req.params;
  const { muted = true } = req.body;
  const { playerSockets, sendTo } = router._ctx;

  try {
    await db.forceMutePlayer(uuid, muted);
    const ws = playerSockets.get(uuid);
    if (ws) {
      ws.muted = muted;
      sendTo(ws, {
        type: 'FORCE_MUTE',
        muted,
        reason: muted ? 'Force muted by admin' : 'Unmuted by admin',
      });
      logger.info(`[Admin] Force ${muted ? 'muted' : 'unmuted'} ${ws.username} (${uuid})`);
    }

    await db.logVoiceActivity(uuid, 'unknown', muted ? 'force_muted' : 'force_unmuted', 'admin',
      { actor: 'admin', admin: req.admin.ip });

    res.json({ ok: true, uuid, muted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/admin/kick/:uuid — kick player from voice chat */
router.post('/kick/:uuid', requireAdmin, async (req, res) => {
  const { uuid } = req.params;
  const { reason = 'Kicked by admin' } = req.body;
  const { playerSockets, sendTo, WebSocket } = router._ctx;

  try {
    const ws = playerSockets.get(uuid);
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendTo(ws, { type: 'KICKED', reason });
      setTimeout(() => ws.close(), 1000);
      logger.info(`[Admin] Kicked ${ws.username} (${uuid}) — ${reason}`);
    }

    await db.logVoiceActivity(uuid, 'unknown', 'kicked', 'admin',
      { reason, actor: 'admin', admin: req.admin.ip });

    res.json({ ok: true, uuid, reason });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/admin/role/:uuid — change player role */
router.post('/role/:uuid', requireAdmin, async (req, res) => {
  const { uuid } = req.params;
  const { role } = req.body;

  if (!permissions.isValidRole(role)) {
    return res.status(400).json({ error: `Invalid role. Valid: ${permissions.validRoles.join(', ')}` });
  }

  try {
    await db.setPlayerRole(uuid, role);
    const { playerSockets, sendTo } = router._ctx;
    const ws = playerSockets.get(uuid);
    if (ws) {
      ws.role = role;
      sendTo(ws, { type: 'ROLE_UPDATED', role, meta: permissions.getRole(role) });
    }
    logger.info(`[Admin] Set role ${role} for ${uuid}`);
    res.json({ ok: true, uuid, role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Activity Logs ────────────────────────────────────────────────────────────

/** GET /api/admin/logs?limit=100&offset=0&uuid= — voice activity logs */
router.get('/logs', requireAdmin, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 100, 500);
    const offset = parseInt(req.query.offset) || 0;
    const uuid   = req.query.uuid || null;
    const logs   = await db.getVoiceActivityLogs(limit, offset, uuid);
    res.json({ logs, total: logs.length, limit, offset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Player Stats ─────────────────────────────────────────────────────────────

/** GET /api/admin/player/:uuid/stats */
router.get('/player/:uuid/stats', requireAdmin, async (req, res) => {
  try {
    const stats = await db.getPlayerStats(req.params.uuid);
    if (!stats) return res.status(404).json({ error: 'Player not found' });
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Init (inject runtime context) ───────────────────────────────────────────

router.init = function(ctx) {
  router._ctx = ctx; // { playerSockets, roomManager, sendTo, WebSocket }
};

module.exports = router;
