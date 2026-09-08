'use strict';

const config = require('../config');

/**
 * ProximityEngine — pure in-memory, no I/O.
 * Stores latest positions and computes volume multipliers.
 *
 * Volume model:
 *   distance <= 0            → volume = 1.0 (full)
 *   0 < distance <= voiceRange → volume = (1 - d/range)^falloff
 *   distance > voiceRange    → volume = 0.0 (out of range)
 *
 * Falloff > 1 makes dropoff steeper (more realistic).
 */
class ProximityEngine {
  constructor() {
    // Map<serverId, Map<uuid, {x, y, z, world}>>
    this.positions = new Map();
  }

  /** Update positions from plugin broadcast */
  updatePositions(serverId, players) {
    if (!this.positions.has(serverId)) {
      this.positions.set(serverId, new Map());
    }
    const serverPos = this.positions.get(serverId);
    for (const p of players) {
      serverPos.set(p.uuid, {
        x: p.x,
        y: p.y,
        z: p.z,
        world: p.world || 'world',
        env: p.environment || 'open',
      });
    }
  }

  removePlayer(serverId, uuid) {
    const serverPos = this.positions.get(serverId);
    if (serverPos) serverPos.delete(uuid);
  }

  removeServer(serverId) {
    this.positions.delete(serverId);
  }

  /** Get 3D distance between two players on the same server */
  getDistance(serverId, uuidA, uuidB) {
    const serverPos = this.positions.get(serverId);
    if (!serverPos) return Infinity;
    const a = serverPos.get(uuidA);
    const b = serverPos.get(uuidB);
    if (!a || !b) return Infinity;
    if (a.world !== b.world) return Infinity; // Different dimensions
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Calculate volume for a listener (listenerUuid) relative to all other players.
   * Returns array: [{uuid, volume: 0.0–1.0, distance}]
   */
  calculateVolumes(serverId, listenerUuid, allUuids, voiceRange = null) {
    const range = voiceRange || config.voice.range;
    const falloff = config.voice.falloff;

    return allUuids
      .filter(uuid => uuid !== listenerUuid)
      .map(uuid => {
        const distance = this.getDistance(serverId, listenerUuid, uuid);
        let volume;
        if (distance === Infinity || distance > range) {
          volume = 0;
        } else {
          // Smooth exponential falloff
          volume = Math.pow(1 - distance / range, falloff);
          volume = Math.max(0, Math.min(1, volume));
        }
        
        // Include target player's environment so listener can apply effect
        const targetPos = this.positions.get(serverId)?.get(uuid);
        const env = targetPos ? targetPos.env : 'open';

        return { 
          uuid, 
          volume: parseFloat(volume.toFixed(4)), 
          distance: parseFloat(distance.toFixed(2)),
          env 
        };
      });
  }

  /** Check if two players are within hearing range of each other */
  canHear(serverId, uuidA, uuidB, voiceRange = null) {
    const range = voiceRange || config.voice.range;
    return this.getDistance(serverId, uuidA, uuidB) <= range;
  }

  getPosition(serverId, uuid) {
    return this.positions.get(serverId)?.get(uuid) || null;
  }
}

module.exports = new ProximityEngine();
