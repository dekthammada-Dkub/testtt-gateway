'use strict';

const { v4: uuidv4 } = require('uuid');
const logger = require('./logger');

/**
 * In-memory voice room manager.
 * Each server has one or more rooms (one per world by default).
 * Room state is rebuilt from scratch on gateway restart (ephemeral).
 */
class RoomManager {
  constructor() {
    // Map<roomId, Room>
    this.rooms = new Map();
    // Map<uuid, roomId>
    this.playerRooms = new Map();
    // Map<serverId:world, roomId>
    this.serverRoomKeys = new Map();
    // Set<uuid> — spectators (receive but don't transmit)
    this.spectators = new Set();
  }

  /** Get or create a room for a server+world combination */
  getOrCreateRoom(serverId, world = 'world') {
    const key = `${serverId}:${world}`;
    if (this.serverRoomKeys.has(key)) {
      return this.rooms.get(this.serverRoomKeys.get(key));
    }
    const roomId = uuidv4();
    const room = {
      id: roomId,
      key,
      serverId,
      world,
      players: new Map(), // uuid → {uuid, username, joinedAt}
      teamRooms: new Map(), // teamId → Set<uuid>
      createdAt: Date.now(),
    };
    this.rooms.set(roomId, room);
    this.serverRoomKeys.set(key, roomId);
    logger.info(`[RoomManager] Created room ${roomId} for ${key}`);
    return room;
  }

  /** Join player to room (default world room on their server) */
  joinRoom(serverId, uuid, username, world = 'world') {
    // If already in a room, leave first
    if (this.playerRooms.has(uuid)) {
      this.leaveRoom(uuid);
    }
    const room = this.getOrCreateRoom(serverId, world);
    room.players.set(uuid, { uuid, username, joinedAt: Date.now() });
    this.playerRooms.set(uuid, room.id);
    logger.info(`[RoomManager] ${username} joined room ${room.key}`);
    return room;
  }

  /** Remove player from their current room */
  leaveRoom(uuid) {
    const roomId = this.playerRooms.get(uuid);
    if (!roomId) return;
    const room = this.rooms.get(roomId);
    if (room) {
      room.players.delete(uuid);
      // Clean up team rooms
      for (const [, members] of room.teamRooms) {
        members.delete(uuid);
      }
      // Remove empty rooms (but keep if it has 0 players — plugin may reconnect)
    }
    this.playerRooms.delete(uuid);
  }

  /** Get all players in a room */
  getRoomPlayers(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return Array.from(room.players.values());
  }

  /** Get room by player UUID */
  getPlayerRoom(uuid) {
    const roomId = this.playerRooms.get(uuid);
    if (!roomId) return null;
    return this.rooms.get(roomId) || null;
  }

  /** Get default room for a server */
  getServerRoom(serverId, world = 'world') {
    const key = `${serverId}:${world}`;
    const roomId = this.serverRoomKeys.get(key);
    if (!roomId) return null;
    return this.rooms.get(roomId) || null;
  }

  /** Get all rooms for a server (across all worlds) */
  getServerRooms(serverId) {
    return Array.from(this.rooms.values()).filter(r => r.serverId === serverId);
  }

  /** Join a team sub-room within the player's main room */
  joinTeamRoom(uuid, teamId) {
    const room = this.getPlayerRoom(uuid);
    if (!room) return;
    if (!room.teamRooms.has(teamId)) {
      room.teamRooms.set(teamId, new Set());
    }
    room.teamRooms.get(teamId).add(uuid);
    logger.info(`[RoomManager] ${uuid} joined team ${teamId}`);
    return Array.from(room.teamRooms.get(teamId));
  }

  leaveTeamRoom(uuid, teamId) {
    const room = this.getPlayerRoom(uuid);
    if (!room || !room.teamRooms.has(teamId)) return;
    room.teamRooms.get(teamId).delete(uuid);
  }

  getTeamMembers(uuid, teamId) {
    const room = this.getPlayerRoom(uuid);
    if (!room || !room.teamRooms.has(teamId)) return [];
    return Array.from(room.teamRooms.get(teamId));
  }

  // ─── Spectator ────────────────────────────────────────────────────────────

  /** Add a UUID to the spectator set (they hear but don't transmit) */
  joinAsSpectator(uuid) {
    this.spectators.add(uuid);
    logger.info(`[RoomManager] ${uuid} entered spectator mode`);
  }

  leaveSpectator(uuid) {
    this.spectators.delete(uuid);
  }

  isSpectator(uuid) {
    return this.spectators.has(uuid);
  }

  getSpectators(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return Array.from(room.players.keys()).filter(u => this.spectators.has(u));
  }

  getStats() {
    return {
      totalRooms:      this.rooms.size,
      totalPlayers:    this.playerRooms.size,
      totalSpectators: this.spectators.size,
    };
  }
}

module.exports = new RoomManager();
