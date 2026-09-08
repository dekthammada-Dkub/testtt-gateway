'use strict';

/**
 * permissions.js — Role-based permission system
 *
 * Roles (ascending privilege):
 *   player → vip → staff → admin
 *
 * Voice range multipliers let VIPs/staff hear further by default.
 */

const ROLES = {
  player: { level: 0, label: 'ผู้เล่น',  rangeMultiplier: 1.0,  color: '#9aacbd' },
  vip:    { level: 1, label: 'VIP',       rangeMultiplier: 1.5,  color: '#f59e0b' },
  staff:  { level: 2, label: 'Staff',     rangeMultiplier: 2.0,  color: '#3b9ddd' },
  admin:  { level: 3, label: 'Admin',     rangeMultiplier: 2.5,  color: '#ef4444' },
};

const VALID_ROLES = Object.keys(ROLES);

class Permissions {
  /**
   * Get role metadata (level, label, rangeMultiplier, color)
   */
  getRole(role) {
    return ROLES[role] || ROLES.player;
  }

  /** All valid role names */
  get validRoles() {
    return VALID_ROLES;
  }

  /**
   * Check if `actorRole` can mute/kick `targetRole`.
   * Staff and above can mute regular players.
   * Admin can mute everyone.
   */
  canMute(actorRole, targetRole) {
    const actor = this.getRole(actorRole);
    const target = this.getRole(targetRole);
    return actor.level > target.level && actor.level >= ROLES.staff.level;
  }

  canKick(actorRole, targetRole) {
    return this.canMute(actorRole, targetRole);
  }

  /**
   * Only admin can assign roles.
   */
  canSetRole(actorRole) {
    return this.getRole(actorRole).level >= ROLES.admin.level;
  }

  /**
   * Get effective voice range for a player given their role and config default.
   */
  getVoiceRange(role, defaultRange) {
    return defaultRange * this.getRole(role).rangeMultiplier;
  }

  /**
   * Check if an actor role is at least at the given minimum role level.
   */
  hasAtLeast(actorRole, minimumRole) {
    return this.getRole(actorRole).level >= this.getRole(minimumRole).level;
  }

  isValidRole(role) {
    return VALID_ROLES.includes(role);
  }
}

module.exports = new Permissions();
