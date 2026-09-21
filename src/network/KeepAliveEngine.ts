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
  private getRuntimeEntityId: () => bigint | string | number;

  public isGrounded: boolean = true;
  public targetFloorY: number | null = null;
  private floatingTicks: number = 0;

  private onLatencyBound: ((packet: any) => void) | null = null;
  private onTickSyncBound: ((packet: any) => void) | null = null;
  private onCorrectionBound: ((packet: any) => void) | null = null;

  constructor(
    client: Client,
    accountId: string,
    initialPosition?: Vector3D,
    getRuntimeEntityId?: () => bigint | string | number,
    initialSneaking?: boolean
  ) {
    this.client = client;
    this.accountId = accountId;
    this.getRuntimeEntityId = getRuntimeEntityId || (() => 0n);
    if (initialPosition) {
      this.position = { ...initialPosition };
    }
    if (initialSneaking) {
      this.isSneakingState = true;
      this.isCrouchLocked = true;
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
    this.lastSneakingState = false;
    this.stopSneakTicks = 0;
    this.isContinuousJump = false;
    this.lastJumpingState = false;
    this.jumpTicksRemaining = 0;
    this.jumpCooldownTicks = 0;
    this.itemUseTicksRemaining = 0;
  }

  /**
   * Completely halts physics and clears destination/action targets.
   * Useful when arriving at home or after teleporting to avoid mid-air freezing.
   */
  public resetPhysicsAndClearTarget(): void {
    this.moveTicksRemaining = 0;
    this.moveStepX = 0;
    this.moveStepZ = 0;
    this.jumpTicksRemaining = 0;
    this.jumpCooldownTicks = 0;
    this.isContinuousJump = false;
    this.lastJumpingState = false;
    this.swingTicksRemaining = 0;
    this.itemUseTicksRemaining = 0;
    this.inputFlags.delete('jumping');
    this.inputFlags.delete('jump_down');
    this.inputFlags.delete('jump_current_raw');
    this.inputFlags.delete('start_jumping');
    this.inputFlags.delete('jump_pressed_raw');
    this.inputFlags.delete('jump_released_raw');
    this.inputFlags.delete('start_moving');
  }

  /**
   * Safely handles teleport landing.
   * Resets active momentum, updates position, and initiates safe descent or gravity fall if in mid-air.
   * Never prints falling log spam.
   */
  public handleTeleportLanding(pos: Vector3D, groundTargetY?: number, serverOnGround?: boolean): void {
    this.position = { x: pos.x, y: pos.y, z: pos.z };
    this.resetPhysicsAndClearTarget();

    if (serverOnGround === true) {
      this.isGrounded = true;
      this.targetFloorY = null;
      this.floatingTicks = 0;
      this.addInputFlag('vertical_collision');
    } else if (groundTargetY != null && pos.y > groundTargetY + 0.1) {
      // Bot is floating above the expected ground block
      this.isGrounded = false;
      this.targetFloorY = groundTargetY;
      this.floatingTicks = 0;
      this.inputFlags.delete('vertical_collision');
    } else if (serverOnGround === false) {
      // Mid-air landing without ground block: let gravity pull down naturally without freezing
      this.isGrounded = false;
      this.targetFloorY = null;
      this.floatingTicks = 0;
      this.inputFlags.delete('vertical_collision');
    } else {
      this.isGrounded = true;
      this.targetFloorY = null;
      this.floatingTicks = 0;
      this.addInputFlag('vertical_collision');
    }
  }

  public setGrounded(grounded: boolean): void {
    this.isGrounded = grounded;
    if (grounded) {
      this.targetFloorY = null;
      this.floatingTicks = 0;
      this.addInputFlag('vertical_collision');
    } else {
      this.inputFlags.delete('vertical_collision');
    }
  }

  private isSneakingState: boolean = false;
  private stopSneakTicks: number = 0;
  public isCrouchLocked: boolean = false;

  public isContinuousJump: boolean = false;
  private jumpCooldownTicks: number = 0;

  /**
   * Toggles sneak state with proper Geyser / Bedrock transition flags.
   * Keeps sneaking and sneak_down active while crouching.
   * When isLocked is true, prevents auto-uncrouch from other game systems.
   */
  public setSneak(enabled: boolean, isLocked?: boolean): void {
    if (isLocked !== undefined) {
      this.isCrouchLocked = isLocked;
    }
    // If crouch is locked ON, never allow background systems or game events to uncrouch the bot
    if (this.isCrouchLocked && !enabled) {
      return;
    }
    if (this.isSneakingState === enabled) {
      if (enabled) {
        this.sendSneakPlayerAction(true);
      }
      return;
    }
    this.isSneakingState = enabled;
    if (enabled) {
      this.stopSneakTicks = 0;
      this.sendSneakPlayerAction(true);
    } else {
      this.stopSneakTicks = 3; // pulse stop_sneaking transition for 3 ticks (150ms)
      this.sendSneakPlayerAction(false);
    }
  }

  private sendSneakPlayerAction(isSneaking: boolean): void {
    if (!this.client) return;
    try {
      const rid = this.getRuntimeEntityId ? this.getRuntimeEntityId() : 0n;
      const entityId = (rid != null && rid !== 0n && rid !== '0') ? BigInt(rid) : 1n;
      const blockPos = {
        x: Math.floor(this.position.x),
        y: Math.floor(this.position.y),
        z: Math.floor(this.position.z),
      };
      this.client.queue('player_action', {
        runtime_entity_id: entityId,
        action: isSneaking ? 'start_sneak' : 'stop_sneak',
        position: blockPos,
        result_position: blockPos,
        face: 0,
      });
      this.client.queue('player_input', {
        motion_x: 0,
        motion_z: 0,
        jumping: false,
        sneaking: isSneaking,
      });
    } catch (err) {
      logger.debug(`Error sending sneak player_action/player_input: ${err}`, this.accountId);
    }
  }

  /**
   * Toggles continuous jump state.
   */
  public setJump(enabled: boolean): void {
    this.isContinuousJump = enabled;
    if (enabled) {
      if (this.jumpTicksRemaining <= 0) {
        this.triggerJump();
      }
    } else {
      this.jumpTicksRemaining = 0;
      this.jumpCooldownTicks = 0;
      this.lastJumpingState = false;
      this.removeInputFlag('jumping');
      this.removeInputFlag('jump_down');
      this.removeInputFlag('start_jumping');
      this.removeInputFlag('jump_current_raw');
    }
  }

  /**
   * Triggers a realistic client-side jump arc (10 ticks / 500ms).
   * Calculates delta.y and updates position.y each tick with exact displacement matching.
   */
  public triggerJump(): void {
    if (this.jumpTicksRemaining <= 0) {
      this.jumpBaseY = this.position.y;
      this.jumpTicksRemaining = 10;
      this.jumpCooldownTicks = 0;

      const rid = this.getRuntimeEntityId ? this.getRuntimeEntityId() : 0n;
      const entityId = (rid != null && rid !== 0n && rid !== '0') ? BigInt(rid) : 1n;
      const blockPos = {
        x: Math.floor(this.position.x),
        y: Math.floor(this.position.y),
        z: Math.floor(this.position.z),
      };

      if (this.client) {
        try {
          this.client.queue('player_action', {
            runtime_entity_id: entityId,
            action: 'jump',
            position: blockPos,
            result_position: { x: 0, y: 0, z: 0 },
            face: 0,
          });
        } catch {}
      }
    }
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
  private static readonly EMPTY_INPUT_FLAGS: Record<string, boolean> = Object.freeze({}) as Record<string, boolean>;
  private lastJumpingState: boolean = false;
  private lastSneakingState: boolean = false;

  private onTick(): void {
    if (!this.isRunning || !this.client) return;

    this.clientTick += 1n;
    this.ticksElapsed++;

    let deltaY = 0;
    let deltaX = 0;
    let deltaZ = 0;
    let inputDataObj: Record<string, boolean> = KeepAliveEngine.EMPTY_INPUT_FLAGS;

    const hasDynamicActions =
      !this.isGrounded ||
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
      deltaY = 0;
    } else {
      // DYNAMIC PATH: Handle jumps, swings, sneak transitions, mid-air descent
      const currentFlags = new Set(this.inputFlags);

      // Mid-air descent logic if floating upon teleport / home arrival
      if (!this.isGrounded) {
        this.floatingTicks++;
        if (this.targetFloorY != null) {
          const descentStep = 0.15;
          if (this.position.y > this.targetFloorY + descentStep) {
            deltaY = -descentStep;
            this.position.y = Number((this.position.y - descentStep).toFixed(4));
          } else {
            // Reached ground floor
            deltaY = Number((this.targetFloorY - this.position.y).toFixed(4));
            this.position.y = this.targetFloorY;
            this.isGrounded = true;
            this.targetFloorY = null;
            this.floatingTicks = 0;
          }
        } else {
          // If no target floor is specified, let gravity pull down naturally without freezing
          const gravityStep = 0.2;
          deltaY = -gravityStep;
          this.position.y = Number((this.position.y - gravityStep).toFixed(4));
          if (this.floatingTicks > 60) {
            this.isGrounded = true;
            this.floatingTicks = 0;
          }
        }
      } else if (this.jumpTicksRemaining <= 0) {
        deltaY = 0;
      }

      // Process Jump Physics Arc (10 ticks ~ 500ms jump arc matching Minecraft jump velocity curve)
      if (this.jumpTicksRemaining > 0) {
        currentFlags.add('jumping');
        currentFlags.add('jump_down');

        // First tick of jump
        if (this.jumpTicksRemaining === 10) {
          currentFlags.add('start_jumping');
        }

        const tick = 11 - this.jumpTicksRemaining; // 1 to 10
        let newY = this.jumpBaseY;
        if (tick === 1) newY = this.jumpBaseY + 0.35;
        else if (tick === 2) newY = this.jumpBaseY + 0.60;
        else if (tick === 3) newY = this.jumpBaseY + 0.75;
        else if (tick === 4) newY = this.jumpBaseY + 0.82;
        else if (tick === 5) newY = this.jumpBaseY + 0.82; // Apex
        else if (tick === 6) newY = this.jumpBaseY + 0.75;
        else if (tick === 7) newY = this.jumpBaseY + 0.60;
        else if (tick === 8) newY = this.jumpBaseY + 0.38;
        else if (tick === 9) newY = this.jumpBaseY + 0.15;
        else newY = this.jumpBaseY; // Landing

        deltaY = Number((newY - this.position.y).toFixed(4));
        this.position.y = newY;

        this.jumpTicksRemaining--;
        if (this.jumpTicksRemaining === 0) {
          this.position.y = this.jumpBaseY;
          deltaY = 0;
          this.isGrounded = true;
          this.jumpCooldownTicks = 2; // 100ms pause on ground before next jump
        }
      } else if (this.jumpCooldownTicks > 0) {
        this.jumpCooldownTicks--;
        if (this.jumpCooldownTicks === 0 && this.isContinuousJump) {
          this.triggerJump(); // Continuously chain next jump
        }
      }

      // Process queued horizontal movement
      if (this.moveTicksRemaining > 0) {
        this.position.x += this.moveStepX;
        this.position.z += this.moveStepZ;
        deltaX += this.moveStepX;
        deltaZ += this.moveStepZ;
        this.moveTicksRemaining--;
      }

      // Process Swing Queue
      if (this.swingTicksRemaining > 0) {
        currentFlags.add('missed_swing');
        this.swingTicksRemaining--;
      }

      // Process Item Interaction / Block Action Queue
      if (this.itemUseTicksRemaining > 0) {
        currentFlags.add('item_interact');
        currentFlags.add('block_action');
        this.itemUseTicksRemaining--;
      }

      // Process Sneak Input Flags (Geyser & BDS InputCache detection)
      if (this.isSneakingState) {
        currentFlags.add('sneaking');
        currentFlags.add('sneak_down');
        currentFlags.add('change_height');
        currentFlags.add('persist_sneak');
        currentFlags.add('sneak_toggle_down');
        if (!this.lastSneakingState) {
          currentFlags.add('start_sneaking');
        }
        // Periodically reinforce sneak packets every 20 ticks (1s) to guarantee crouch stance survives respawns, teleports, and lag spikes
        if (this.ticksElapsed % 20 === 0) {
          this.sendSneakPlayerAction(true);
        }
      } else if (this.stopSneakTicks > 0) {
        currentFlags.add('stop_sneaking');
        currentFlags.add('change_height');
        this.stopSneakTicks--;
      }

      if (currentFlags.size > 0) {
        inputDataObj = {};
        for (const flag of currentFlags) {
          inputDataObj[flag] = true;
        }
      }
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
        input_data: inputDataObj,
        input_mode: 'mouse',
        play_mode: 'screen',
        interaction_model: 'crosshair',
        interact_rotation: KeepAliveEngine.ZERO_VEC2,
        tick: this.clientTick,
        delta: (deltaX === 0 && deltaY === 0 && deltaZ === 0) ? KeepAliveEngine.ZERO_VEC3 : { x: Number(deltaX.toFixed(4)), y: Number(deltaY.toFixed(4)), z: Number(deltaZ.toFixed(4)) },
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

      // Queue player_input ONLY when jumping/sneaking state actually changes (never spam periodically)
      const currentJumping = this.jumpTicksRemaining > 0;
      const currentSneaking = this.isSneakingState;
      const inputStateChanged =
        currentJumping !== this.lastJumpingState ||
        currentSneaking !== this.lastSneakingState;

      if (inputStateChanged) {
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
