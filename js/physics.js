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

/** Nearest empty cell to `contact`. When a bubble was hit, prefer its empty
 *  neighbours; on a ceiling hit, prefer the top row. */
export function findSnapCell(grid, layout, contact, hitCell) {
  let candidates = [];

  if (hitCell) {
    for (const [r, c] of grid.neighbors(hitCell.r, hitCell.c)) {
      if (!grid.get(r, c)) candidates.push({ r, c });
    }
  }

  if (!candidates.length && grid.rows[0]) {
    grid.rows[0].forEach((_, c) => {
      if (!grid.get(0, c)) candidates.push({ r: 0, c });
    });
  }

  if (!candidates.length) {
    for (let r = 0; r < grid.rows.length; r += 1) {
      for (let c = 0; c < grid.rows[r].length; c += 1) {
        if (grid.get(r, c)) continue;
        if (r === 0 || grid.hasOccupiedNeighbor(r, c)) candidates.push({ r, c });
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
 * Returns the polyline (used for animation), the hit bubble (if any) and the
 * cell where the projectile would land.
 */
export function traceShot(grid, layout, start, angle, options = {}) {
  const R = layout.radius;
  const step = Math.max(1.2, R * 0.26);
  const maxBounces = options.maxBounces ?? TUNING.bounceLimit;
  const left = layout.left;
  const right = layout.left + R * 2 * COLS;
  const ceiling = layout.top;

  let x = start.x;
  let y = start.y;
  let dx = Math.cos(angle);
  let dy = Math.sin(angle);
  let bounces = 0;

  const points = [{ x, y }];

  for (let i = 0; i < 8000; i += 1) {
    let nx = x + dx * step;
    let ny = y + dy * step;

    if (nx - R < left && dx < 0) {
      nx = left + R;
      dx = -dx;
      bounces += 1;
      points.push({ x: nx, y: ny });
    } else if (nx + R > right && dx > 0) {
      nx = right - R;
      dx = -dx;
      bounces += 1;
      points.push({ x: nx, y: ny });
    }

    if (ny - R <= ceiling) {
      const contact = { x: Math.min(right - R, Math.max(left + R, nx)), y: ceiling + R * 0.98 };
      points.push(contact);
      return {
        points,
        contact,
        hitCell: null,
        snap: findSnapCell(grid, layout, contact, null),
        bounces,
        angle,
        length: pathLength(points),
        start,
      };
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
      return {
        points,
        contact,
        hitCell: { r: hit.r, c: hit.c },
        snap: findSnapCell(grid, layout, contact, hit),
        bounces,
        angle,
        length: pathLength(points),
        start,
      };
    }

    x = nx;
    y = ny;
    points.push({ x, y });

    if (bounces > maxBounces) break;
    if (y < ceiling - R * 3) break;
  }

  const contact = { x, y };
  return {
    points,
    contact,
    hitCell: null,
    snap: findSnapCell(grid, layout, contact, null),
    bounces,
    angle,
    length: pathLength(points),
    start,
  };
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
