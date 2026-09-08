'use strict';

require('dotenv').config();

const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { WebSocketServer, WebSocket } = require('ws');
const { RateLimiterMemory } = require('rate-limiter-flexible');

const config = require('./config');
const logger = require('./src/logger');
const db = require('./src/database');
const auth = require('./src/auth');
const roomManager = require('./src/roomManager');
const proximityEngine = require('./src/proximityEngine');
const signalingRelay = require('./src/signalingRelay');
const permissions  = require('./src/permissions');
const adminApi     = require('./src/adminApi');
const clusterSync  = require('./src/clusterSync');
const discordBridge = require('./src/discordBridge');

// ─── HTTP App ─────────────────────────────────────────────────────────────────

const app = express();
app.use(helmet({ contentSecurityPolicy: false })); // Disable CSP for WebRTC
app.use(cors({
  origin: [
    'https://voicelink.ghoststorieslouis.workers.dev',
    /^https?:\/\/localhost(:\d+)?$/,   // local development
  ],
  credentials: false,
}));
app.use(express.json({ limit: '100kb' }));
app.use(morgan('combined', { stream: { write: m => logger.http(m.trim()) } }));

// Serve web client (static assets)
app.use(express.static(path.join(__dirname, '../web')));

// SPA-style: /voice route and any unknown GET → serve index.html
// Token/UUID/server params are handled client-side by app.js
app.get('/voice', (req, res) => {
  res.sendFile(path.join(__dirname, '../web/index.html'));
});

// Admin dashboard route
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../web/admin/index.html'));
});
app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(__dirname, '../web/admin/index.html'));
});

// ─── REST API ──────────────────────────────────────────────────────────────────

/** Health check */
app.get('/api/health', (req, res) => {
  const stats = roomManager.getStats();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    ...stats,
    cluster: clusterSync.enabled,
    discord: discordBridge.enabled,
    timestamp: Date.now(),
  });
});

/** Get ICE server list for WebRTC */
app.get('/api/ice-servers', (req, res) => {
  res.json({ iceServers: config.iceServers });
});

/** Plugin: Create session for a player who joined the game */
app.post('/api/session', async (req, res) => {
  try {
    const { secret, uuid, username, serverId = 'default', edition = 'java' } = req.body;
    if (!secret || secret !== config.pluginSecret) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!uuid || !username) {
      return res.status(400).json({ error: 'uuid and username required' });
    }

    // Detect Bedrock player (Geyser/Floodgate prefix is '.')
    const detectedEdition = uuid.startsWith('00000000-0000-0000-') ? 'bedrock' : edition;

    const token = await auth.createSession(uuid, username, serverId);

    // Update edition in DB
    await db.upsertPlayer(uuid, username, detectedEdition);

    res.json({
      token,
      preview: token.substring(0, 8).toUpperCase(),
      webUrl: `/voice?token=${token}&uuid=${uuid}&server=${serverId}`,
    });
  } catch (err) {
    logger.error('[API] Session create error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** Plugin: Revoke session when player leaves */
app.delete('/api/session/:uuid', async (req, res) => {
  try {
    const { secret } = req.body;
    if (!secret || secret !== config.pluginSecret) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    await auth.revokeSession(req.params.uuid);

    // Disconnect web client if connected
    const playerWs = playerSockets.get(req.params.uuid);
    if (playerWs && playerWs.readyState === WebSocket.OPEN) {
      sendTo(playerWs, { type: 'SESSION_REVOKED', reason: 'Player left the game' });
      setTimeout(() => playerWs.close(), 1000);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** Plugin: Update position of a single player (fallback REST) */
app.post('/api/position', async (req, res) => {
  const { secret, serverId, players } = req.body;
  if (!secret || secret !== config.pluginSecret) return res.status(403).end();
  proximityEngine.updatePositions(serverId, players);
  res.json({ ok: true });
});

/** Public: Player stats (no auth required) */
app.get('/api/stats/:uuid', async (req, res) => {
  try {
    const stats = await db.getPlayerStats(req.params.uuid);
    if (!stats) return res.status(404).json({ error: 'Player not found' });
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin API
adminApi.init({ playerSockets: null, roomManager, sendTo: null, WebSocket }); // updated after sockets init
app.use('/api/admin', adminApi);

// ─── WebSocket Server ──────────────────────────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// In-memory state (ephemeral — rebuilt per connection)
const pluginSockets = new Map();  // serverId → ws
const playerSockets = new Map();  // uuid → ws
const playerHistoryIds = new Map(); // uuid → session_history.id
const talkingStartTimes = new Map(); // uuid → timestamp when started talking

// Inject live references into adminApi
adminApi._ctx = { playerSockets, roomManager, sendTo, WebSocket };

// Rate limiter for WS messages
const rateLimiter = new RateLimiterMemory({
  points: config.rateLimit.points,
  duration: config.rateLimit.duration,
});

function sendTo(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(msg));
    } catch (e) {
      logger.warn('[WS] sendTo error:', e.message);
    }
  }
}

function broadcastToRoom(roomId, msg, excludeUuid = null) {
  const players = roomManager.getRoomPlayers(roomId);
  for (const p of players) {
    if (p.uuid === excludeUuid) continue;
    const ws = playerSockets.get(p.uuid);
    if (ws) sendTo(ws, msg);
  }
}

// ─── Connection Handler ────────────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.clientType = null; // 'plugin' | 'player'
  ws.uuid = null;
  ws.serverId = null;
  ws.username = null;
  ws.muted = false;
  ws.deafened = false;
  ws.pttMode = false;
  ws.pttActive = false;
  ws.spectator = false;
  ws.role = 'player';
  ws.connectedAt = Date.now();
  ws.remoteAddr = req.socket.remoteAddress;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (rawData) => {
    let msg;
    try {
      msg = JSON.parse(rawData);
    } catch {
      return; // Ignore non-JSON
    }

    if (!msg || typeof msg.type !== 'string') return;

    // Rate limiting (only for player clients after auth)
    if (ws.clientType === 'player') {
      try {
        await rateLimiter.consume(`${ws.uuid}:${ws.serverId}`);
      } catch {
        sendTo(ws, { type: 'ERROR', code: 'RATE_LIMITED', message: 'Too many messages' });
        return;
      }
    }

    try {
      if (ws.clientType === null) {
        await handleHandshake(ws, msg);
      } else if (ws.clientType === 'plugin') {
        await handlePluginMessage(ws, msg);
      } else if (ws.clientType === 'player') {
        await handlePlayerMessage(ws, msg);
      }
    } catch (err) {
      logger.error(`[WS] Message handler error [${ws.uuid || ws.serverId}]:`, err.message);
    }
  });

  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', (err) => {
    logger.error(`[WS] Socket error [${ws.uuid || ws.serverId || ws.remoteAddr}]:`, err.message);
  });
});

// ─── Handshake ─────────────────────────────────────────────────────────────────

async function handleHandshake(ws, msg) {
  if (msg.type === 'PLUGIN_AUTH') {
    if (!msg.secret || msg.secret !== config.pluginSecret) {
      sendTo(ws, { type: 'AUTH_ERROR', reason: 'Invalid plugin secret' });
      ws.close(1008, 'Unauthorized');
      return;
    }
    ws.clientType = 'plugin';
    ws.serverId = msg.serverId || 'default';
    pluginSockets.set(ws.serverId, ws);
    sendTo(ws, {
      type: 'PLUGIN_AUTH_SUCCESS',
      serverId: ws.serverId,
      config: {
        positionInterval: config.positionUpdateInterval,
        voiceRange: config.voice.range,
      },
    });
    logger.info(`[WS] Plugin connected: server=${ws.serverId} from ${ws.remoteAddr}`);
    return;
  }

  if (msg.type === 'PLAYER_AUTH') {
    const session = await auth.validateSession(msg.uuid, msg.token);
    if (!session) {
      sendTo(ws, { type: 'AUTH_ERROR', reason: 'Invalid or expired session token. Run /voicechat in-game to get a new one.' });
      ws.close(1008, 'Unauthorized');
      return;
    }

    // Disconnect existing session for this UUID (tab refresh)
    const existingWs = playerSockets.get(session.uuid);
    if (existingWs && existingWs !== ws && existingWs.readyState === WebSocket.OPEN) {
      sendTo(existingWs, { type: 'KICKED', reason: 'Connected from another tab' });
      existingWs.close();
    }

    ws.clientType = 'player';
    ws.uuid = session.uuid;
    ws.username = session.username;
    ws.serverId = session.serverId;

    playerSockets.set(ws.uuid, ws);
    await db.updateSessionWebSocket(ws.uuid, true);

    // Join room
    const room = roomManager.joinRoom(ws.serverId, ws.uuid, ws.username);

    // Load player settings
    const settings = await db.getPlayerSettings(ws.uuid) || {};
    ws.muted = settings.isMuted || false;
    ws.deafened = settings.isDeafened || false;
    ws.role = settings.role || 'player';

    // Apply force mute if set by admin
    if (settings.forceMuted) {
      ws.muted = true;
    }

    // Record session history
    const histId = await db.recordSessionStart(ws.uuid, ws.username, ws.serverId);
    playerHistoryIds.set(ws.uuid, histId);

    // Send auth success + config
    const roleInfo = permissions.getRole(ws.role);
    const effectiveRange = permissions.getVoiceRange(ws.role, config.voice.range);
    sendTo(ws, {
      type: 'AUTH_SUCCESS',
      uuid: ws.uuid,
      username: ws.username,
      room: { id: room.id, key: room.key },
      settings,
      role: ws.role,
      roleMeta: roleInfo,
      voiceConfig: {
        range: effectiveRange,
        falloff: config.voice.falloff,
        iceServers: config.iceServers,
      },
    });

    // Send current room state
    const roomPlayers = roomManager.getRoomPlayers(room.id);
    sendTo(ws, {
      type: 'ROOM_STATE',
      players: roomPlayers
        .filter(p => p.uuid !== ws.uuid)
        .map(p => {
          const pws = playerSockets.get(p.uuid);
          return {
            uuid: p.uuid,
            username: p.username,
            muted: pws?.muted || false,
            deafened: pws?.deafened || false,
          };
        }),
    });

    // Broadcast new peer to existing players
    broadcastToRoom(room.id, {
      type: 'PEER_JOINED',
      uuid: ws.uuid,
      username: ws.username,
      muted: ws.muted,
      deafened: ws.deafened,
    }, ws.uuid);

    // Tell existing players to initiate offers toward new player
    for (const p of roomPlayers) {
      if (p.uuid === ws.uuid) continue;
      const pws = playerSockets.get(p.uuid);
      if (pws) {
        sendTo(pws, { type: 'INITIATE_OFFER', targetUuid: ws.uuid });
      }
    }

    logger.info(`[WS] Player connected: ${ws.username} (${ws.uuid}) → room ${room.key} [${ws.role}]`);

    // Notify Discord bridge
    discordBridge.onPlayerJoin(ws.uuid, ws.username);

    // Log activity
    db.logVoiceActivity(ws.uuid, ws.username, 'joined', ws.serverId).catch(() => {});

    return;
  }

  // Unknown handshake
  ws.close(1002, 'Expected PLUGIN_AUTH or PLAYER_AUTH');
}

// ─── Plugin Messages ───────────────────────────────────────────────────────────

async function handlePluginMessage(ws, msg) {
  switch (msg.type) {
    case 'POSITION_UPDATE': {
      if (!Array.isArray(msg.players) || msg.players.length === 0) break;

      proximityEngine.updatePositions(ws.serverId, msg.players);

      // Broadcast volume updates to all connected web clients in this server
      const serverRooms = roomManager.getServerRooms(ws.serverId);
      for (const room of serverRooms) {
        const roomPlayers = roomManager.getRoomPlayers(room.id);
        const allUuids = roomPlayers.map(p => p.uuid);

        for (const player of roomPlayers) {
          const pws = playerSockets.get(player.uuid);
          if (!pws || pws.readyState !== WebSocket.OPEN) continue;
          if (pws.deafened) continue; // No need to send volumes if deafened

          const volumes = proximityEngine.calculateVolumes(ws.serverId, player.uuid, allUuids);
          if (volumes.length > 0) {
            sendTo(pws, { type: 'VOLUME_UPDATE', volumes });
          }
        }
      }
      break;
    }

    case 'PLAYER_WORLD_CHANGE': {
      // Player changed dimension — move to different room
      const pws = playerSockets.get(msg.uuid);
      if (pws) {
        const newRoom = roomManager.joinRoom(ws.serverId, msg.uuid, pws.username, msg.world);
        sendTo(pws, { type: 'ROOM_CHANGED', room: { id: newRoom.id, key: newRoom.key } });
      }
      break;
    }

    case 'PING': {
      sendTo(ws, { type: 'PONG', timestamp: msg.timestamp });
      break;
    }
  }
}

// ─── Player Messages ───────────────────────────────────────────────────────────

async function handlePlayerMessage(ws, msg) {
  const room = roomManager.getPlayerRoom(ws.uuid);

  switch (msg.type) {
    // ── WebRTC Signaling ──────────────────────────────────────────────────────
    case 'OFFER':
      signalingRelay.relayOffer(ws.uuid, msg.targetUuid, msg.sdp, playerSockets);
      break;

    case 'ANSWER':
      signalingRelay.relayAnswer(ws.uuid, msg.targetUuid, msg.sdp, playerSockets);
      break;

    case 'ICE_CANDIDATE':
      signalingRelay.relayIceCandidate(ws.uuid, msg.targetUuid, msg.candidate, playerSockets);
      break;

    // ── Voice State ───────────────────────────────────────────────────────────
    case 'MUTE': {
      ws.muted = !!msg.muted;
      if (room) {
        broadcastToRoom(room.id, {
          type: 'PLAYER_STATE',
          uuid: ws.uuid,
          muted: ws.muted,
          deafened: ws.deafened,
        });
      }
      await db.updatePlayerMute(ws.uuid, ws.muted);
      break;
    }

    case 'DEAFEN': {
      ws.deafened = !!msg.deafened;
      if (!ws.deafened) {
        ws.muted = false; // Un-deafen also unmutes
      } else {
        ws.muted = true; // Deafen auto-mutes
      }
      if (room) {
        broadcastToRoom(room.id, {
          type: 'PLAYER_STATE',
          uuid: ws.uuid,
          muted: ws.muted,
          deafened: ws.deafened,
        });
      }
      break;
    }

    case 'PTT_MODE': {
      ws.pttMode = !!msg.enabled;
      break;
    }

    case 'PTT_START': {
      if (!ws.pttMode || ws.muted) break;
      ws.pttActive = true;
      if (room) {
        broadcastToRoom(room.id, { type: 'PLAYER_TALKING', uuid: ws.uuid, talking: true }, ws.uuid);
      }
      break;
    }

    case 'PTT_END': {
      ws.pttActive = false;
      if (room) {
        broadcastToRoom(room.id, { type: 'PLAYER_TALKING', uuid: ws.uuid, talking: false }, ws.uuid);
      }
      break;
    }

    case 'TALKING': {
      // VAD-detected talking state (non-PTT mode)
      if (ws.pttMode || ws.muted || ws.spectator) break;
      const isTalking = !!msg.talking;
      if (room) {
        broadcastToRoom(room.id, {
          type: 'PLAYER_TALKING',
          uuid: ws.uuid,
          talking: isTalking,
        }, ws.uuid);
      }
      // Track talk time
      if (isTalking) {
        talkingStartTimes.set(ws.uuid, Date.now());
      } else {
        const start = talkingStartTimes.get(ws.uuid);
        if (start) {
          const seconds = (Date.now() - start) / 1000;
          db.addTalkTime(ws.uuid, seconds).catch(() => {});
          talkingStartTimes.delete(ws.uuid);
        }
      }
      break;
    }

    // ── Settings ──────────────────────────────────────────────────────────────
    case 'SAVE_SETTINGS': {
      if (msg.settings && typeof msg.settings === 'object') {
        await db.savePlayerSettings(ws.uuid, msg.settings);
        sendTo(ws, { type: 'SETTINGS_SAVED' });
      }
      break;
    }

    case 'GET_SETTINGS': {
      const settings = await db.getPlayerSettings(ws.uuid);
      sendTo(ws, { type: 'SETTINGS', settings });
      break;
    }

    // ── Team Rooms ────────────────────────────────────────────────────────────
    case 'JOIN_TEAM': {
      if (!msg.teamId || !room) break;
      const members = roomManager.joinTeamRoom(ws.uuid, msg.teamId);
      sendTo(ws, { type: 'TEAM_JOINED', teamId: msg.teamId, members });
      // Notify team members of new participant
      for (const memberUuid of members) {
        if (memberUuid === ws.uuid) continue;
        const mws = playerSockets.get(memberUuid);
        if (mws) {
          sendTo(mws, { type: 'TEAM_MEMBER_JOINED', teamId: msg.teamId, uuid: ws.uuid, username: ws.username });
          sendTo(mws, { type: 'INITIATE_OFFER', targetUuid: ws.uuid }); // Re-offer for team
        }
      }
      break;
    }

    case 'LEAVE_TEAM': {
      if (!msg.teamId || !room) break;
      roomManager.leaveTeamRoom(ws.uuid, msg.teamId);
      const remaining = roomManager.getTeamMembers(ws.uuid, msg.teamId);
      for (const memberUuid of remaining) {
        const mws = playerSockets.get(memberUuid);
        if (mws) sendTo(mws, { type: 'TEAM_MEMBER_LEFT', teamId: msg.teamId, uuid: ws.uuid });
      }
      break;
    }

    // ── Ping/Latency ──────────────────────────────────────────────────────────
    case 'PING': {
      sendTo(ws, { type: 'PONG', timestamp: msg.timestamp, serverTime: Date.now() });
      break;
    }

    // ── Spectator Mode ───────────────────────────────────────────────────────
    case 'SPECTATOR_JOIN': {
      ws.spectator = true;
      roomManager.joinAsSpectator(ws.uuid);
      ws.muted = true;
      sendTo(ws, { type: 'SPECTATOR_ACTIVE', spectator: true });
      if (room) {
        broadcastToRoom(room.id, {
          type: 'PLAYER_STATE',
          uuid: ws.uuid,
          muted: true,
          deafened: ws.deafened,
          spectator: true,
        }, ws.uuid);
      }
      logger.info(`[WS] ${ws.username} entered spectator mode`);
      break;
    }

    case 'SPECTATOR_LEAVE': {
      ws.spectator = false;
      roomManager.leaveSpectator(ws.uuid);
      ws.muted = false;
      sendTo(ws, { type: 'SPECTATOR_ACTIVE', spectator: false });
      if (room) {
        broadcastToRoom(room.id, {
          type: 'PLAYER_STATE',
          uuid: ws.uuid,
          muted: ws.muted,
          deafened: ws.deafened,
          spectator: false,
        }, ws.uuid);
      }
      break;
    }

    // ── Player Stats ─────────────────────────────────────────────────────────
    case 'GET_STATS': {
      const stats = await db.getPlayerStats(ws.uuid);
      sendTo(ws, { type: 'STATS', stats });
      break;
    }
  }
}

// ─── Disconnect ────────────────────────────────────────────────────────────────

function handleDisconnect(ws) {
  if (ws.clientType === 'plugin') {
    pluginSockets.delete(ws.serverId);
    logger.info(`[WS] Plugin disconnected: ${ws.serverId}`);
    return;
  }

  if (ws.clientType === 'player') {
    const room = roomManager.getPlayerRoom(ws.uuid);

    if (room) {
      // Notify peers this player left
      broadcastToRoom(room.id, { type: 'PEER_LEFT', uuid: ws.uuid }, ws.uuid);
      roomManager.leaveRoom(ws.uuid);
    }

    playerSockets.delete(ws.uuid);
    proximityEngine.removePlayer(ws.serverId, ws.uuid);

    // Cleanup spectator state
    if (ws.spectator) roomManager.leaveSpectator(ws.uuid);

    // Flush any remaining talk time
    const talkStart = talkingStartTimes.get(ws.uuid);
    if (talkStart) {
      db.addTalkTime(ws.uuid, (Date.now() - talkStart) / 1000).catch(() => {});
      talkingStartTimes.delete(ws.uuid);
    }

    // Record session end
    const histId = playerHistoryIds.get(ws.uuid);
    if (histId) {
      db.recordSessionEnd(histId).catch(() => {});
      playerHistoryIds.delete(ws.uuid);
    }

    db.updateSessionWebSocket(ws.uuid, false).catch(() => {});
    db.logVoiceActivity(ws.uuid, ws.username || '?', 'left', ws.serverId || 'default').catch(() => {});

    // Notify Discord bridge
    discordBridge.onPlayerLeave(ws.uuid, ws.username || '?');

    logger.info(`[WS] Player disconnected: ${ws.username} (${ws.uuid})`);
  }
}

// ─── Heartbeat (detect stale connections) ─────────────────────────────────────

const heartbeatInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      logger.warn(`[WS] Terminating stale connection: ${ws.uuid || ws.serverId}`);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, config.heartbeatInterval);

wss.on('close', () => clearInterval(heartbeatInterval));

// ─── Periodic Cleanup ──────────────────────────────────────────────────────────

setInterval(() => {
  db.cleanupExpired().catch(() => {});
}, 3600 * 1000); // Every hour

// ─── Startup ───────────────────────────────────────────────────────────────────

async function start() {
  logger.info('[Gateway] Starting Minecraft Voice Chat Gateway...');

  try {
    await db.initialize();
  } catch (err) {
    logger.error('[Gateway] Database initialization failed:', err.message);
    logger.warn('[Gateway] Running without database — sessions will not persist');
  }

  // Init optional subsystems
  await clusterSync.init();
  await discordBridge.init();

  server.listen(config.port, () => {
    logger.info(`[Gateway] ✓ HTTP server listening on port ${config.port}`);
    logger.info(`[Gateway] ✓ WebSocket endpoint: ws://localhost:${config.port}/ws`);
    logger.info(`[Gateway] ✓ Web client: http://localhost:${config.port}/`);
    logger.info(`[Gateway] ✓ Admin dashboard: http://localhost:${config.port}/admin`);
    logger.info(`[Gateway] ✓ Voice range: ${config.voice.range} blocks`);
    logger.info(`[Gateway] ✓ Proximity falloff: ${config.voice.falloff}`);
    logger.info(`[Gateway] ✓ Cluster sync: ${clusterSync.enabled ? 'enabled' : 'disabled'}`);
    logger.info(`[Gateway] ✓ Discord bridge: ${discordBridge.enabled ? 'enabled' : 'disabled'}`);
    logger.info(`[Gateway] Environment: ${config.nodeEnv}`);
  });
}

start().catch(err => {
  logger.error('[Gateway] Fatal startup error:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('[Gateway] SIGTERM received, shutting down gracefully...');
  clearInterval(heartbeatInterval);
  server.close(async () => {
    await db.close();
    process.exit(0);
  });
});

module.exports = { app, server, wss };
