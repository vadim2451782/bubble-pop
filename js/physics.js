/**
 * Pure geometry: aiming ray, wall bounces, collision detection and snap-cell
 * selection. No DOM, no rendering.
 */
import { COLS, TUNING } from './config.js';

export function cellCenter(layout, r, c) {
  return { x: layout.cellX(r, c), y: layout.cellY(r) };
}

export function pathLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return total;
}

function cumulativeDistances(points) {
  const distances = [0];
  for (let i = 1; i < points.length; i += 1) {
    distances.push(
      distances[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y),
    );
  }
  return distances;
}

/** Nearest legal empty cell to `contact`.
 *
 *  - A bubble hit prefers the empty neighbours of the bubble that was hit.
 *  - A ceiling hit prefers empty cells of the ceiling row.
 *  - A safety fallback (only if those are all full) picks the nearest empty
 *    cell that actually touches another bubble, never a random top-row cell.
 */
export function findSnapCell(grid, layout, contact, hitCell, options = {}) {
  const atCeiling = options.ceiling === true;
  let candidates = [];

  if (hitCell) {
    for (const [r, c] of grid.neighbors(hitCell.r, hitCell.c)) {
      if (!grid.get(r, c)) candidates.push({ r, c });
    }
  }

  if (!candidates.length && atCeiling && grid.rows[0]) {
    grid.rows[0].forEach((_, c) => {
      if (!grid.get(0, c)) candidates.push({ r: 0, c });
    });
  }

  if (!candidates.length) {
    for (let r = 0; r < grid.rows.length; r += 1) {
      for (let c = 0; c < grid.rows[r].length; c += 1) {
        if (grid.get(r, c)) continue;
        if (grid.hasOccupiedNeighbor(r, c)) candidates.push({ r, c });
      }
    }
  }

  // Never snap below the playable stack.
  candidates = candidates.filter(({ r }) => r < layout.maxRows);
  if (!candidates.length) return null;

  let best = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const x = layout.cellX(candidate.r, candidate.c);
    const y = layout.cellY(candidate.r);
    const distance = (x - contact.x) ** 2 + (y - contact.y) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/**
 * Trace a shot from `start` at `angle` (radians, -PI..0 points upward).
 * The projectile keeps flying and bouncing off side walls until it hits the
 * ceiling or a bubble. There is intentionally no bounce limit: a real bubble
 * shooter must never stop mid-air and teleport the bubble to the top row.
 *
 * Returns the polyline (used for animation), the hit bubble (if any), the
 * contact type and the cell where the projectile lands.
 */
export function traceShot(grid, layout, start, angle, options = {}) {
  const R = layout.radius;
  const step = Math.max(1.2, R * 0.26);
  const maxSteps = options.maxSteps ?? TUNING.maxTraceSteps;
  const left = layout.left;
  const right = layout.left + R * 2 * COLS;
  const ceiling = layout.top;

  let x = start.x;
  let y = start.y;
  let dx = Math.cos(angle);
  let dy = Math.sin(angle);
  let bounces = 0;

  const points = [{ x, y }];
  const bounceIndices = [];

  const finalize = (contact, contactType, hitCell, snap, exhausted = false) => {
    const distances = cumulativeDistances(points);
    return {
      points,
      contact,
      contactType,
      hitCell,
      snap,
      bounces,
      angle,
      length: distances[distances.length - 1] || 0,
      start,
      exhausted,
      bouncePoints: bounceIndices.map((index) => ({
        ...points[index],
        distance: distances[index],
      })),
    };
  };

  for (let i = 0; i < maxSteps; i += 1) {
    let nx = x + dx * step;
    let ny = y + dy * step;
    let reflected = false;

    if (nx - R < left && dx < 0) {
      nx = left + R;
      dx = -dx;
      bounces += 1;
      reflected = true;
      points.push({ x: nx, y: ny });
      bounceIndices.push(points.length - 1);
    } else if (nx + R > right && dx > 0) {
      nx = right - R;
      dx = -dx;
      bounces += 1;
      reflected = true;
      points.push({ x: nx, y: ny });
      bounceIndices.push(points.length - 1);
    }

    if (ny - R <= ceiling) {
      const contact = {
        x: Math.min(right - R, Math.max(left + R, nx)),
        y: ceiling + R * 0.98,
      };
      points.push(contact);
      return finalize(contact, 'ceiling', null, findSnapCell(grid, layout, contact, null, { ceiling: true }));
    }

    let hit = null;
    let bestDistance = Infinity;
    grid.forEachOccupied((color, r, c) => {
      const cx = layout.cellX(r, c);
      const cy = layout.cellY(r);
      const distance = Math.hypot(nx - cx, ny - cy);
      if (distance < R * 2 * 0.985 && distance < bestDistance) {
        bestDistance = distance;
        hit = { r, c, color };
      }
    });

    if (hit) {
      const bx = layout.cellX(hit.r, hit.c);
      const by = layout.cellY(hit.r);
      let vx = x - bx;
      let vy = y - by;
      const distance = Math.hypot(vx, vy) || 1;
      const contact = {
        x: bx + (vx / distance) * R * 1.99,
        y: by + (vy / distance) * R * 1.99,
      };
      points.push(contact);
      return finalize(
        contact,
        'bubble',
        { r: hit.r, c: hit.c },
        findSnapCell(grid, layout, contact, hit, { ceiling: false }),
      );
    }

    x = nx;
    y = ny;
    if (!reflected) points.push({ x, y });
  }

  // Defensive fallback for a malformed angle that never reaches the board.
  // Never invent a snap cell here: that is exactly what used to teleport the
  // projectile to the top after too many wall bounces.
  return finalize({ x, y }, 'none', null, null, true);
}

/** Find the occupied bubble under a canvas point. */
export function bubbleAtPoint(grid, layout, x, y, tolerance = 1.05) {
  let best = null;
  let bestDistance = Infinity;
  const limit = layout.radius * tolerance;
  grid.forEachOccupied((color, r, c) => {
    const cx = layout.cellX(r, c);
    const cy = layout.cellY(r);
    const distance = Math.hypot(x - cx, y - cy);
    if (distance <= limit && distance < bestDistance) {
      bestDistance = distance;
      best = { r, c, color };
    }
  });
  return best;
}

/** Clamp an aiming angle to the upward fan. */
export function clampAimAngle(angle, margin = TUNING.minAngle) {
  const min = -Math.PI + margin;
  const max = -margin;
  return Math.min(max, Math.max(min, angle));
}

/** Canvas position of a cell's centre. Kept for renderers/tests. */
export function cellPosition(layout, cell) {
  return cellCenter(layout, cell.r, cell.c);
}
