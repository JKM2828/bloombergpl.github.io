// ============================================================
// Test setup: override require() for db/connection with mock
// Load this BEFORE requiring any src modules in tests
// ============================================================
const Module = require('module');
const path = require('path');
const mockDb = require('./mockDb');

const connectionPath = path.resolve(__dirname, '..', '..', 'src', 'db', 'connection.js');
const resolvedConnectionPath = require.resolve(connectionPath);

// Pre-populate the require cache with our mock
require.cache[resolvedConnectionPath] = {
  id: resolvedConnectionPath,
  filename: resolvedConnectionPath,
  loaded: true,
  exports: mockDb,
  children: [],
  paths: [],
};

module.exports = mockDb;
