import { Client } from 'bedrock-protocol';
import { logger } from '../utils/logger';

export interface Vector3D {
  x: number;
  y: number;
  z: number;
}

export class KeepAliveEngine {
  private client: Client;
  private accountId: string;
  private isRunning: boolean = false;
  private tickInterval: NodeJS.Timeout | null = null;
  private clientTick: bigint = 0n;
  private ticksElapsed: number = 0;

  public position: Vector3D = { x: 0, y: 0, z: 0 };
  public pitch: number = 0;
  public yaw: number = 0;
  public headYaw: number = 0;

  private inputFlags: Set<string> = new Set();
  private jumpTicksRemaining: number = 0;
  private jumpBaseY: number = 0;
  private swingTicksRemaining: number = 0;
  private itemUseTicksRemaining: number = 0;
  private moveTicksRemaining: number = 0;
  private moveStepX: number = 0;
  private moveStepZ: number = 0;

  private onLatencyBound: ((packet: any) => void) | null = null;
  private onTickSyncBound: ((packet: any) => void) | null = null;
  private onCorrectionBound: ((packet: any) => void) | null = null;

  constructor(client: Client, accountId: string, initialPosition?: Vector3D) {
    this.client = client;
    this.accountId = accountId;
    if (initialPosition) {
      this.position = { ...initialPosition };
    }
  }

  public updatePosition(pos: Vector3D): void {
    if (pos && typeof pos.x === 'number' && typeof pos.y === 'number' && typeof pos.z === 'number') {
      // If actively jumping, keep jumpBaseY in sync
      if (this.jumpTicksRemaining > 0) {
        this.jumpBaseY = pos.y;
      } else {
        this.position = { x: pos.x, y: pos.y, z: pos.z };
      }
    }
  }

  public updateRotation(pitch: number, yaw: number, headYaw?: number): void {
    this.pitch = pitch;
    this.yaw = yaw;
    this.headYaw = headYaw ?? yaw;
  }

  /**
   * Smoothly adjusts head/crosshair orientation over several ticks
   * for realistic and accurate fine adjustments.
   */
  public smoothLook(deltaPitch: number, deltaYaw: number, steps: number = 5, stepIntervalMs: number = 25): void {
    if (steps <= 1) {
      let newPitch = Math.max(-90, Math.min(90, this.pitch + deltaPitch));
      let newYaw = this.yaw + deltaYaw;
      while (newYaw > 180) newYaw -= 360;
      while (newYaw < -180) newYaw += 360;
      this.updateRotation(newPitch, newYaw);
      return;
    }

    const stepPitch = deltaPitch / steps;
    const stepYaw = deltaYaw / steps;
    let stepCount = 0;

    const interval = setInterval(() => {
      stepCount++;
      let newPitch = Math.max(-90, Math.min(90, this.pitch + stepPitch));
      let newYaw = this.yaw + stepYaw;
      while (newYaw > 180) newYaw -= 360;
      while (newYaw < -180) newYaw += 360;
      this.updateRotation(newPitch, newYaw);

      if (stepCount >= steps) {
        clearInterval(interval);
      }
    }, stepIntervalMs);
  }

  public addInputFlag(flag: string): void {
    this.inputFlags.add(flag);
  }

  public removeInputFlag(flag: string): void {
    this.inputFlags.delete(flag);
  }

  public clearInputFlags(): void {
    this.inputFlags.clear();
    this.isSneakingState = false;
    this.stopSneakTicks = 0;
    this.itemUseTicksRemaining = 0;
  }

  private isSneakingState: boolean = false;
  private stopSneakTicks: number = 0;

  /**
   * Toggles sneak state with proper Geyser / Bedrock transition flags:
   * Keeps sneaking, sneak_down, change_height, and start_sneaking active while crouching,
   * and pulses stop_sneaking for 5 ticks on release.
   */
  public setSneak(enabled: boolean): void {
    if (this.isSneakingState === enabled) return;
    this.isSneakingState = enabled;
    if (enabled) {
      this.stopSneakTicks = 0;
    } else {
      this.stopSneakTicks = 5; // pulse stop_sneaking for 5 ticks
    }
  }

  /**
   * Triggers a realistic client-side jump arc (~8 ticks / 400ms).
   * Calculates delta.y and updates position.y each tick so server/anticheat registers movement.
   */
  public triggerJump(): void {
    if (this.jumpTicksRemaining <= 0) {
      this.jumpBaseY = this.position.y;
    }
    this.jumpTicksRemaining = 8;
  }

  /**
   * Injects missed_swing into player_auth_input for 2 ticks to trigger client swing on Geyser/Bedrock.
   */
  public queueSwing(): void {
    this.swingTicksRemaining = 2;
  }

  /**
   * Injects item interaction and block action flags into player_auth_input for 3 ticks.
   */
  public triggerItemUse(): void {
    this.itemUseTicksRemaining = 3;
  }

  /**
   * Moves the bot forward by a fixed distance in whatever direction it's currently looking,
   * spread over `steps` ticks of the main tick() loop.
   */
  public moveForward(distanceBlocks: number, steps: number = 8): void {
    if (!distanceBlocks || distanceBlocks <= 0) return;

    const yawRad = (this.yaw * Math.PI) / 180;
    const dx = -Math.sin(yawRad) * distanceBlocks;
    const dz = Math.cos(yawRad) * distanceBlocks;

    this.moveStepX = dx / steps;
    this.moveStepZ = dz / steps;
    this.moveTicksRemaining = steps;
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.clientTick = 0n;
    this.ticksElapsed = 0;

    logger.info('Starting Bedrock 20Hz KeepAlive & Input Engine (Boar anticheat watchdog bypass)', this.accountId);

    // Remove any existing default network_stack_latency listeners to avoid unscaled conflicts
    this.client.removeAllListeners('network_stack_latency');

    // Boar anticheat latency response listener
    this.onLatencyBound = (packet: any) => {
      try {
        const rawTs = BigInt(packet.timestamp);
        // Boar divides by LATENCY_MAGNITUDE (1,000,000L) to recover original tracking ID
        const scaledTs = rawTs * 1000000n;

        // 1. Send Boar-scaled response (essential to prevent "Boar > Timed out!" kick)
        this.client.queue('network_stack_latency', {
          timestamp: scaledTs,
          needs_response: 0,
        });

        // 2. Also send raw timestamp for vanilla Geyser FIFO ping cache
        this.client.queue('network_stack_latency', {
          timestamp: rawTs,
          needs_response: 0,
        });

        logger.debug(`Handled network_stack_latency (raw: ${rawTs}, scaled: ${scaledTs})`, this.accountId);
      } catch (err) {
        logger.debug('Failed to send network_stack_latency response', this.accountId);
      }
    };

    this.onTickSyncBound = (packet: any) => {
      if (packet && packet.response_time != null) {
        try {
          this.clientTick = BigInt(packet.response_time);
        } catch {
          // Ignore bigint conversion errors
        }
      }
    };

    this.onCorrectionBound = (packet: any) => {
      if (packet) {
        if (packet.position && typeof packet.position.x === 'number') {
          this.position = {
            x: packet.position.x,
            y: packet.position.y,
            z: packet.position.z,
          };
          logger.debug(`Synchronized position with server prediction: (${this.position.x}, ${this.position.y}, ${this.position.z})`, this.accountId);
        }
        if (packet.tick != null) {
          try {
            this.clientTick = BigInt(packet.tick);
          } catch {
            // Ignore bigint conversion error
          }
        }
      }
    };

    this.client.on('network_stack_latency', this.onLatencyBound);
    this.client.on('tick_sync', this.onTickSyncBound);
    this.client.on('correct_player_move_prediction', this.onCorrectionBound);

    // Run 20Hz (50ms) client tick loop
    this.tickInterval = setInterval(() => {
      this.onTick();
    }, 50);
  }

  private static readonly ZERO_VEC2 = Object.freeze({ x: 0, z: 0 });
  private static readonly ZERO_VEC3 = Object.freeze({ x: 0, y: 0, z: 0 });
  private static readonly DEFAULT_GROUND_INPUT = Object.freeze(['vertical_collision']);
  private lastJumpingState: boolean = false;
  private lastSneakingState: boolean = false;

  private onTick(): void {
    if (!this.isRunning || !this.client) return;

    this.clientTick += 1n;
    this.ticksElapsed++;

    let deltaY = 0;
    let deltaX = 0;
    let deltaZ = 0;
    let inputDataArray: string[] | null = null;

    const hasDynamicActions =
      this.jumpTicksRemaining > 0 ||
      this.moveTicksRemaining > 0 ||
      this.swingTicksRemaining > 0 ||
      this.itemUseTicksRemaining > 0 ||
      this.isSneakingState ||
      this.stopSneakTicks > 0 ||
      this.inputFlags.size > 0;

    // Subtle anti-idle micro-look every 45 seconds (900 ticks) to reset server idle timer without swinging arm
    if (this.ticksElapsed % 900 === 0) {
      this.yaw = Number((this.yaw + 0.02).toFixed(4));
      this.headYaw = this.yaw;
    } else if (this.ticksElapsed % 900 === 450) {
      this.yaw = Number((this.yaw - 0.02).toFixed(4));
      this.headYaw = this.yaw;
    }

    if (!hasDynamicActions) {
      // FAST PATH: Zero object/set allocations when standing on ground
      inputDataArray = KeepAliveEngine.DEFAULT_GROUND_INPUT as unknown as string[];
      deltaY = 0;
    } else {
      // DYNAMIC PATH: Handle jumps, swings, sneak transitions
      const currentFlags = new Set(this.inputFlags);

      // When standing on ground (not jumping), signal vertical_collision
      if (this.jumpTicksRemaining <= 0) {
        currentFlags.add('vertical_collision');
        deltaY = 0;
      }

      // Process Jump Physics Arc
      if (this.jumpTicksRemaining > 0) {
        currentFlags.add('jumping');
        currentFlags.add('jump_down');
        if (this.jumpTicksRemaining === 8) {
          currentFlags.add('start_jumping');
        }

        // Physics trajectory across 8 ticks (400ms)
        if (this.jumpTicksRemaining >= 6) {
          deltaY = 0.42;
          this.position.y += 0.35;
        } else if (this.jumpTicksRemaining >= 4) {
          deltaY = 0.1;
          this.position.y += 0.1;
        } else if (this.jumpTicksRemaining >= 2) {
          deltaY = -0.25;
          this.position.y -= 0.2;
        } else {
          deltaY = -0.27;
          this.position.y = this.jumpBaseY;
        }

        this.jumpTicksRemaining--;
        if (this.jumpTicksRemaining === 0) {
          this.position.y = this.jumpBaseY;
        }
      }

      // Process queued horizontal movement
      if (this.moveTicksRemaining > 0) {
        currentFlags.add('start_moving');
        this.position.x += this.moveStepX;
        this.position.z += this.moveStepZ;
        deltaX = this.moveStepX;
        deltaZ = this.moveStepZ;
        this.moveTicksRemaining--;
      }

      // Process Swing Queue
      if (this.swingTicksRemaining > 0) {
        currentFlags.add('missed_swing');
        this.swingTicksRemaining--;
      }

      // Process Item Interaction / Block Action Queue
      if (this.itemUseTicksRemaining > 0) {
        currentFlags.add('start_using_item');
        currentFlags.add('perform_item_interaction');
        currentFlags.add('perform_block_actions');
        this.itemUseTicksRemaining--;
      }

      // Process Sneak Input Flags (Geyser InputCache detection)
      if (this.isSneakingState) {
        currentFlags.add('sneaking');
        currentFlags.add('sneak_down');
        currentFlags.add('sneak_current_raw');
        currentFlags.add('change_height');
        currentFlags.add('start_sneaking');
      } else if (this.stopSneakTicks > 0) {
        currentFlags.add('stop_sneaking');
        this.stopSneakTicks--;
      }

      inputDataArray = currentFlags.size > 0 ? Array.from(currentFlags) : null;
    }

    try {
      // Send player_auth_input packet required by server-authoritative movement & anticheat (Boar)
      // Uses pre-allocated frozen static templates for immutable sub-vectors to minimize V8 GC pressure
      this.client.queue('player_auth_input', {
        pitch: this.pitch,
        yaw: this.yaw,
        position: this.position,
        move_vector: (deltaX !== 0 || deltaZ !== 0) ? { x: 0, y: 1 } : KeepAliveEngine.ZERO_VEC2,
        head_yaw: this.headYaw,
        input_data: inputDataArray,
        input_mode: 'mouse',
        play_mode: 'screen',
        interaction_model: 'crosshair',
        interact_rotation: KeepAliveEngine.ZERO_VEC2,
        tick: this.clientTick,
        delta: (deltaX === 0 && deltaY === 0 && deltaZ === 0) ? KeepAliveEngine.ZERO_VEC3 : { x: deltaX, y: deltaY, z: deltaZ },
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
        analogue_move_vector: (deltaX !== 0 || deltaZ !== 0) ? { x: 0, y: 1 } : KeepAliveEngine.ZERO_VEC2,
        camera_orientation: KeepAliveEngine.ZERO_VEC3,
        raw_move_vector: (deltaX !== 0 || deltaZ !== 0) ? { x: 0, y: 1 } : KeepAliveEngine.ZERO_VEC2,
      });

      // Queue player_input only when jumping/sneaking state changes or once per second (every 20 ticks)
      const currentJumping = this.jumpTicksRemaining > 0;
      const currentSneaking = this.isSneakingState;
      const inputStateChanged =
        currentJumping !== this.lastJumpingState ||
        currentSneaking !== this.lastSneakingState;

      if (inputStateChanged || this.ticksElapsed % 20 === 0) {
        this.lastJumpingState = currentJumping;
        this.lastSneakingState = currentSneaking;
        this.client.queue('player_input', {
          motion_x: 0,
          motion_z: 0,
          jumping: currentJumping,
          sneaking: currentSneaking,
        });
      }
    } catch (err) {
      logger.debug('Error sending player_auth_input or player_input', this.accountId);
    }

    // Every 20 ticks (1 second), send a tick_sync keepalive
    if (this.ticksElapsed % 20 === 0) {
      try {
        this.client.queue('tick_sync', {
          request_time: this.clientTick,
          response_time: 0n,
        });
      } catch (err) {
        logger.debug('Error sending tick_sync keepalive', this.accountId);
      }
    }
  }

  public stop(): void {
    this.isRunning = false;
    this.jumpTicksRemaining = 0;
    this.swingTicksRemaining = 0;
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }

    if (this.client) {
      if (this.onLatencyBound) {
        this.client.removeListener('network_stack_latency', this.onLatencyBound);
        this.onLatencyBound = null;
      }
      if (this.onTickSyncBound) {
        this.client.removeListener('tick_sync', this.onTickSyncBound);
        this.onTickSyncBound = null;
      }
      if (this.onCorrectionBound) {
        this.client.removeListener('correct_player_move_prediction', this.onCorrectionBound);
        this.onCorrectionBound = null;
      }
    }
  }
}
