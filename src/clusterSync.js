'use strict';

/**
 * clusterSync.js — Multi-server synchronization via Redis pub/sub
 *
 * Enables multiple Gateway instances (e.g., for BungeeCord/Velocity networks)
 * to share player positions and state events in real-time.
 *
 * OPTIONAL: If Redis is unavailable or CLUSTER_ENABLED=false, all methods
 * become no-ops and the gateway runs in standalone mode.
 */

const config = require('../config');
const logger = require('./logger');

const CHANNELS = {
  POSITIONS:    'vc:positions',
  PLAYER_STATE: 'vc:player_state',
  ROOM_EVENTS:  'vc:room_events',
  ADMIN:        'vc:admin',
};

class ClusterSync {
  constructor() {
    this.enabled   = false;
    this.pub       = null; // Publisher client
    this.sub       = null; // Subscriber client
    this.handlers  = new Map(); // channel → Set of handlers
    this.instanceId = `gw-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  }

  async init() {
    if (!config.cluster.enabled) {
      logger.info('[Cluster] Disabled — running in standalone mode');
      return;
    }

    try {
      // Dynamically require ioredis so it's optional
      let Redis;
      try {
        Redis = require('ioredis');
      } catch {
        logger.warn('[Cluster] ioredis not installed — install with: npm install ioredis');
        logger.warn('[Cluster] Falling back to standalone mode');
        return;
      }

      this.pub = new Redis(config.cluster.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 3 });
      this.sub = new Redis(config.cluster.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 3 });

      await Promise.all([this.pub.connect(), this.sub.connect()]);

      this.enabled = true;
      logger.info(`[Cluster] Redis connected — instance: ${this.instanceId}`);

      // Subscribe to all channels
      await this.sub.subscribe(...Object.values(CHANNELS));

      this.sub.on('message', (channel, rawMsg) => {
        try {
          const msg = JSON.parse(rawMsg);
          // Ignore own messages
          if (msg._instanceId === this.instanceId) return;
          const set = this.handlers.get(channel);
          if (set) set.forEach(h => h(msg));
        } catch {
          // Ignore malformed messages
        }
      });

      this.pub.on('error', (err) => logger.warn('[Cluster] Redis pub error:', err.message));
      this.sub.on('error', (err) => logger.warn('[Cluster] Redis sub error:', err.message));

    } catch (err) {
      logger.warn('[Cluster] Failed to connect to Redis:', err.message);
      logger.warn('[Cluster] Continuing in standalone mode');
      this.enabled = false;
    }
  }

  // ─── Publish ──────────────────────────────────────────────────────────────

  publish(channel, data) {
    if (!this.enabled || !this.pub) return;
    const msg = JSON.stringify({ ...data, _instanceId: this.instanceId, _ts: Date.now() });
    this.pub.publish(channel, msg).catch(err => {
      logger.warn('[Cluster] Publish error:', err.message);
    });
  }

  publishPositions(serverId, players) {
    this.publish(CHANNELS.POSITIONS, { type: 'POSITIONS', serverId, players });
  }

  publishPlayerState(uuid, username, serverId, state) {
    this.publish(CHANNELS.PLAYER_STATE, { type: 'PLAYER_STATE', uuid, username, serverId, ...state });
  }

  publishRoomEvent(event, data) {
    this.publish(CHANNELS.ROOM_EVENTS, { type: event, ...data });
  }

  publishAdminAction(action, data) {
    this.publish(CHANNELS.ADMIN, { type: action, ...data });
  }

  // ─── Subscribe ────────────────────────────────────────────────────────────

  on(channel, handler) {
    if (!this.handlers.has(channel)) this.handlers.set(channel, new Set());
    this.handlers.get(channel).add(handler);
  }

  onPositions(handler)    { this.on(CHANNELS.POSITIONS, handler); }
  onPlayerState(handler)  { this.on(CHANNELS.PLAYER_STATE, handler); }
  onRoomEvent(handler)    { this.on(CHANNELS.ROOM_EVENTS, handler); }
  onAdminAction(handler)  { this.on(CHANNELS.ADMIN, handler); }

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  async close() {
    if (this.pub) await this.pub.quit().catch(() => {});
    if (this.sub) await this.sub.quit().catch(() => {});
  }
}

module.exports = new ClusterSync();
