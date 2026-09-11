/**
 * Runtime patch for prismarine-auth LiveTokenManager.
 * Fixes a known bug in prismarine-auth where token.expires_in (returned in seconds by Microsoft OAuth)
 * was added directly to token.obtainedOn (milliseconds) without multiplying by 1000,
 * causing tokens to appear expired after only 86 seconds and forcing unnecessary re-authentication.
 */
export function applyPrismarineAuthPatch(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const LiveTokenManager = require('prismarine-auth/src/TokenManagers/LiveTokenManager');
    if (LiveTokenManager && LiveTokenManager.prototype) {
      LiveTokenManager.prototype.getAccessToken = async function () {
        const { token } = await this.cache.getCached();
        if (!token) return;
        const expiresInMs =
          token.expires_in && token.expires_in < 10000000
            ? token.expires_in * 1000
            : token.expires_in || 86400000;
        const until = new Date(token.obtainedOn + expiresInMs).getTime() - Date.now();
        const valid = until > 1000;
        return { valid, until, token: token.access_token };
      };

      LiveTokenManager.prototype.getRefreshToken = async function () {
        const { token } = await this.cache.getCached();
        if (!token || !token.refresh_token) return;
        const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
        const until = new Date((token.obtainedOn || Date.now()) + ninetyDaysMs).getTime() - Date.now();
        const valid = until > 1000;
        return { valid, until, token: token.refresh_token };
      };
    }
  } catch (err) {
    // Ignore if module resolution differs in certain testing environments
  }
}

/**
 * Runtime patch for bedrock-protocol Client.prototype.readPacket.
 * Fixes crashes and unnecessary disconnects caused by non-standard server NBT packets
 * (e.g. Geyser 0x38 block_entity_data PistonArm Invalid tag: 103 > 20 on DonutSMP).
 * Instead of dumping buffer and emitting fatal 'error' event to crash Node.js or disconnect,
 * it safely suppresses and skips unparseable decorative packets.
 */
export function applyBedrockProtocolPatch(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Client } = require('bedrock-protocol/src/client');
    if (Client && Client.prototype && !Client.prototype._patchedForNbtDesync) {
      Client.prototype._patchedForNbtDesync = true;
      const originalReadPacket = Client.prototype.readPacket;

      Client.prototype.readPacket = function (packet: any) {
        // If client is already disconnected or closing, discard in-flight packets
        if (this.status === 0 || !this.deserializer) {
          return;
        }

        try {
          // Pre-validate packet deserialization
          this.deserializer.parsePacketBuffer(packet);
        } catch (e: any) {
          // Safely discard unparseable server packet (e.g. Geyser 0x38 block_entity_data Invalid tag: 103 > 20)
          // NEVER dump failed buffer to stdout, NEVER emit fatal 'error', and NEVER disconnect the bot!
          return;
        }

        // Call original readPacket which will now safely succeed
        return originalReadPacket.call(this, packet);
      };
    }
  } catch (err) {
    // Ignore if module resolution differs in certain testing environments
  }
}

// Automatically apply when imported
applyPrismarineAuthPatch();
applyBedrockProtocolPatch();
