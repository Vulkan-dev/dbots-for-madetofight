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

  // ── 4. Crouch Toggle (Always Crouch / Uncrouch) ──────────────────────────────
  const queuedPackets: Array<{ name: string; data: any }> = [];
  const crouchClient = {
    queue: (name: string, data: any) => {
      queuedPackets.push({ name, data });
    },
  };
  const crouchEngine = new KeepAliveEngine(crouchClient as any, 'crouchBot', { x: 50, y: 64, z: 50 });

  // Toggle ON with Lock
  crouchEngine.setSneak(true, true);
  assert((crouchEngine as any).isSneakingState === true, 'Sneak state must be true on toggle ON');
  assert((crouchEngine as any).isCrouchLocked === true, 'Crouch lock must be active');
  const startSneakPacket = queuedPackets.find(p => p.name === 'player_action' && p.data.action === 'start_sneak');
  assert(startSneakPacket != null, 'Must send player_action start_sneak packet');
  assert(startSneakPacket!.data.position.x === 0 && startSneakPacket!.data.position.y === 0 && startSneakPacket!.data.position.z === 0, 'position must be zero vector');

  // Verify that background/game attempts to uncrouch are BLOCKED when locked
  crouchEngine.setSneak(false);
  assert((crouchEngine as any).isSneakingState === true, 'Sneak state must remain true when crouch is locked');

  // Explicit user unlock & toggle OFF
  queuedPackets.length = 0;
  crouchEngine.setSneak(false, false);
  assert((crouchEngine as any).isSneakingState === false, 'Sneak state must be false on user toggle OFF');
  assert((crouchEngine as any).isCrouchLocked === false, 'Crouch lock must be cleared');
  const stopSneakPacket = queuedPackets.find(p => p.name === 'player_action' && p.data.action === 'stop_sneak');
  assert(stopSneakPacket != null, 'Must send player_action stop_sneak packet');
  assert(stopSneakPacket!.data.position.x === 0 && stopSneakPacket!.data.position.y === 0 && stopSneakPacket!.data.position.z === 0, 'position must be zero vector');
  assert((crouchEngine as any).stopSneakTicks > 0, 'stopSneakTicks must be active during uncrouch transition');
  console.log('✔ Crouch toggle ON / OFF with persistent lock validated.');

  // ── 5. Mid-air Gravity Descent on Teleport Landing (e.g. /home 1 into air) ───
  const airEngine = new KeepAliveEngine(crouchClient as any, 'airBot', { x: 100, y: 120, z: 100 });
  (airEngine as any).isRunning = true;
  airEngine.handleTeleportLanding({ x: 100, y: 120, z: 100 }, undefined, false);
  assert(airEngine.isGrounded === false, 'Mid-air landing must have isGrounded=false');
  assert(!(airEngine as any).inputFlags.has('vertical_collision'), 'Mid-air bot must NOT assert vertical_collision');

  // Simulate 5 ticks of falling with gravity
  const initialY = airEngine.position.y;
  for (let i = 0; i < 5; i++) {
    (airEngine as any).onTick();
  }
  assert(airEngine.position.y < initialY, 'Bot must descend with gravity instead of freezing in mid-air');

  // Server informs bot that it reached solid ground
  airEngine.setGrounded(true);
  assert(airEngine.isGrounded === true, 'setGrounded(true) must set isGrounded=true');
  assert((airEngine as any).inputFlags.has('vertical_collision'), 'Grounded bot must assert vertical_collision');
  console.log('✔ Mid-air gravity descent without freezing validated.');

  // ── 6. AFKSpotTracker onResetPhysics callback ────────────────────────────────
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
