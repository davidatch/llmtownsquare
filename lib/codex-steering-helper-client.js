'use strict';

/** Steering client for the no-inference Desktop helper. */

const crypto = require('crypto');
const net = require('net');
const os = require('os');
const path = require('path');

const REQUEST_TIMEOUT_MS = 10000;

function steeringHelperSocketPath() {
  return process.env.TOWNSQUARE_STEERING_HELPER_SOCK ||
    path.join(process.env.TOWNSQUARE_STATE_DIR || path.join(os.homedir(), '.townsquare'), 'codex-steering-helper.sock');
}

class CodexSteeringHelperClient {
  constructor({ socketPath = steeringHelperSocketPath(), token, connectSocket = net.connect } = {}) {
    this.socketPath = socketPath;
    this.token = token;
    this.connectSocket = connectSocket;
  }

  sendMessage(threadId, callerThreadId, text) {
    if (!this.token) return Promise.reject(new Error('Codex steering helper token is unavailable'));
    if (!callerThreadId || callerThreadId === threadId) {
      return Promise.reject(new Error('Codex steering helper requires a different caller task'));
    }
    const prompt = String(text ?? '').trim();
    if (!prompt) return Promise.reject(new Error('Codex steering helper message must not be empty'));

    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const socket = this.connectSocket({ path: this.socketPath });
      let buffer = '';
      let settled = false;
      let connected = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(() => {
        const error = new Error('Codex Desktop steering helper timed out');
        error.deliveryStage = connected ? 'outcome-unknown' : 'not-sent';
        finish(error);
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      socket.setEncoding?.('utf8');
      socket.on('error', (error) => {
        error.deliveryStage = connected ? 'outcome-unknown' : 'not-sent';
        finish(error);
      });
      socket.on('data', (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        let response;
        try {
          response = JSON.parse(buffer.slice(0, newline));
        } catch {
          const error = new Error('Codex Desktop steering helper returned malformed JSON');
          error.deliveryStage = 'outcome-unknown';
          return finish(error);
        }
        if (response.id !== id) {
          const error = new Error('Codex Desktop steering helper response mismatch');
          error.deliveryStage = 'outcome-unknown';
          return finish(error);
        }
        if (response.error) {
          const error = new Error(response.error);
          error.deliveryStage = 'rejected';
          return finish(error);
        }
        finish(undefined, response.result);
      });
      socket.on('connect', () => {
        connected = true;
        socket.write(`${JSON.stringify({
          id,
          token: this.token,
          action: 'send_message',
          targetThreadId: threadId,
          callerThreadId,
          text: prompt,
        })}\n`);
      });
    });
  }
}

module.exports = { CodexSteeringHelperClient, steeringHelperSocketPath };
