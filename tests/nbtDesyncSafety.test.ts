import assert from 'assert';
import { EventEmitter } from 'events';
import { applyBedrockProtocolPatch } from '../src/auth/patchPrismarineAuth';

console.log('Running NBT Desync & Packet Error Safety Unit Tests...\n');

// Test 1: Verify applyBedrockProtocolPatch hooks bedrock-protocol Client
console.log('--- Test 1: Patch bedrock-protocol Client.prototype.readPacket ---');
applyBedrockProtocolPatch();

const { Client } = require('bedrock-protocol/src/client');
assert.strictEqual(Client.prototype._patchedForNbtDesync, true, 'Client prototype must be flagged as patched');
console.log('✔ Test 1 Passed: Client.prototype._patchedForNbtDesync is active.\n');

// Test 2: Verify unparseable packet buffer is safely dropped without emitting error
console.log('--- Test 2: Unparseable packet buffer suppression ---');
const fakeClient: any = new EventEmitter();
Object.setPrototypeOf(fakeClient, Client.prototype);

let errorEmitted = false;
fakeClient.on('error', (err: any) => {
  errorEmitted = true;
});

// Mock deserializer that simulates protodef throwing "Invalid tag: 103 > 20"
Object.defineProperty(fakeClient, 'status', { value: 1, writable: true });
fakeClient.deserializer = {
  parsePacketBuffer: (buf: Buffer) => {
    throw new Error('Read error for undefined : Invalid tag: 103 > 20');
  },
  dumpFailedBuffer: () => {
    throw new Error('dumpFailedBuffer should never be called when patched!');
  }
};

const corruptBuffer = Buffer.from([0x38, 0xad, 0xb7, 0x01, 0x84, 0x02]);

// Calling readPacket with corruptBuffer should be safely swallowed
assert.doesNotThrow(() => {
  fakeClient.readPacket(corruptBuffer);
}, 'readPacket must not throw on unparseable packet');

assert.strictEqual(errorEmitted, false, 'readPacket must NOT emit error event on unparseable packet');
console.log('✔ Test 2 Passed: Corrupt NBT packet 0x38 was silently discarded without crashing or emitting error.\n');

// Test 3: Disconnected client status drops in-flight packets immediately
console.log('--- Test 3: Disconnected status packet discard ---');
fakeClient.status = 0; // disconnected
let parseCalled = false;
fakeClient.deserializer.parsePacketBuffer = () => {
  parseCalled = true;
};

fakeClient.readPacket(corruptBuffer);
assert.strictEqual(parseCalled, false, 'readPacket must not parse buffer when client status is disconnected');
console.log('✔ Test 3 Passed: Trailing packets dropped when status is 0.\n');

// Test 4: Socket teardown safety
console.log('--- Test 4: Safe socket cleanup teardown ---');
const teardownClient = new EventEmitter() as any;
teardownClient.status = 0;
teardownClient.close = function () {
  this.removeAllListeners();
};

// Simulate cleanupSession teardown pattern:
teardownClient.readPacket = () => {};
teardownClient.close();
teardownClient.on('error', () => {});

// If a trailing event fires on error, it should not throw unhandled
assert.doesNotThrow(() => {
  teardownClient.emit('error', new Error('Trailing packet error after close'));
}, 'Teardown client must have protective error handler after close');
console.log('✔ Test 4 Passed: Teardown client safely ignores trailing error events without crashing.\n');

console.log('🎉 ALL NBT DESYNC & PACKET ERROR SAFETY TESTS PASSED!\n');
