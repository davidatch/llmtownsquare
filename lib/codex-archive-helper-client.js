'use strict';

/** Client for the no-inference archive helper spawned by Codex Desktop. */

const crypto = require('crypto');
const net = require('net');
const os = require('os');
const path = require('path');

const REQUEST_TIMEOUT_MS = 10000;

function archiveHelperSocketPath() {
  return process.env.TOWNSQUARE_ARCHIVE_HELPER_SOCK ||
    path.join(process.env.TOWNSQUARE_STATE_DIR || path.join(os.homedir(), '.townsquare'), 'codex-archive-helper.sock');
}

class CodexArchiveHelperClient {
  constructor({ socketPath = archiveHelperSocketPath(), token, connectSocket = net.connect } = {}) {
    this.socketPath = socketPath;
    this.token = token;
    this.connectSocket = connectSocket;
  }

  archiveThread(threadId, callerThreadId) {
    if (!this.token) return Promise.reject(new Error('Codex archive helper token is unavailable'));
    if (!callerThreadId || callerThreadId === threadId) {
      return Promise.reject(new Error('Codex archive helper requires a different caller task'));
    }
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const socket = this.connectSocket({ path: this.socketPath });
      let buffer = '';
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(
        () => finish(new Error('Codex Desktop archive helper timed out')),
        REQUEST_TIMEOUT_MS
      );
      timer.unref?.();
      socket.setEncoding?.('utf8');
      socket.on('error', (error) => finish(error));
      socket.on('data', (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        let response;
        try {
          response = JSON.parse(buffer.slice(0, newline));
        } catch {
          return finish(new Error('Codex Desktop archive helper returned malformed JSON'));
        }
        if (response.id !== id) return finish(new Error('Codex Desktop archive helper response mismatch'));
        if (response.error) return finish(new Error(response.error));
        finish(undefined, response.result);
      });
      socket.on('connect', () => {
        socket.write(`${JSON.stringify({
          id,
          token: this.token,
          action: 'archive',
          threadId,
          callerThreadId,
        })}\n`);
      });
    });
  }
}

module.exports = { CodexArchiveHelperClient, archiveHelperSocketPath };
