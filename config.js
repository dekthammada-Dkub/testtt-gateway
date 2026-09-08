'use strict';

require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  pluginSecret: process.env.PLUGIN_SECRET || 'change_this_to_a_strong_random_secret_key',

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 3306,
    database: process.env.DB_NAME || 'vc_minecraft',
    user: process.env.DB_USER || 'vcuser',
    password: process.env.DB_PASS || 'vcpassword',
    poolMin: parseInt(process.env.DB_POOL_MIN) || 2,
    poolMax: parseInt(process.env.DB_POOL_MAX) || 10,
    connectTimeout: 10000,
    waitForConnections: true,
    queueLimit: 0,
  },

  voice: {
    range: parseFloat(process.env.VOICE_RANGE) || 32,
    falloff: parseFloat(process.env.PROXIMITY_FALLOFF) || 1.5,
    maxPlayersPerRoom: parseInt(process.env.MAX_PLAYERS_PER_ROOM) || 100,
  },

  iceServers: (() => {
    try {
      return JSON.parse(process.env.ICE_SERVERS || '[]');
    } catch {
      return [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ];
    }
  })(),

  rateLimit: {
    points: parseInt(process.env.RATE_LIMIT_POINTS) || 100,
    duration: parseInt(process.env.RATE_LIMIT_DURATION) || 60,
  },

  logLevel: process.env.LOG_LEVEL || 'info',

  heartbeatInterval: 30000,
  positionUpdateInterval: 250,
  sessionTtlSeconds: 3600,

  // Admin Dashboard
  admin: {
    secret:     process.env.ADMIN_SECRET || 'change_this_admin_password',
    jwtSecret:  process.env.ADMIN_JWT_SECRET || 'change_this_jwt_secret_random',
    jwtExpires: process.env.ADMIN_JWT_EXPIRES || '8h',
  },

  // Redis / Multi-Server Cluster (optional)
  cluster: {
    enabled:  process.env.CLUSTER_ENABLED === 'true',
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  // Discord Bridge (optional)
  discord: {
    enabled:        process.env.DISCORD_BRIDGE_ENABLED === 'true',
    botToken:       process.env.DISCORD_BOT_TOKEN || '',
    guildId:        process.env.DISCORD_GUILD_ID || '',
    voiceChannelId: process.env.DISCORD_VOICE_CHANNEL_ID || '',
  },
};
