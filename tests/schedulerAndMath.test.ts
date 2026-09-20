import { MathUtils } from '../src/utils/MathUtils';
import { JoinScheduler } from '../src/network/JoinScheduler';
import { PlayerMonitor } from '../src/features/PlayerMonitor';
import { NotificationService } from '../src/notify/NotificationService';
import { ActionController } from '../src/features/ActionController';
import { AutoRespawn } from '../src/features/AutoRespawn';
import { Watchdog } from '../src/network/Watchdog';
import { PlayerHitResponse } from '../src/features/PlayerHitResponse';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runTests() {
  console.log('Running unit tests...');

  // 1. Test MathUtils 3D distance
  const posA = { x: 0, y: 0, z: 0 };
  const posB = { x: 3, y: 4, z: 0 };
  const dist = MathUtils.euclideanDistance(posA, posB);
  assert(Math.abs(dist - 5.0) < 0.001, `Expected distance 5.0, got ${dist}`);
  console.log('✔ MathUtils euclideanDistance test passed.');

  // 2. Test MathUtils chunk radius check (32 chunks = 512 blocks)
  const farPos = { x: 500, y: 0, z: 0 };
  const outOfRangePos = { x: 600, y: 0, z: 0 };
  assert(MathUtils.isWithinChunkRadius(posA, farPos, 32) === true, '500 blocks should be inside 32 chunk radius');
  assert(MathUtils.isWithinChunkRadius(posA, outOfRangePos, 32) === false, '600 blocks should be outside 32 chunk radius');
  console.log('✔ MathUtils chunk radius filter test passed.');

  // 3. Test JoinScheduler randomized delay generator
  const scheduler = new JoinScheduler(6000, 9000);
  for (let i = 0; i < 50; i++) {
    const delay = scheduler.getRandomDelay();
    assert(delay >= 6000 && delay <= 9000, `Random delay ${delay} out of range [6000, 9000]`);
  }
  console.log('✔ JoinScheduler randomized delay range test passed (50 iterations).');

  // 4. Test JoinScheduler duplicate join prevention
  let executionCount = 0;
  const dummyTask = async () => { executionCount++; };
  
  const scheduled1 = scheduler.scheduleJoin('Bot1', dummyTask);
  const scheduledDuplicate = scheduler.scheduleJoin('Bot1', dummyTask);

  assert(scheduled1 === true, 'First join schedule should succeed');
  assert(scheduledDuplicate === false, 'Duplicate join schedule should be blocked');
  console.log('✔ JoinScheduler duplicate prevention test passed.');

  // 5. Test PlayerMonitor defensive handling
  const mockNotify = new NotificationService('');
  const monitor = new PlayerMonitor('testBot', 32, 2.0, mockNotify);

  // Test with undefined runtimeId - MUST NOT CRASH
  let threw = false;
  try {
    monitor.handlePlayerMove(undefined, { x: 10, y: 64, z: 10 }, { x: 0, y: 64, z: 0 });
  } catch (err) {
    threw = true;
  }
  assert(!threw, 'handlePlayerMove with undefined runtimeId must not throw');

  // Test with null runtimeId - MUST NOT CRASH
  threw = false;
  try {
    monitor.handlePlayerMove(null, { x: 10, y: 64, z: 10 }, { x: 0, y: 64, z: 0 });
  } catch (err) {
    threw = true;
  }
  assert(!threw, 'handlePlayerMove with null runtimeId must not throw');

  // Test with malformed position - MUST NOT CRASH
  threw = false;
  try {
    monitor.handlePlayerMove('123', null as any, { x: 0, y: 64, z: 0 });
    monitor.handlePlayerMove('123', { x: NaN, y: 64, z: 0 } as any, { x: 0, y: 64, z: 0 });
  } catch (err) {
    threw = true;
  }
  assert(!threw, 'handlePlayerMove with malformed position must not throw');

  // Test valid player add and move tracking
  let notifiedCount = 0;
  (mockNotify as any).notifyPlayerDetected = async () => {
    notifiedCount++;
  };

  monitor.handlePlayerAdd(12345n, 'uuid-1', 'Steve', { x: 10, y: 64, z: 10 }, { x: 0, y: 64, z: 0 });
  assert(monitor.getTrackedPlayers().length === 1, 'Should track 1 player after add');
  assert(monitor.getTrackedPlayers()[0].username === 'Steve', 'Tracked player username should match');
  assert(notifiedCount === 1, 'Should notify once on player add');

  // Move player multiple times - MUST NOT SPAM NOTIFY
  monitor.handlePlayerMove(12345n, { x: 15, y: 64, z: 15 }, { x: 0, y: 64, z: 0 });
  monitor.handlePlayerMove(12345n, { x: 25, y: 64, z: 25 }, { x: 0, y: 64, z: 0 });
  assert(monitor.getTrackedPlayers()[0].position.x === 25, 'Tracked player position should update');
  assert(notifiedCount === 1, 'Should NOT send duplicate notifications on player move (no spam)');

  // Player removed, then re-added within 5m - should NOT spam notify
  monitor.handlePlayerRemove(12345n);
  assert(monitor.getTrackedPlayers().length === 0, 'Tracked players should be 0 after remove');
  monitor.handlePlayerAdd(12345n, 'uuid-1', 'Steve', { x: 10, y: 64, z: 10 }, { x: 0, y: 64, z: 0 });
  assert(notifiedCount === 1, 'Should NOT notify same player Steve again within 5m cooldown');

  // After 5m cooldown elapses, player re-detected - should notify
  const testNow = Date.now;
  try {
    Date.now = () => testNow() + 5 * 60 * 1000 + 1000;
    monitor.handlePlayerAdd(12345n, 'uuid-1', 'Steve', { x: 10, y: 64, z: 10 }, { x: 0, y: 64, z: 0 });
    assert(notifiedCount === 2, 'Should notify same player after 5m cooldown');
  } finally {
    Date.now = testNow;
  }

  console.log('✔ PlayerMonitor single notification (no spam on move) & re-detection tests passed.');

  // 5b. Test fellow bot mutual ignore in PlayerMonitor
  const { AccountManager } = require('../src/network/AccountManager');
  AccountManager.registerBotName('FellowBot');
  AccountManager.registerBotName('.FellowBotGeyser');
  AccountManager.registerBotRuntimeId(99999n);

  let botNotified = false;
  (mockNotify as any).notifyPlayerDetected = () => {
    botNotified = true;
  };

  // Bot 1 detects FellowBot by username
  monitor.handlePlayerAdd(99991n, 'uuid-bot', 'FellowBot', { x: 5, y: 64, z: 5 }, { x: 0, y: 64, z: 0 });
  assert(!botNotified, 'Must NOT notify for registered fellow bot username');

  // Bot 1 detects fellow bot with geyser prefix .FellowBotGeyser
  monitor.handlePlayerAdd(99992n, 'uuid-bot-2', '.FellowBotGeyser', { x: 5, y: 64, z: 5 }, { x: 0, y: 64, z: 0 });
  assert(!botNotified, 'Must NOT notify for fellow bot with prefix');

  // Bot 1 detects fellow bot by runtime entity ID
  monitor.handlePlayerAdd(99999n, 'uuid-bot-3', 'SomeUnknownIgn', { x: 5, y: 64, z: 5 }, { x: 0, y: 64, z: 0 });
  assert(!botNotified, 'Must NOT notify for fellow bot with registered runtime ID');

  // 5c. Test trusted player ignore list
  const ignoreStorage = require('../src/storage/IgnoreListStorage').IgnoreListStorage;
  await ignoreStorage.addPlayer('TrustedFriend');
  let trustedNotified = false;
  (mockNotify as any).notifyPlayerDetected = () => {
    trustedNotified = true;
  };

  monitor.handlePlayerAdd(77777n, 'uuid-friend', 'TrustedFriend', { x: 5, y: 64, z: 5 }, { x: 0, y: 64, z: 0 });
  assert(!trustedNotified, 'Must NOT notify for trusted player on ignore list');

  monitor.handlePlayerAdd(77778n, 'uuid-friend-2', '.TrustedFriend', { x: 5, y: 64, z: 5 }, { x: 0, y: 64, z: 0 });
  assert(!trustedNotified, 'Must NOT notify for trusted player with prefix');

  await ignoreStorage.removePlayer('TrustedFriend');
  console.log('✔ Fellow bot mutual ignore and trusted player ignore tests passed.');

  // 5d. Test AFKSpotTracker persistence and pauseForDisconnect
  const afkTrackerClass = require('../src/features/AFKSpotTracker').AFKSpotTracker;
  const afkTracker = new afkTrackerClass('TestBot1', 'node-1', 300000, 10.0);
  let homeCommandsIssued: string[] = [];
  let botPos = { x: 100, y: 64, z: 200 };

  afkTracker.setCallbacks(
    (cmd: string) => homeCommandsIssued.push(cmd),
    () => botPos,
    () => true
  );

  await afkTracker.activateAfkMode();
  assert(afkTracker.getSavedSpot() !== null, 'Saved AFK spot should exist after activation');
  assert(afkTracker.getSavedSpot()?.x === 100, 'Saved AFK spot X should match');

  // Simulate session cleanup (disconnect)
  afkTracker.pauseForDisconnect();
  assert(afkTracker.getSavedSpot() !== null, 'AFK spot MUST NOT be cleared on pauseForDisconnect');

  // Simulate restore on reconnection
  afkTracker.restoreFromStorage(afkTracker.getSavedSpot()!);
  assert(afkTracker.isActive(), 'Tracker should be active after restoreFromStorage');

  // Drift test: move bot 20 blocks away
  botPos = { x: 120, y: 64, z: 200 };
  afkTracker.checkPositionAndEnforceHome();
  assert(homeCommandsIssued.includes('/home 1'), 'Must issue /home 1 when drifted > 10 blocks');

  await afkTracker.deactivateAfkMode(true);
  console.log('✔ AFKSpotTracker persistence, disconnect preservation & 5m drift check tests passed.');

  // 6. Test Bedrock 1.26.45 packet serialization for KeepAlive Engine
  // @ts-ignore
  const { createSerializer } = require('bedrock-protocol/src/transforms/serializer');
  const serializer = createSerializer('1.26.45');

  // Verify player_auth_input serialization
  const authInputBuf = serializer.createPacketBuffer({
    name: 'player_auth_input',
    params: {
      pitch: 0,
      yaw: 0,
      position: { x: 100, y: 64, z: -200 },
      move_vector: { x: 0, z: 0 },
      head_yaw: 0,
      input_data: null,
      input_mode: 'mouse',
      play_mode: 'screen',
      interaction_model: 'crosshair',
      interact_rotation: { x: 0, z: 0 },
      tick: 42n,
      delta: { x: 0, y: 0, z: 0 },
      transaction_presence: false,
      transaction: null,
      item_stack_request_presence: false,
      item_stack_request: null,
      block_action_presence: false,
      block_action: null,
      vehicle_rotation_presence: false,
      vehicle_rotation: null,
      predicted_vehicle_presence: false,
      predicted_vehicle: null,
      analogue_move_vector: { x: 0, z: 0 },
      camera_orientation: { x: 0, y: 0, z: 0 },
      raw_move_vector: { x: 0, z: 0 },
    },
  });
  assert(Buffer.isBuffer(authInputBuf) && authInputBuf.length > 0, 'player_auth_input must serialize to valid buffer');

  // Verify tick_sync serialization
  const tickSyncBuf = serializer.createPacketBuffer({
    name: 'tick_sync',
    params: { request_time: 100n, response_time: 0n },
  });
  assert(Buffer.isBuffer(tickSyncBuf) && tickSyncBuf.length > 0, 'tick_sync must serialize to valid buffer');

  // Verify network_stack_latency serialization
  const latencyBuf = serializer.createPacketBuffer({
    name: 'network_stack_latency',
    params: { timestamp: 99999n, needs_response: 0 },
  });
  assert(Buffer.isBuffer(latencyBuf) && latencyBuf.length > 0, 'network_stack_latency must serialize to valid buffer');
  console.log('✔ Bedrock 1.26.45 KeepAlive packet serialization tests passed.');

  // 7. Test Bedrock 1.26.45 command_request packet serialization
  const commandReqBuf = serializer.createPacketBuffer({
    name: 'command_request',
    params: {
      command: '/tpaccept',
      origin: {
        type: 'player',
        uuid: '00000000-0000-0000-0000-000000000000',
        request_id: '',
        player_entity_id: 0n,
      },
      internal: false,
      version: 'latest',
    },
  });
  assert(Buffer.isBuffer(commandReqBuf) && commandReqBuf.length > 0, 'command_request must serialize to valid buffer');
  console.log('✔ Bedrock 1.26.45 command_request packet serialization test passed.');

  // 8. Test Bedrock 1.26.45 player_auth_input with dynamic input flags (sneaking, jumping, item use)
  const dynamicAuthInputBuf = serializer.createPacketBuffer({
    name: 'player_auth_input',
    params: {
      pitch: 0,
      yaw: 0,
      position: { x: 0, y: 64, z: 0 },
      move_vector: { x: 0, z: 0 },
      head_yaw: 0,
      input_data: ['sneaking', 'jumping', 'start_jumping', 'start_using_item', 'missed_swing'],
      input_mode: 'mouse',
      play_mode: 'screen',
      interaction_model: 'crosshair',
      interact_rotation: { x: 0, z: 0 },
      tick: 1n,
      delta: { x: 0, y: 0, z: 0 },
      transaction_presence: false,
      transaction: null,
      item_stack_request_presence: false,
      item_stack_request: null,
      block_action_presence: false,
      block_action: null,
      vehicle_rotation_presence: false,
      vehicle_rotation: null,
      predicted_vehicle_presence: false,
      predicted_vehicle: null,
      analogue_move_vector: { x: 0, z: 0 },
      camera_orientation: { x: 0, y: 0, z: 0 },
      raw_move_vector: { x: 0, z: 0 },
    },
  });
  assert(Buffer.isBuffer(dynamicAuthInputBuf) && dynamicAuthInputBuf.length > 0, 'player_auth_input with flags must serialize');
  console.log('✔ Bedrock 1.26.45 player_auth_input with dynamic action flags test passed.');

  // 9. Test ActionController state management and toggles
  const queuedPackets: { name: string; params: any }[] = [];
  const mockClient: any = {
    queue: (name: string, params: any) => {
      queuedPackets.push({ name, params });
    },
  };

  const actionCtrl = new ActionController(
    'testBot',
    () => mockClient,
    () => 12345n,
    () => ({ x: 0, y: 64, z: 0 }),
    () => null
  );

  // Test Crouch
  assert(actionCtrl.isCrouching === false, 'Initially not crouching');
  actionCtrl.toggleCrouch(true);
  assert(actionCtrl.isCrouching === true, 'Crouching should be true');
  assert(queuedPackets.some((p) => p.name === 'player_action' && p.params.action === 'start_sneak'), 'Must queue start_sneak');
  assert(queuedPackets.some((p) => p.name === 'player_input' && p.params.sneaking === true), 'Must queue player_input sneaking');

  actionCtrl.toggleCrouch(false);
  assert(actionCtrl.isCrouching === false, 'Crouching should be false');
  assert(queuedPackets.some((p) => p.name === 'player_action' && p.params.action === 'stop_sneak'), 'Must queue stop_sneak');

  // Test Jump
  actionCtrl.toggleJump(true);
  assert(actionCtrl.isJumping === true, 'Jumping should be true');
  assert(queuedPackets.some((p) => p.name === 'player_action' && p.params.action === 'jump'), 'Must queue jump');
  actionCtrl.toggleJump(false);
  assert(actionCtrl.isJumping === false, 'Jumping should be false');

  // Test Right Click
  actionCtrl.toggleRightClick(true);
  assert(actionCtrl.isRightClicking === true, 'RightClicking should be true');
  assert(queuedPackets.some((p) => p.name === 'inventory_transaction'), 'Must queue inventory_transaction item_use');
  actionCtrl.toggleRightClick(false);
  assert(actionCtrl.isRightClicking === false, 'RightClicking should be false');
  assert(queuedPackets.some((p) => p.name === 'player_action' && p.params.action === 'stop_item_use_on'), 'Must queue stop_item_use_on on release');

  // Test Left Click
  actionCtrl.toggleLeftClick(true);
  assert(queuedPackets.some((p) => p.name === 'animate' && p.params.action_id === 'swing_arm'), 'Must queue swing_arm');
  assert(queuedPackets.some((p) => p.name === 'player_action' && p.params.action === 'missed_swing'), 'Must queue missed_swing');

  // Test Spam Left Click
  actionCtrl.toggleSpamClick(true, 50, 150);
  assert(actionCtrl.isSpamClicking === true, 'SpamClicking should be true');
  assert(actionCtrl.spamMinDelay === 50 && actionCtrl.spamMaxDelay === 150, 'Min and max delay should be 50 and 150');
  actionCtrl.toggleSpamClick(false);
  assert(actionCtrl.isSpamClicking === false, 'SpamClicking should be false');

  // Test stopAll
  actionCtrl.toggleCrouch(true);
  actionCtrl.toggleJump(true);
  actionCtrl.stopAll();
  const finalStates = actionCtrl.getStates();
  assert(
    !finalStates.isCrouching && !finalStates.isJumping && !finalStates.isLeftClicking && !finalStates.isRightClicking && !finalStates.isSpamClicking,
    'All action states must be false after stopAll'
  );

  // Test Look Controls
  let mockPitch = 0;
  let mockYaw = 0;
  const mockEngine: any = {
    pitch: 0,
    yaw: 0,
    smoothLook: (dPitch: number, dYaw: number) => {
      mockPitch += dPitch;
      mockYaw += dYaw;
    },
  };
  const lookCtrl = new ActionController(
    'testBot',
    () => mockClient,
    () => 12345n,
    () => ({ x: 0, y: 64, z: 0 }),
    () => mockEngine
  );
  lookCtrl.look('up', 15);
  assert(mockPitch === -15, `Look up should decrease pitch by 15, got ${mockPitch}`);
  lookCtrl.look('down', 30);
  assert(mockPitch === 15, `Look down should increase pitch by 30 (-15 + 30 = 15), got ${mockPitch}`);
  lookCtrl.look('right', 45);
  assert(mockYaw === 45, `Look right should increase yaw by 45, got ${mockYaw}`);
  lookCtrl.look('left', 20);
  assert(mockYaw === 25, `Look left should decrease yaw by 20 (45 - 20 = 25), got ${mockYaw}`);
  console.log('✔ ActionController look directional tests passed.');

  // 10. Test AutoRespawn debouncing and instant execution
  const autoRespawn = new AutoRespawn('testBot');
  let respawnTriggered = 0;
  autoRespawn.setRespawnCallback(() => {
    respawnTriggered++;
  });

  autoRespawn.handleDeath('first_death');
  assert(autoRespawn.getIsDead() === true, 'AutoRespawn should mark isDead = true');
  assert(respawnTriggered === 1, 'Respawn callback should trigger instantly on death');
  // Immediately send another death event (should debounce and be ignored)
  autoRespawn.handleDeath('second_death_duplicate');
  assert(respawnTriggered === 1, 'Duplicate death signal must be suppressed');

  autoRespawn.cancel();
  assert(autoRespawn.getIsDead() === false, 'cancel() should reset isDead to false');
  console.log('✔ AutoRespawn instant execution and debouncing test passed.');

  // 11. Test Watchdog reliability: reconnects on any kick reason, ghost session backoff, stop/start
  const watchdog = new Watchdog('testBot', 100);
  let reconnectCount = 0;
  watchdog.setReconnectCallback(async () => {
    reconnectCount++;
  });

  // Disconnect with generic kick reason -> must schedule and reconnect
  watchdog.handleDisconnect('Kicked for flying');
  assert(watchdog.isRunning() === true, 'Watchdog should be running');
  await new Promise((r) => setTimeout(r, 150));
  assert(reconnectCount === 1, `Watchdog should have executed reconnect callback, count: ${reconnectCount}`);

  // Disconnect with auth error reason -> must still schedule and reconnect ("no matter why bot got kicked")
  watchdog.handleDisconnect('403 Forbidden - Authentication failed');
  await new Promise((r) => setTimeout(r, 150));
  assert(reconnectCount === 2, `Watchdog should reconnect even after auth error, count: ${reconnectCount}`);

  // Manual stop -> should NOT reconnect
  watchdog.stop();
  assert(watchdog.isRunning() === false, 'Watchdog should not be running after stop()');
  watchdog.handleDisconnect('Ping timed out');
  await new Promise((r) => setTimeout(r, 150));
  assert(reconnectCount === 2, 'Watchdog should not reconnect when stopped');

  // Start -> resumes reconnection
  watchdog.start();
  assert(watchdog.isRunning() === true, 'Watchdog should be running after start()');
  watchdog.handleDisconnect('Server closed connection');
  await new Promise((r) => setTimeout(r, 150));
  assert(reconnectCount === 3, 'Watchdog should reconnect after start()');

  console.log('✔ Watchdog kick reconnect and start/stop lifecycle tests passed.');

  // 12. Test PlayerHitResponse randomized look rotation and 2x crouch execution
  const hitResponse = new PlayerHitResponse('testBot', true, 2, 100);
  let lookTriggeredCount = 0;
  let receivedDeltaPitch = 0;
  let receivedDeltaYaw = 0;
  const crouchSequence: boolean[] = [];

  hitResponse.setLookCallback((dPitch, dYaw) => {
    lookTriggeredCount++;
    receivedDeltaPitch = dPitch;
    receivedDeltaYaw = dYaw;
  });

  hitResponse.setCrouchCallback((isSneaking) => {
    crouchSequence.push(isSneaking);
  });

  hitResponse.handlePlayerHit();
  // Wait for look (150ms) + 2x crouch (4x 200ms = 800ms) + buffer
  await new Promise((r) => setTimeout(r, 1100));

  assert(lookTriggeredCount > 0, 'Look callback should have been invoked on player hit');
  assert(receivedDeltaPitch >= -16 && receivedDeltaPitch <= 16, 'Random delta pitch should be in reasonable range');
  assert(receivedDeltaYaw >= -71 && receivedDeltaYaw <= 71, 'Random delta yaw should be in reasonable range');
  assert(crouchSequence.length === 4, `Crouch sequence should have 4 transitions (2x ON/OFF), got ${crouchSequence.length}`);
  assert(crouchSequence[0] === true && crouchSequence[1] === false, 'First crouch should cycle true then false');
  assert(crouchSequence[2] === true && crouchSequence[3] === false, 'Second crouch should cycle true then false');
  console.log('✔ PlayerHitResponse randomized look and 2x crouch sequence tests passed.');

  // 13. Test NotificationService Discord Embed 1-item-per-line (inline: false) and formatting
  let interceptedEmbed: any = null;
  const testNotify = new NotificationService('http://mock.endpoint');
  (testNotify as any).sendWebhook = async (embed: any) => {
    interceptedEmbed = embed;
  };

  await testNotify.notifyPlayerDetected({
    name: 'Gamer123',
    position: { x: 100, y: 70, z: -200 },
    distance: 12.5,
    accountId: '1',
  });

  assert(interceptedEmbed !== null, 'Embed should be created');
  assert(interceptedEmbed.title.includes('PLAYER DETECTED'), 'Embed title should have header text');
  assert(interceptedEmbed.fields.length === 4, 'Embed should have 4 fields');
  assert(interceptedEmbed.fields.every((f: any) => f.inline === false), 'Every embed field must have inline: false (1 thing per line)');
  // 14. Test LocationStorage and AFKSpotTracker persistence
  const { LocationStorage } = require('../src/storage/LocationStorage');
  const { AFKSpotTracker } = require('../src/features/AFKSpotTracker');
  
  // Test save and retrieve location
  LocationStorage.saveLocation('testBot99', { x: -100, y: 64, z: 250 });
  const retrievedLoc = LocationStorage.getLocation('testBot99');
  assert(retrievedLoc !== null, 'Location should be retrieved from LocationStorage');
  assert(retrievedLoc.x === -100 && retrievedLoc.y === 64 && retrievedLoc.z === 250, 'Retrieved coordinates should match');

  // Test AFKSpotTracker activate and check
  let sethomeExecuted = '';
  let homeExecuted = '';
  let currentTestPos = { x: -100, y: 64, z: 250 };
  const tracker = new AFKSpotTracker('testBot99', 'node-1', 300000, 3.0);
  tracker.setCallbacks(
    (cmd: string) => {
      if (cmd.startsWith('/sethome')) sethomeExecuted = cmd;
      if (cmd.startsWith('/home')) homeExecuted = cmd;
    },
    () => currentTestPos,
    () => true
  );

  tracker.activateAfkMode();
  assert(sethomeExecuted === '/sethome 1', 'AFK mode activation should issue /sethome 1');
  assert(tracker.isActive() === true, 'AFKSpotTracker should be active');

  // Move within tolerance (2 blocks) - should NOT trigger /home 1
  currentTestPos = { x: -100, y: 64, z: 252 };
  tracker.checkPositionAndEnforceHome();
  assert(homeExecuted === '', 'Small movement within 3.0 blocks tolerance should not trigger /home 1');

  // Move beyond tolerance (5 blocks) - SHOULD trigger /home 1
  currentTestPos = { x: -100, y: 64, z: 256 };
  tracker.checkPositionAndEnforceHome();
  assert(homeExecuted === '/home 1', 'Movement beyond 3.0 blocks tolerance must trigger /home 1');

  // Clean up test location
  tracker.deactivateAfkMode();
  LocationStorage.removeLocation('testBot99');
  assert(LocationStorage.getLocation('testBot99') === null, 'Test location should be removed');
  console.log('✔ LocationStorage & AFKSpotTracker tolerance and persistence tests passed.');

  // 15. Test DiscordControlEmbed formatting (no emojis, non-animated, 4 buttons)
  const { DiscordControlEmbed } = require('../src/discord/DiscordControlEmbed');
  const mockBot: any = {
    accountId: '1',
    xboxUsername: 'CruelWater4427',
    inGameIgn: '.CruelWater4427',
    currentPosition: { x: -3780, y: 128, z: 2996 },
    getState: () => 'CONNECTED',
  };

  const embed = DiscordControlEmbed.buildControlEmbed(mockBot);
  assert(embed.data.description.includes('GamerTag: CruelWater4427'), 'Embed must include GamerTag');
  assert(embed.data.description.includes('IGN: .CruelWater4427'), 'Embed must include IGN');
  assert(embed.data.description.includes('Status: Online'), 'Embed must state Online');
  assert(embed.data.description.includes('Location: -3780-128-2996'), 'Embed must format Location as X-Y-Z');
  // Strict check: no emojis in description
  const emojiRegex = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/u;
  assert(!emojiRegex.test(embed.data.description), 'Control embed must NOT contain emojis');

  const buttonRows = DiscordControlEmbed.buildControlButtons(mockBot);
  assert(buttonRows.length === 2, 'Should have 2 action rows of control buttons');
  const row1 = buttonRows[0].components;
  const row2 = buttonRows[1].components;
  assert(row1.length === 3, 'Row 1 should have 3 buttons (Tpaccept, Join, Leave)');
  assert(row2.length === 3, 'Row 2 should have 3 buttons (Set Afk, UnAFK, Crouch)');
  assert(row1[0].data.label === 'Tpaccept', 'Button 1 must be Tpaccept');
  assert(row1[1].data.label === 'Join', 'Button 2 must be Join');
  assert(row1[2].data.label === 'Leave', 'Button 3 must be Leave');
  assert(row2[0].data.label.includes('Set Afk'), 'Button 4 must be Set Afk');
  assert(row2[1].data.label === 'UnAFK', 'Button 5 must be UnAFK');
  assert(row2[2].data.label.includes('Crouch'), 'Button 6 must be Crouch');
  const allBtns = [...row1, ...row2];
  for (const btn of allBtns) {
    assert(!emojiRegex.test(btn.data.label), `Button '${btn.data.label}' must NOT contain emojis`);
  }
  console.log('✔ DiscordControlEmbed and Button layout (no emojis, 6 buttons across 2 rows) tests passed.');

  // 16. Test PermissionStorage (Add, Check, Remove)
  const { PermissionStorage } = require('../src/storage/PermissionStorage');
  await PermissionStorage.addAllowedUser('999888777', 'TestUser#0001');
  assert(await PermissionStorage.isAllowed('999888777') === true, 'Added user should be allowed');
  assert(await PermissionStorage.isAllowed('123456789098765432') === false, 'Random user should not be allowed');
  
  const allUsers = await PermissionStorage.getAllAllowedUsers();
  assert(allUsers.some((u: any) => u.userId === '999888777'), 'All users list should include newly added user');

  await PermissionStorage.removeAllowedUser('999888777');
  assert(await PermissionStorage.isAllowed('999888777') === false, 'Removed user should no longer be allowed');
  console.log('✔ PermissionStorage (add, check, remove) tests passed.');

  // 17. Test IgnoreListStorage (Add, Case-Insensitive, Floodgate Prefix, Remove)
  const { IgnoreListStorage } = require('../src/storage/IgnoreListStorage');
  await IgnoreListStorage.addPlayer('FarmWorker1');
  assert(IgnoreListStorage.isIgnored('FarmWorker1') === true, 'FarmWorker1 should be ignored');
  assert(IgnoreListStorage.isIgnored('farmworker1') === true, 'Case-insensitive match should be ignored');
  assert(IgnoreListStorage.isIgnored('.FarmWorker1') === true, 'Floodgate prefix dot should be ignored');
  assert(IgnoreListStorage.isIgnored('OtherPlayer') === false, 'OtherPlayer should not be ignored');

  await IgnoreListStorage.removePlayer('FarmWorker1');
  assert(IgnoreListStorage.isIgnored('FarmWorker1') === false, 'FarmWorker1 should no longer be ignored');
  console.log('✔ IgnoreListStorage (case-insensitive, floodgate dot, add, remove) tests passed.');

  // 18. Test PlayerMonitor notification suppression for ignored player
  await IgnoreListStorage.addPlayer('SilentWorker');
  const alertFlags = { playerAlertSent: false, chestAlertSent: false };
  const mockNotificationForIgnore: any = {
    notifyPlayerDetected: () => {
      alertFlags.playerAlertSent = true;
    },
  };
  const testIgnorePlayerMonitor = new PlayerMonitor('testBot', 32, 2.0, mockNotificationForIgnore);
  
  // Ignored player entering range: MUST NOT SEND ALERT
  testIgnorePlayerMonitor.handlePlayerAdd(99991n, 'uuid-ign-1', 'SilentWorker', { x: 5, y: 64, z: 5 }, { x: 0, y: 64, z: 0 });
  assert(alertFlags.playerAlertSent === false, 'PlayerMonitor must suppress notification for ignored player');
  assert(testIgnorePlayerMonitor.getTrackedPlayers().length === 1, 'Player should still be tracked internally');

  // Non-ignored player entering range: MUST SEND ALERT
  testIgnorePlayerMonitor.handlePlayerAdd(99992n, 'uuid-ign-2', 'LoudRaider', { x: 5, y: 64, z: 5 }, { x: 0, y: 64, z: 0 });
  assert(alertFlags.playerAlertSent === true, 'PlayerMonitor must notify for non-ignored player');
  await IgnoreListStorage.removePlayer('SilentWorker');
  console.log('✔ PlayerMonitor ignore list suppression tests passed.');

  // 18b. Test PlayerMonitor 5-minute spam cooldown & instant new player detection
  const detectedEvents: string[] = [];
  const mockNotificationService: any = {
    notifyPlayerDetected: (data: any) => {
      detectedEvents.push(data.name);
    },
  };
  const rateLimitMonitor = new PlayerMonitor('testBot', 32, 2.0, mockNotificationService);

  // 1. First player "Alex" enters -> INSTANT alert
  rateLimitMonitor.handlePlayerAdd(101n, 'uuid-alex', 'Alex', { x: 10, y: 64, z: 10 }, { x: 0, y: 64, z: 0 });
  assert(detectedEvents.length === 1 && detectedEvents[0] === 'Alex', 'New player Alex should trigger instant alert');

  // 2. Same player Alex moves closer and further (high frequency movements) -> NO extra alerts (cooldown active)
  rateLimitMonitor.handlePlayerMove(101n, { x: 5, y: 64, z: 5 }, { x: 0, y: 64, z: 0 });
  rateLimitMonitor.handlePlayerMove(101n, { x: 2, y: 64, z: 2 }, { x: 0, y: 64, z: 0 });
  rateLimitMonitor.handlePlayerMove(101n, { x: 1, y: 64, z: 1 }, { x: 0, y: 64, z: 0 });
  assert(detectedEvents.length === 1, 'Same player Alex moving within 5m must NOT spam alerts');

  // 3. Second player "Bob" enters -> INSTANT alert for new player Bob
  rateLimitMonitor.handlePlayerAdd(102n, 'uuid-bob', 'Bob', { x: 8, y: 64, z: 8 }, { x: 0, y: 64, z: 0 });
  assert(detectedEvents.length === 2 && detectedEvents[1] === 'Bob', 'New player Bob should trigger instant alert');

  // 4. Bob moves around -> NO extra alerts
  rateLimitMonitor.handlePlayerMove(102n, { x: 4, y: 64, z: 4 }, { x: 0, y: 64, z: 0 });
  assert(detectedEvents.length === 2, 'Same player Bob moving within 5m must NOT spam alerts');

  // 5. Alex steps outside chunk radius and comes back within 5m -> NO extra alert
  rateLimitMonitor.handlePlayerMove(101n, { x: 1000, y: 64, z: 1000 }, { x: 0, y: 64, z: 0 }); // out of radius
  rateLimitMonitor.handlePlayerAdd(101n, 'uuid-alex', 'Alex', { x: 5, y: 64, z: 5 }, { x: 0, y: 64, z: 0 }); // back in radius
  assert(detectedEvents.length === 2, 'Border-hopping within 5m must NOT trigger duplicate alert');

  // 6. Advance time by 5 minutes (300,001 ms) -> Alex moves -> alert dispatched!
  const realDateNow = Date.now;
  try {
    const fakeTime = realDateNow() + (5 * 60 * 1000 + 1000);
    Date.now = () => fakeTime;

    rateLimitMonitor.handlePlayerMove(101n, { x: 6, y: 64, z: 6 }, { x: 0, y: 64, z: 0 });
    assert(detectedEvents.length === 3 && detectedEvents[2] === 'Alex', 'Alex moving after 5 minutes should trigger alert');

    // Moving again immediately after -> suppressed
    rateLimitMonitor.handlePlayerMove(101n, { x: 7, y: 64, z: 7 }, { x: 0, y: 64, z: 0 });
    assert(detectedEvents.length === 3, 'Alex moving immediately after 5m alert must be suppressed again');
  } finally {
    Date.now = realDateNow;
  }
  console.log('✔ PlayerMonitor 5-minute same-player rate limit & instant new player detection tests passed.');

  // 19. Test ContainerMonitor notification suppression for ignored player
  await IgnoreListStorage.addPlayer('FarmHelper');
  const mockContainerNotifyForIgnore: any = {
    notifyContainerActivity: () => {
      alertFlags.chestAlertSent = true;
    },
  };
  const { ContainerMonitor } = require('../src/features/ContainerMonitor');
  const testIgnoreContainerMonitor = new ContainerMonitor('testBot', 32, mockContainerNotifyForIgnore);

  // Ignored player accesses chest: MUST NOT SEND ALERT
  await testIgnoreContainerMonitor.handleContainerInteraction(
    { x: 0, y: 64, z: 0 },
    'Chest',
    { x: 2, y: 64, z: 2 },
    'FarmHelper'
  );
  assert(alertFlags.chestAlertSent === false, 'ContainerMonitor must suppress notification for ignored player');

  // Non-ignored player accesses chest: MUST SEND ALERT
  await testIgnoreContainerMonitor.handleContainerInteraction(
    { x: 0, y: 64, z: 0 },
    'Chest',
    { x: 2, y: 64, z: 2 },
    'UnknownThief'
  );
  assert(alertFlags.chestAlertSent === true, 'ContainerMonitor must notify for non-ignored player');
  await IgnoreListStorage.removePlayer('FarmHelper');
  console.log('✔ ContainerMonitor ignore list suppression tests passed.');

  console.log('\nAll unit tests passed successfully!');
}

runTests().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
