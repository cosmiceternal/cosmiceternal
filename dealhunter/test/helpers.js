'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { createApp } = require('../src/app');

const tempDirs = [];

function tempDir(prefix = 'dealhunter-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function cleanup() {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A fully wired app on a throwaway data dir, with logging off so the test
// output stays readable.
function testApp(overrides = {}) {
  return createApp({
    configFile: null,
    env: {},
    overrides: { dataDir: tempDir(), logLevel: 'silent', sources: ['sample'], ...overrides },
  });
}

// A local HTTP server that records every request it receives, for exercising
// the scraper and the webhook channels without touching the network.
function recordingServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, { body, requests });
    });
  });
  return {
    requests,
    async listen() {
      await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
      return `http://127.0.0.1:${server.address().port}`;
    },
    close() {
      return new Promise((resolve) => { server.close(resolve); });
    },
  };
}

function jsonResponse(res, body, status = 200) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function textResponse(res, body, status = 200, contentType = 'text/html') {
  res.writeHead(status, { 'content-type': contentType });
  res.end(body);
}

module.exports = { tempDir, cleanup, testApp, recordingServer, jsonResponse, textResponse };
