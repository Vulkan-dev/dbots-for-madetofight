export interface Vector3D {
  x: number;
  y: number;
  z: number;
}

export class MathUtils {
  /**
   * Calculates the 3D Euclidean distance between two coordinate vectors.
   */
  public static euclideanDistance(pos1: Vector3D, pos2: Vector3D): number {
    const dx = pos1.x - pos2.x;
    const dy = pos1.y - pos2.y;
    const dz = pos1.z - pos2.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Calculates squared 3D Euclidean distance (avoids Math.sqrt for fast radius checks).
   */
  public static distanceSquared(pos1: Vector3D, pos2: Vector3D): number {
    const dx = pos1.x - pos2.x;
    const dy = pos1.y - pos2.y;
    const dz = pos1.z - pos2.z;
    return dx * dx + dy * dy + dz * dz;
  }

  /**
   * Checks if target position is within specified chunk radius of bot position.
   * 1 Chunk = 16 blocks. Uses squared distance to eliminate Math.sqrt overhead.
   */
  public static isWithinChunkRadius(center: Vector3D, target: Vector3D, radiusChunks: number): boolean {
    const radiusBlocks = radiusChunks * 16;
    return MathUtils.distanceSquared(center, target) <= (radiusBlocks * radiusBlocks);
  }

  /**
   * Format coordinate for display
   */
  public static formatPos(pos: Vector3D): string {
    return `X ${Math.round(pos.x)}, Y ${Math.round(pos.y)}, Z ${Math.round(pos.z)}`;
  }
}
