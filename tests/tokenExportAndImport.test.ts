import fs from 'fs';
import path from 'path';
import http from 'http';
import { TokenStorage } from '../src/auth/TokenStorage';
import { WebServer } from '../src/web/WebServer';
import { AccountManager } from '../src/network/AccountManager';
import { loadConfig } from '../src/config';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function httpRequest(options: http.RequestOptions, bodyData?: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          resolve({ status: res.statusCode || 200, body: parsed });
        } catch {
          resolve({ status: res.statusCode || 200, body: raw });
        }
      });
    });
    req.on('error', reject);
    if (bodyData) {
      req.write(bodyData);
    }
    req.end();
  });
}

async function runTests() {
  console.log('Running Token Export & Import Unit Tests...\n');

  const testAccId = 'test-token-export-1';
  const testAccId2 = 'test-token-import-2';
  const mockTokens = {
    'mca-cache.json': {
      token_type: 'Bearer',
      access_token: 'mock_token_abc_123',
      expires_in: 3600,
    },
    'live-cache.json': {
      client_id: 'mock_client_xyz',
      user_hash: 'mock_hash_456',
    },
  };

  // ── Test 1: TokenStorage.importTokensForAccount ──────────────────────────
  console.log('--- Test 1: TokenStorage.importTokensForAccount ---');
  const importRes = await TokenStorage.importTokensForAccount(testAccId, 'node-test', mockTokens);
  assert(importRes.success === true, `Expected import success, got ${JSON.stringify(importRes)}`);
  assert(importRes.fileCount === 2, `Expected 2 files written, got ${importRes.fileCount}`);
  console.log('✔ Test 1 Passed: Successfully imported mock token files.');

  // ── Test 2: TokenStorage.getTokensForAccount ────────────────────────────
  console.log('\n--- Test 2: TokenStorage.getTokensForAccount ---');
  const retrieved = await TokenStorage.getTokensForAccount(testAccId);
  assert(retrieved !== null, 'Tokens must not be null');
  assert(retrieved!['mca-cache.json'] !== undefined, 'mca-cache.json must be present');
  assert(retrieved!['mca-cache.json'].access_token === 'mock_token_abc_123', 'Access token content must match');
  assert(retrieved!['live-cache.json'].user_hash === 'mock_hash_456', 'User hash content must match');
  console.log('✔ Test 2 Passed: getTokensForAccount accurately retrieved token cache files.');

  // ── Test 3: WebServer /api/tokens/export and /api/tokens/import ──────────
  console.log('\n--- Test 3: WebServer /api/tokens/export & import HTTP Endpoints ---');
  const testPort = 38921;
  const config: any = {
    nodeId: 'test-node',
    nodeName: 'Test Node',
    nodeOwner: '',
    nodeUrl: 'http://localhost:3000',
    supabase: { url: '', serviceRoleKey: '' },
    server: { host: 'localhost', port: 19132, offline: false },
    webServer: { port: testPort, frontendUrl: '*', apiSecret: '' },
    discord: { isMaster: false, token: '', botCategoryId: '', allowedUserId: '', logChannelId: '', joinLogChannelId: '', leftLogChannelId: '' },
    afk: { enabled: true, activityIntervalMs: 5000, checkIntervalMs: 300000, locationTolerance: 3 },
    defensiveCombat: { enabled: false, allowedMobs: [], mobBlacklist: [], combatRange: 3 },
    playerHitResponse: { enabled: false, crouchCount: 2, cooldownMs: 1000 },
    joinScheduler: { minDelayMs: 100, maxDelayMs: 200 },
    watchdog: { reconnectDelayMs: 1000 },
    monitoring: { radiusChunks: 4, positionThresholdBlocks: 2 },
  };
  const manager = new AccountManager(config);
  const server = new WebServer(manager, config);

  const expressApp = (server as any).app;
  const httpServer = http.createServer(expressApp);

  await new Promise<void>((resolve) => {
    httpServer.listen(testPort, '127.0.0.1', () => resolve());
  });

  try {
    // 3a. Export single account via HTTP
    const resSingle = await httpRequest({
      hostname: '127.0.0.1',
      port: testPort,
      path: `/api/tokens/export?accountId=${testAccId}`,
      method: 'GET',
    });

    assert(resSingle.status === 200, `Expected 200, got ${resSingle.status}`);
    assert(resSingle.body.success === true, 'Response body success must be true');
    assert(Array.isArray(resSingle.body.accounts), 'accounts must be an array');
    assert(resSingle.body.accounts.length === 1, `Expected 1 account, got ${resSingle.body.accounts.length}`);
    assert(resSingle.body.accounts[0].accountId === testAccId, `Expected accountId ${testAccId}`);
    assert(resSingle.body.accounts[0].tokens['mca-cache.json'].access_token === 'mock_token_abc_123', 'Tokens match');
    console.log('✔ Test 3a Passed: GET /api/tokens/export?accountId=... exports single bot tokens.');

    // 3b. Export all accounts via HTTP
    const resAll = await httpRequest({
      hostname: '127.0.0.1',
      port: testPort,
      path: '/api/tokens/export',
      method: 'GET',
    });

    assert(resAll.status === 200, `Expected 200, got ${resAll.status}`);
    assert(resAll.body.success === true, 'Response body success must be true');
    assert(resAll.body.totalExported >= 1, `Expected totalExported >= 1, got ${resAll.body.totalExported}`);
    console.log(`✔ Test 3b Passed: GET /api/tokens/export returns full export (${resAll.body.totalExported} account(s)).`);

    // 3c. Import new account via POST /api/tokens/import
    const importPayload = {
      accounts: [
        {
          accountId: testAccId2,
          email: 'imported_bot@test.local',
          tokens: {
            'bed-cache.json': {
              token: 'imported_bedrock_token_789',
              userXUID: '2535400000000000',
            },
          },
        },
      ],
    };

    const resImport = await httpRequest({
      hostname: '127.0.0.1',
      port: testPort,
      path: '/api/tokens/import',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    }, JSON.stringify(importPayload));

    assert(resImport.status === 200, `Expected 200, got ${resImport.status}`);
    assert(resImport.body.success === true, 'Import success must be true');
    assert(resImport.body.importedCount === 1, `Expected 1 imported, got ${resImport.body.importedCount}`);
    console.log('✔ Test 3c Passed: POST /api/tokens/import successfully imported account via JSON.');

    // 3d. Verify imported account can be exported immediately
    const resVerify = await httpRequest({
      hostname: '127.0.0.1',
      port: testPort,
      path: `/api/tokens/export?accountId=${testAccId2}`,
      method: 'GET',
    });

    assert(resVerify.status === 200, `Expected 200, got ${resVerify.status}`);
    assert(resVerify.body.success === true, 'Export of newly imported bot must succeed');
    assert(resVerify.body.accounts[0].tokens['bed-cache.json'].token === 'imported_bedrock_token_789', 'Imported token verified');
    console.log('✔ Test 3d Passed: Verified imported account tokens roundtrip via GET /api/tokens/export.');

    // 3e. Negative Test: Export nonexistent account
    const resNotFound = await httpRequest({
      hostname: '127.0.0.1',
      port: testPort,
      path: '/api/tokens/export?accountId=nonexistent_acc_9999',
      method: 'GET',
    });

    assert(resNotFound.body.success === false, 'Export of nonexistent account must return success=false');
    assert(typeof resNotFound.body.error === 'string', 'Error message must be present');
    console.log('✔ Test 3e Passed: Handled nonexistent account export gracefully with error response.');

  } finally {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    // Clean up test tokens
    await TokenStorage.clearTokens(testAccId);
    await TokenStorage.clearTokens(testAccId2);
  }

  console.log('\n🎉 ALL TOKEN EXPORT & IMPORT UNIT TESTS PASSED SUCCESSFULLY!\n');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
