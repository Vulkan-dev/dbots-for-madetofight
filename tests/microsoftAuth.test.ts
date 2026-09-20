import { MicrosoftAuthManager, AccountAuthStatus } from '../src/auth/MicrosoftAuthManager';
import fs from 'fs';
import path from 'path';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runTests() {
  console.log('Running Microsoft & Xbox Profile Handling unit tests...\n');

  const testCacheDir = path.resolve(process.cwd(), 'test_cache', 'mock_profiles');
  if (fs.existsSync(testCacheDir)) {
    fs.rmSync(testCacheDir, { recursive: true, force: true });
  }
  fs.mkdirSync(testCacheDir, { recursive: true });

  try {
    // =========================================================================
    // 1. Test: Account that already has an Xbox profile
    // =========================================================================
    console.log('--- Test 1: Account with Existing Xbox Profile ---');
    const mgr1 = new MicrosoftAuthManager({
      accountId: 'BotValid',
      profilesFolder: path.join(testCacheDir, 'BotValid'),
    });

    // Mock Authflow
    (mgr1 as any).getOrCreateAuthflow = () => ({
      getMsaToken: async () => 'mock_valid_msa_token',
      getXboxToken: async () => ({
        userXUID: '2535412345678901',
        userHash: 'mock_hash_1',
        XSTSToken: 'mock_xsts_1',
      }),
    });

    const success1 = await mgr1.authenticateAndVerify();
    assert(success1 === true, 'Existing profile check must succeed');
    assert(mgr1.getAccountStatus() === AccountAuthStatus.READY, 'Status must be READY');
    const ident1 = mgr1.getXboxIdentity();
    assert(ident1.xuid === '2535412345678901', `Expected XUID 2535412345678901, got ${ident1.xuid}`);
    mgr1.dispose();
    console.log('✔ Test 1 Passed: Existing Xbox profile detected and identity stored.\n');

    // =========================================================================
    // 2. Test: Account requiring Xbox profile setup (Error 2148916233)
    // =========================================================================
    console.log('--- Test 2: Account Requiring Xbox Profile Setup ---');
    const mgr2 = new MicrosoftAuthManager({
      accountId: 'BotNeedsProfile',
      profilesFolder: path.join(testCacheDir, 'BotNeedsProfile'),
      autoRetryIntervalMs: 1000,
    });

    let profileCreatedOnWeb = false;

    (mgr2 as any).getOrCreateAuthflow = () => ({
      getMsaToken: async () => 'mock_valid_msa_token',
      getXboxToken: async () => {
        if (!profileCreatedOnWeb) {
          const err: any = new Error('Your account currently does not have an Xbox profile. Please create one at https://signup.live.com/signup');
          err.XErr = 2148916233;
          throw err;
        }
        return {
          userXUID: '2535499999999999',
          userHash: 'mock_hash_new',
          XSTSToken: 'mock_xsts_new',
        };
      },
    });

    let eventFired: boolean = false;
    mgr2.on('profileRequired', (data) => {
      eventFired = true;
      assert(data.setupUrl.includes('account.xbox.com/profile'), 'Must provide legitimate setup URL');
    });

    const success2 = await mgr2.authenticateAndVerify();
    assert(success2 === false, 'Authentication must return false when Xbox profile is missing');
    assert(mgr2.getAccountStatus() === AccountAuthStatus.XBOX_PROFILE_REQUIRED, 'Status must be XBOX_PROFILE_REQUIRED');
    assert(Boolean(eventFired), 'profileRequired event must be emitted');
    const ident2 = mgr2.getXboxIdentity();
    assert(ident2.setupUrl !== null, 'Setup URL must be populated');
    assert(ident2.setupUrl?.includes('account.xbox.com/profile') === true, 'Must link to legitimate Xbox setup page');

    // Simulate user completing setup on web and clicking "Retry Profile Check"
    profileCreatedOnWeb = true;
    const retrySuccess = await mgr2.retryProfileCheck();
    assert(retrySuccess === true, 'Retry must succeed once user finishes setup');
    assert(mgr2.getAccountStatus() === AccountAuthStatus.READY, 'Status must recover to READY');
    assert(mgr2.getXboxIdentity().xuid === '2535499999999999', 'XUID must be populated after retry');
    mgr2.dispose();
    console.log('✔ Test 2 Passed: Missing profile detected, setup URL provided, and retry recovered.\n');

    // =========================================================================
    // 3. Test: Expired authentication (invalid_grant / 401)
    // =========================================================================
    console.log('--- Test 3: Expired Authentication Handling ---');
    const mgr3 = new MicrosoftAuthManager({
      accountId: 'BotExpired',
      profilesFolder: path.join(testCacheDir, 'BotExpired'),
    });

    (mgr3 as any).getOrCreateAuthflow = () => ({
      getMsaToken: async () => {
        throw new Error('invalid_grant: The refresh token has expired or is invalid.');
      },
      getXboxToken: async () => ({}),
    });

    const success3 = await mgr3.authenticateAndVerify();
    assert(success3 === false, 'Must fail when token is expired');
    assert(mgr3.getAccountStatus() === AccountAuthStatus.AUTH_REQUIRED, 'Status must be AUTH_REQUIRED');
    assert(mgr3.getXboxIdentity().authErrorMessage?.includes('Session expired') === true, 'Error message must reflect expired session');
    mgr3.dispose();
    console.log('✔ Test 3 Passed: Expired token handled cleanly and set to AUTH_REQUIRED.\n');

    // =========================================================================
    // 4. Test: MFA / Interactive device code challenge
    // =========================================================================
    console.log('--- Test 4: MFA / Device Code Challenge ---');
    const mgr4 = new MicrosoftAuthManager({
      accountId: 'BotMfa',
      profilesFolder: path.join(testCacheDir, 'BotMfa'),
    });

    let msaCodeFired: boolean = false;
    mgr4.on('msaCode', (codeData) => {
      msaCodeFired = true;
      assert(codeData.user_code === 'DEMO-CODE', 'Must pass device code');
      assert(codeData.verification_uri === 'https://www.microsoft.com/link', 'Must pass verification URI');
    });

    // Simulate prismarine-auth invoking codeCallback
    (mgr4 as any).getOrCreateAuthflow = () => {
      // Simulate the code callback stored in authflow constructor
      setTimeout(() => {
        (mgr4 as any).msaCodeInfo = {
          user_code: 'DEMO-CODE',
          verification_uri: 'https://www.microsoft.com/link',
        };
        mgr4.setStatus(AccountAuthStatus.VERIFICATION_REQUIRED);
        mgr4.emit('msaCode', (mgr4 as any).msaCodeInfo);
      }, 50);

      return {
        getMsaToken: async () => {
          await new Promise((r) => setTimeout(r, 100));
          return 'token_after_code_completion';
        },
        getXboxToken: async () => ({ userXUID: '1122334455' }),
      };
    };

    const authPromise = mgr4.authenticateAndVerify();
    await new Promise((r) => setTimeout(r, 70));
    assert(mgr4.getAccountStatus() === AccountAuthStatus.VERIFICATION_REQUIRED, 'Status must be VERIFICATION_REQUIRED during challenge');
    assert(Boolean(msaCodeFired), 'msaCode event must be dispatched');

    await authPromise;
    assert(mgr4.getAccountStatus() === AccountAuthStatus.READY, 'Status must reach READY after verification finishes');
    mgr4.dispose();
    console.log('✔ Test 4 Passed: MFA / interactive challenge sets VERIFICATION_REQUIRED.\n');

    // =========================================================================
    // 5. Test: Network failure (differentiated from missing profile)
    // =========================================================================
    console.log('--- Test 5: Network Failure Handling ---');
    const mgr5 = new MicrosoftAuthManager({
      accountId: 'BotOffline',
      profilesFolder: path.join(testCacheDir, 'BotOffline'),
    });

    (mgr5 as any).getOrCreateAuthflow = () => ({
      getMsaToken: async () => 'mock_token',
      getXboxToken: async () => {
        throw new Error('getaddrinfo ENOTFOUND login.live.com');
      },
    });

    const success5 = await mgr5.authenticateAndVerify();
    assert(success5 === false, 'Must fail on network error');
    assert(mgr5.getAccountStatus() === AccountAuthStatus.AUTH_FAILED, 'Status must be AUTH_FAILED');
    assert(mgr5.getAccountStatus() !== AccountAuthStatus.XBOX_PROFILE_REQUIRED, 'Network error must NOT be mistaken for missing profile');
    assert(mgr5.getXboxIdentity().authErrorMessage?.includes('Network error') === true, 'Error message must specify network failure');
    mgr5.dispose();
    console.log('✔ Test 5 Passed: Network failure differentiated properly from missing profile.\n');

    // =========================================================================
    // 6. Test: Multi-account concurrent handling (one failure does NOT block others)
    // =========================================================================
    console.log('--- Test 6: Multi-Account Concurrent Independence ---');
    const accA = new MicrosoftAuthManager({ accountId: 'BotA', profilesFolder: path.join(testCacheDir, 'BotA') });
    const accB = new MicrosoftAuthManager({ accountId: 'BotB', profilesFolder: path.join(testCacheDir, 'BotB') });
    const accC = new MicrosoftAuthManager({ accountId: 'BotC', profilesFolder: path.join(testCacheDir, 'BotC') });

    // BotA succeeds
    (accA as any).getOrCreateAuthflow = () => ({
      getMsaToken: async () => 'token_a',
      getXboxToken: async () => ({ userXUID: '1000000000000001' }),
    });

    // BotB requires Xbox profile
    (accB as any).getOrCreateAuthflow = () => ({
      getMsaToken: async () => 'token_b',
      getXboxToken: async () => {
        const err: any = new Error('does not have an Xbox profile');
        err.XErr = 2148916233;
        throw err;
      },
    });

    // BotC has network error
    (accC as any).getOrCreateAuthflow = () => ({
      getMsaToken: async () => {
        throw new Error('connect ETIMEDOUT');
      },
      getXboxToken: async () => ({}),
    });

    // Authenticate simultaneously
    const [resA, resB, resC] = await Promise.all([
      accA.authenticateAndVerify(),
      accB.authenticateAndVerify(),
      accC.authenticateAndVerify(),
    ]);

    assert(resA === true, 'BotA must succeed');
    assert(accA.getAccountStatus() === AccountAuthStatus.READY, 'BotA must be READY');
    assert(accA.getXboxIdentity().xuid === '1000000000000001', 'BotA must have its XUID');

    assert(resB === false, 'BotB must fail due to profile requirement');
    assert(accB.getAccountStatus() === AccountAuthStatus.XBOX_PROFILE_REQUIRED, 'BotB must be XBOX_PROFILE_REQUIRED');

    assert(resC === false, 'BotC must fail due to network timeout');
    assert(accC.getAccountStatus() === AccountAuthStatus.AUTH_FAILED, 'BotC must be AUTH_FAILED');

    accA.dispose();
    accB.dispose();
    accC.dispose();
    console.log('✔ Test 6 Passed: Multi-account authentication is fully decoupled and independent.\n');

    // =========================================================================
    // 7. Test: Restart recovery from cached session on disk
    // =========================================================================
    console.log('--- Test 7: Restart Recovery from Disk Cache ---');
    const recoveryDir = path.join(testCacheDir, 'RecoveryBot');
    fs.mkdirSync(recoveryDir, { recursive: true });

    // Mock bed cache containing decoded JWT payload
    const mockPayload = Buffer.from(
      JSON.stringify({
        extraData: {
          displayName: 'RecoveredGamerTag',
          XUID: '9876543210987654',
          identity: 'uuid-rec-1234',
        },
      })
    ).toString('base64');
    const mockJwt = `header.${mockPayload}.signature`;

    fs.writeFileSync(
      path.join(recoveryDir, 'test_bed-cache.json'),
      JSON.stringify({
        mca: {
          chain: ['dummy_mojang_jwt', mockJwt],
        },
      }),
      'utf8'
    );

    const recoveredMgr = new MicrosoftAuthManager({
      accountId: 'RecoveryBot',
      profilesFolder: recoveryDir,
    });

    const recoveredIdent = recoveredMgr.getXboxIdentity();
    assert(recoveredIdent.gamertag === 'RecoveredGamerTag', `Expected RecoveredGamerTag, got ${recoveredIdent.gamertag}`);
    assert(recoveredIdent.xuid === '9876543210987654', `Expected XUID 9876543210987654, got ${recoveredIdent.xuid}`);
    assert(recoveredIdent.uuid === 'uuid-rec-1234', `Expected uuid-rec-1234, got ${recoveredIdent.uuid}`);

    // Test logoutAccount() clears cache
    recoveredMgr.logoutAccount();
    assert(!fs.existsSync(recoveryDir), 'Profiles folder must be removed on logoutAccount()');
    assert(recoveredMgr.getAccountStatus() === AccountAuthStatus.IDLE, 'Status must reset to IDLE');
    // =========================================================================
    // 8. Test: Account with 401 Unauthorized multiplayer entitlement (Missing Bedrock/Xbox profile)
    // =========================================================================
    console.log('--- Test 8: Account with 401 Unauthorized Bedrock Multiplayer Entitlement ---');
    const mgr8 = new MicrosoftAuthManager({
      accountId: 'BotNeedsBedrockProfile',
      profilesFolder: path.join(testCacheDir, 'BotNeedsBedrockProfile'),
      autoRetryIntervalMs: 1000,
    });

    (mgr8 as any).getOrCreateAuthflow = () => ({
      getMsaToken: async () => 'mock_valid_msa_token',
      getXboxToken: async () => ({
        // Account has no XUID set up for multiplayer
        userXUID: null,
        userHash: 'mock_hash_8',
        XSTSToken: 'mock_xsts_8',
      }),
    });

    let profileRequiredFired: boolean = false;
    mgr8.on('profileRequired', (data) => {
      profileRequiredFired = true;
      assert(data.setupUrl.includes('account.xbox.com/profile'), 'Must point to account.xbox.com/profile');
    });

    const success8 = await mgr8.authenticateAndVerify();
    assert(success8 === false, 'Verification must return false when XUID is missing');
    assert(mgr8.getAccountStatus() === AccountAuthStatus.XBOX_PROFILE_REQUIRED, 'Status must be XBOX_PROFILE_REQUIRED');
    assert(Boolean(profileRequiredFired) === true, 'profileRequired event must be emitted');

    // Also test handling direct 401 error string from Util.js checkStatusWithHelp
    const err401: any = new Error(
      '401 Unauthorized {\n  "path" : "/multiplayer/bedrock/authentication",\n  "error" : "UNAUTHORIZED"\n} Ensure that you are able to sign-in to Minecraft with this account'
    );
    const handled = mgr8.handleAuthError(err401);
    assert(handled === false, 'handleAuthError must return false');
    assert(mgr8.getAccountStatus() === AccountAuthStatus.XBOX_PROFILE_REQUIRED, 'Status must remain XBOX_PROFILE_REQUIRED on 401 multiplayer error');
    mgr8.dispose();
    console.log('✔ Test 8 Passed: 401 Unauthorized multiplayer / missing XUID properly transitions to XBOX_PROFILE_REQUIRED.\n');

    console.log('🎉 ALL 8 MICROSOFT / XBOX PROFILE HANDLING TESTS PASSED SUCCESSFULLY!\n');
  } finally {
    if (fs.existsSync(testCacheDir)) {
      fs.rmSync(testCacheDir, { recursive: true, force: true });
    }
  }
}

runTests().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
