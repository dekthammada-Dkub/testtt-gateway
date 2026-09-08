'use strict';

const { WebSocket } = require('ws');
const logger = require('./logger');

/**
 * WebRTC Signaling Relay
 * Routes SDP offers/answers and ICE candidates between players.
 * The gateway never touches the actual audio data — only signaling.
 */
class SignalingRelay {
  sendTo(ws, msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  relayOffer(fromUuid, targetUuid, sdp, playerSockets) {
    const targetWs = playerSockets.get(targetUuid);
    if (!targetWs) {
      logger.warn(`[Signaling] OFFER target not found: ${targetUuid}`);
      return false;
    }
    this.sendTo(targetWs, {
      type: 'OFFER',
      fromUuid,
      sdp,
    });
    logger.debug(`[Signaling] OFFER relayed ${fromUuid} → ${targetUuid}`);
    return true;
  }

  relayAnswer(fromUuid, targetUuid, sdp, playerSockets) {
    const targetWs = playerSockets.get(targetUuid);
    if (!targetWs) {
      logger.warn(`[Signaling] ANSWER target not found: ${targetUuid}`);
      return false;
    }
    this.sendTo(targetWs, {
      type: 'ANSWER',
      fromUuid,
      sdp,
    });
    logger.debug(`[Signaling] ANSWER relayed ${fromUuid} → ${targetUuid}`);
    return true;
  }

  relayIceCandidate(fromUuid, targetUuid, candidate, playerSockets) {
    const targetWs = playerSockets.get(targetUuid);
    if (!targetWs) return false;
    this.sendTo(targetWs, {
      type: 'ICE_CANDIDATE',
      fromUuid,
      candidate,
    });
    return true;
  }

  /** Notify a player that a peer connection should be renegotiated */
  relayRenegotiate(targetUuid, peerUuid, playerSockets) {
    const targetWs = playerSockets.get(targetUuid);
    if (!targetWs) return false;
    this.sendTo(targetWs, { type: 'RENEGOTIATE', peerUuid });
    return true;
  }
}

module.exports = new SignalingRelay();
