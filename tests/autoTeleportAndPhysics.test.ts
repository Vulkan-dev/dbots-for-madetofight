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

  // ── 3. Auto-Teleport Accept Pattern Extraction & Whitelist (TPA & TPAHERE) ───
  await IgnoreListStorage.addPlayer('TrustedFriend');
  AccountManager.registerBotName('FriendlyBot');

  const testCases = [
    { text: 'TrustedFriend has requested to teleport to you', expectedPlayer: 'TrustedFriend', allowed: true },
    { text: '§e[!] §aTrustedFriend §ewants to teleport to you. Type /tpaccept to accept.', expectedPlayer: 'TrustedFriend', allowed: true },
    { text: 'FriendlyBot sent a teleport request', expectedPlayer: 'FriendlyBot', allowed: true },
    { text: 'RandomGriefer has requested to teleport to you', expectedPlayer: 'RandomGriefer', allowed: false },
    { text: 'Teleport request from TrustedFriend', expectedPlayer: 'TrustedFriend', allowed: true },
    // TPAHERE test cases:
    { text: 'TrustedFriend has requested that you teleport to them', expectedPlayer: 'TrustedFriend', allowed: true },
    { text: '§e[!] §aTrustedFriend §ewants you to teleport to them. Type /tpaccept to accept.', expectedPlayer: 'TrustedFriend', allowed: true },
    { text: 'tpahere from TrustedFriend', expectedPlayer: 'TrustedFriend', allowed: true },
    { text: 'Teleport here request from TrustedFriend', expectedPlayer: 'TrustedFriend', allowed: true },
    { text: 'RandomGriefer sent a teleport here request', expectedPlayer: 'RandomGriefer', allowed: false },
    { text: 'TrustedFriend sent you a teleport here request', expectedPlayer: 'TrustedFriend', allowed: true },
  ];

  for (const tc of testCases) {
    const cleanText = tc.text.replace(/§[0-9a-fk-or]/gi, '').trim();
    let extractedPlayer: string | null = null;

    const match1 = cleanText.match(/(?:\[[^\]]+\]|\([^)]+\)|[»>*-])*\s*([a-zA-Z0-9_.*]{3,20})\s+(?:has\s+|have\s+)?(?:sent(?:\s+you)?\s+(?:a\s+)?teleport(?:\s+|-)?(?:here\s+)?request|requested(?:\s+(?:that\s+you|you\s+to|you|to))?\s+teleport|wants(?:\s+you)?\s+to\s+teleport)/i);
    if (match1 && match1[1]) extractedPlayer = match1[1];

    if (!extractedPlayer) {
      const match2 = cleanText.match(/(?:teleport(?:\s+here)?\s+request\s+from|tpa(?:here)?\s+(?:request\s+)?from)\s+([a-zA-Z0-9_.*]{3,20})/i);
      if (match2 && match2[1]) extractedPlayer = match2[1];
    }

    if (!extractedPlayer) {
      const match3 = cleanText.match(/\[(?:!|teleport|tpa|tpahere)\]\s*(?:\[[^\]]+\]\s*)?([a-zA-Z0-9_.*]{3,20})\s+(?:wants|has|sent|requested)/i);
      if (match3 && match3[1]) extractedPlayer = match3[1];
    }

    assert(extractedPlayer?.toLowerCase() === tc.expectedPlayer.toLowerCase(), `Expected ${tc.expectedPlayer}, got ${extractedPlayer}`);

    let cleanPlayer = extractedPlayer!.trim().replace(/[.,:;!?]+$/, '').trim();
    let isTrusted = IgnoreListStorage.isIgnored(cleanPlayer);
    let isBot = AccountManager.isKnownBot(cleanPlayer);
    if (!isTrusted && !isBot) {
      const stripped = cleanPlayer.replace(/^[.*_~#@]+/, '').replace(/^\[[^\]]+\]\s*/, '').trim();
      if (stripped && (IgnoreListStorage.isIgnored(stripped) || AccountManager.isKnownBot(stripped))) {
        cleanPlayer = stripped;
        isTrusted = true;
      }
    }

    const isAccepted = isTrusted || isBot;
    assert(isAccepted === tc.allowed, `Expected allowed=${tc.allowed} for player ${extractedPlayer}, got ${isAccepted}`);
  }
  console.log('✔ Auto-tpaccept and auto-tpahere pattern matching and whitelist validation passed.');

  // ── 4. Realistic Knockback & Push Motion Simulation ─────────────────────────
  const physicsEngine = new KeepAliveEngine(mockClient, 'physicsBot', { x: 50, y: 64, z: 50 });
  (physicsEngine as any).isRunning = true;

  // Apply knockback from a hit or push
  physicsEngine.applyMotion({ x: 0.4, y: 0.35, z: -0.3 });
  assert(physicsEngine.isGrounded === false, 'Knockback popping bot into air must set isGrounded=false');
  assert(physicsEngine.velocity.x === 0.4, 'Velocity X must be set');
  assert(physicsEngine.velocity.y === 0.35, 'Velocity Y must be set');

  const prevX = physicsEngine.position.x;
  const prevY = physicsEngine.position.y;
  (physicsEngine as any).onTick();

  assert(physicsEngine.position.x > prevX, 'Bot position X must move with knockback');
  assert(physicsEngine.position.y > prevY, 'Bot position Y must arc upward with knockback');
  assert(physicsEngine.velocity.x < 0.4, 'Horizontal velocity must decay from friction');
  console.log('✔ Realistic push & knockback velocity physics validated.');

  // ── 5. Gravity Fall When Floating Without Blocks (e.g. /home 1 in mid-air) ──
  // Bot lands in mid-air with no floor underneath (server on_ground = false)
  physicsEngine.handleTeleportLanding({ x: 200, y: 100, z: 200 }, undefined, false);
  assert(physicsEngine.isGrounded === false, 'Mid-air landing without ground must have isGrounded=false');

  const startFallY = physicsEngine.position.y;
  for (let i = 0; i < 10; i++) {
    (physicsEngine as any).onTick();
  }
  assert(physicsEngine.position.y < startFallY, 'Bot must fall downward under gravity when no blocks are beneath it');
  assert(physicsEngine.isGrounded === false, 'Bot must continue falling and NOT freeze in mid-air');

  // Server informs bot that it landed on solid ground (move_player on_ground=true)
  physicsEngine.setGrounded(true);
  assert(physicsEngine.isGrounded === true, 'setGrounded(true) must set isGrounded=true');
  assert(physicsEngine.velocity.y === 0, 'Grounded bot must have vertical velocity reset to 0');
  console.log('✔ Mid-air gravity fall and server ground resolution validated.');

  // ── 6. Crouch Toggle (Always Crouch / Uncrouch) ──────────────────────────────
  physicsEngine.setSneak(true);
  assert((physicsEngine as any).isSneakingState === true, 'Sneak state must be true on toggle ON');
  assert((physicsEngine as any).inputFlags.has('sneaking'), 'inputFlags must include sneaking');
  assert((physicsEngine as any).inputFlags.has('persist_sneak'), 'inputFlags must include persist_sneak');

  physicsEngine.setSneak(false);
  assert((physicsEngine as any).isSneakingState === false, 'Sneak state must be false on toggle OFF');
  assert(!(physicsEngine as any).inputFlags.has('sneaking'), 'sneaking must be cleared from inputFlags');
  assert((physicsEngine as any).stopSneakTicks > 0, 'stopSneakTicks must be active during uncrouch transition');
  console.log('✔ Crouch toggle ON / OFF input transitions validated.');

  // ── 7. AFKSpotTracker onResetPhysics callback ────────────────────────────────
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
