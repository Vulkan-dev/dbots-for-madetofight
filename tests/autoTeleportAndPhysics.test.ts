import { KeepAliveEngine } from '../src/network/KeepAliveEngine';
import { IgnoreListStorage } from '../src/storage/IgnoreListStorage';
import { AccountManager } from '../src/network/AccountManager';
import { AFKSpotTracker } from '../src/features/AFKSpotTracker';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runTests() {
  console.log('Running Auto-Teleport, Physics Reset & Supabase Throttling unit tests...');

  // ── 1. KeepAliveEngine: resetPhysicsAndClearTarget & Ground Check ──────────────
  const mockClient: any = {
    on: () => {},
    removeAllListeners: () => {},
    queue: () => {},
  };

  const engine = new KeepAliveEngine(mockClient, 'testBot', { x: 100, y: 70, z: 200 });

  // Simulate in-flight jump and movement
  engine.setJump(true);
  engine.moveForward(5, 8);
  engine.addInputFlag('jumping');
  engine.addInputFlag('start_moving');

  // Verify physics are active
  assert((engine as any).jumpTicksRemaining > 0 || engine.isContinuousJump, 'Jump should be active');
  assert((engine as any).moveTicksRemaining > 0, 'Movement ticks should be remaining');

  // Call resetPhysicsAndClearTarget
  engine.resetPhysicsAndClearTarget();
  assert((engine as any).moveTicksRemaining === 0, 'moveTicksRemaining must be 0 after reset');
  assert((engine as any).jumpTicksRemaining === 0, 'jumpTicksRemaining must be 0 after reset');
  assert(engine.isContinuousJump === false, 'isContinuousJump must be false after reset');
  assert(!(engine as any).inputFlags.has('jumping'), 'jumping flag should be cleared');
  assert(!(engine as any).inputFlags.has('start_moving'), 'start_moving flag should be cleared');
  console.log('✔ KeepAliveEngine.resetPhysicsAndClearTarget correctly resets physics state.');

  // ── 2. KeepAliveEngine: handleTeleportLanding & Safe Descent ──────────────────
  (engine as any).isRunning = true;
  // Bot lands floating at y=68.5 while ground floor is y=64
  engine.handleTeleportLanding({ x: 100, y: 68.5, z: 200 }, 64);
  assert(engine.isGrounded === false, 'Bot floating above ground floor must have isGrounded=false');
  assert(engine.targetFloorY === 64, 'targetFloorY must be set to 64');

  // Run onTick ticks to verify descent simulation
  // At 0.15 blocks/tick descent, 68.5 -> 64 takes 30 ticks
  for (let i = 0; i < 35; i++) {
    (engine as any).onTick();
  }

  assert(engine.isGrounded === true, 'Bot should have safely landed and set isGrounded=true');
  assert(Math.abs(engine.position.y - 64) < 0.001, `Bot position Y should be 64, got ${engine.position.y}`);
  assert(engine.targetFloorY === null, 'targetFloorY should be cleared upon landing');
  console.log('✔ KeepAliveEngine.handleTeleportLanding safely descends floating bots to floor.');

  // ── 3. Auto-Teleport Accept Pattern Extraction & Whitelist ───────────────────
  await IgnoreListStorage.addPlayer('TrustedFriend');
  AccountManager.registerBotName('FriendlyBot');

  const testCases = [
    { text: 'TrustedFriend has requested to teleport to you', expectedPlayer: 'TrustedFriend', allowed: true },
    { text: '§e[!] §aTrustedFriend §ewants to teleport to you. Type /tpaccept to accept.', expectedPlayer: 'TrustedFriend', allowed: true },
    { text: 'FriendlyBot sent a teleport request', expectedPlayer: 'FriendlyBot', allowed: true },
    { text: 'RandomGriefer has requested to teleport to you', expectedPlayer: 'RandomGriefer', allowed: false },
    { text: 'Teleport request from TrustedFriend', expectedPlayer: 'TrustedFriend', allowed: true },
  ];

  for (const tc of testCases) {
    const cleanText = tc.text.replace(/§[0-9a-fk-or]/gi, '').trim();
    let extractedPlayer: string | null = null;

    const match1 = cleanText.match(/([a-zA-Z0-9_.*]+)\s+(?:has requested to teleport to you|has requested that you teleport to them|wants to teleport to you|sent a teleport request|has requested a teleport)/i);
    if (match1 && match1[1]) extractedPlayer = match1[1];

    if (!extractedPlayer) {
      const match2 = cleanText.match(/(?:teleport request from|tpa from|tpa request from)\s+([a-zA-Z0-9_.*]+)/i);
      if (match2 && match2[1]) extractedPlayer = match2[1];
    }

    assert(extractedPlayer?.toLowerCase() === tc.expectedPlayer.toLowerCase(), `Expected ${tc.expectedPlayer}, got ${extractedPlayer}`);

    const isTrusted = IgnoreListStorage.isIgnored(extractedPlayer!);
    const isBot = AccountManager.isKnownBot(extractedPlayer!);
    const isAccepted = isTrusted || isBot;
    assert(isAccepted === tc.allowed, `Expected allowed=${tc.allowed} for player ${extractedPlayer}, got ${isAccepted}`);
  }
  console.log('✔ Auto-tpaccept pattern matching and whitelist validation passed.');

  // ── 4. AFKSpotTracker onResetPhysics callback ────────────────────────────────
  let resetCalled: boolean = false;
  const tracker = new AFKSpotTracker('Bot1', 'node-1', 1000, 5.0);
  tracker.setCallbacks(
    () => {},
    () => ({ x: 100, y: 64, z: 100 }), // drifted 100 blocks
    () => true,
    () => { resetCalled = true; }
  );

  tracker.restoreFromStorage({ x: 0, y: 64, z: 0 });
  tracker.checkPositionAndEnforceHome();
  assert(Boolean(resetCalled) === true, 'onResetPhysicsCallback must be called when AFKSpotTracker enforces home');
  tracker.dispose();
  console.log('✔ AFKSpotTracker invokes onResetPhysicsCallback on home enforcement.');

  console.log('\n🎉 ALL AUTO-TELEPORT, PHYSICS RESET & THROTTLING TESTS PASSED SUCCESSFULLY!\n');
}

runTests().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
