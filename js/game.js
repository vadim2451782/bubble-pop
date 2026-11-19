/**
 * Core game engine. Owns the board, shots, score, stars and boosters.
 * No DOM and no timers: the controller animates, the engine decides.
 */
import { RAINBOW, SCORE } from './config.js';
import { BubbleGrid } from './grid.js';
import { shooterMuzzle } from './layout.js';
import { traceShot } from './physics.js';

export class Game {
  constructor({ level, layout, rng = Math.random }) {
    this.level = level;
    this.layout = layout;
    this.rng = rng;
    this.palette = level.palette;
    this.grid = BubbleGrid.fromPattern(layout, level.rows);
    this.startBubbles = this.grid.count();
    this.startShots = level.shots;
    this.shots = level.shots;
    this.score = 0;
    this.stars = 0;
    this.coinsEarned = 0;
    this.phase = 'aim';
    this.loseReason = null;
    this.current = this.pickColor();
    this.next = this.pickColor();
    this.stats = { popped: 0, falling: 0, shots: 0, boosters: 0, bounces: 0 };
    this.lastResult = null;
    this.lastTrace = null;
  }

  random() {
    return Math.min(0.9999999, Math.max(0, Number(this.rng()) || 0));
  }

  /** Pick a colour that is actually present, weighted by how common it is.
   *  Keeps the shooter useful in the late stages of a level. */
  pickColor() {
    const counts = new Map();
    this.grid.forEachOccupied((color) => {
      counts.set(color, (counts.get(color) || 0) + 1);
    });
    if (!counts.size) return this.palette[0];
    const entries = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const total = entries.reduce((sum, [, count]) => sum + count, 0);
    let roll = this.random() * total;
    for (const [color, count] of entries) {
      roll -= count;
      if (roll <= 0) return color;
    }
    return entries[entries.length - 1][0];
  }

  isRainbow() {
    return this.current === RAINBOW;
  }

  swap() {
    if (this.phase !== 'aim' || !this.next) return false;
    const tmp = this.current;
    this.current = this.next;
    this.next = tmp;
    return true;
  }

  /** Build the trajectory for the current bubble. Does not consume the shot. */
  createShot(angle) {
    if (this.phase !== 'aim') return null;
    const start = shooterMuzzle(this.layout, angle);
    const rainbow = this.isRainbow();
    const trace = traceShot(this.grid, this.layout, start, angle);
    let shotColor = this.current;
    if (rainbow) {
      if (trace.hitCell) {
        shotColor = this.grid.get(trace.hitCell.r, trace.hitCell.c);
      } else {
        // A rainbow bubble that reaches the ceiling takes a random colour from
        // those still on the board. Chosen when the shot lands, never while
        // the player is just aiming (keeps previews side-effect free).
        shotColor = null;
        trace.needsColor = true;
      }
    }
    trace.rainbow = rainbow;
    trace.shotColor = shotColor;
    trace.angle = angle;
    return trace;
  }

  applyShot(trace) {
    if (this.phase !== 'aim' || !trace) return null;
    this.phase = 'resolving';
    this.shots = Math.max(0, this.shots - 1);
    this.stats.shots += 1;
    this.stats.bounces += trace.bounces || 0;

    let shotColor = trace.shotColor;
    if (!shotColor) {
      const present = this.grid.colorsPresent();
      shotColor = present.length
        ? present[Math.floor(this.random() * present.length)]
        : this.palette[0];
      trace.shotColor = shotColor;
    }

    const result = {
      placed: null,
      popped: [],
      falling: [],
      shotColor,
      rainbow: !!trace.rainbow,
      bounces: trace.bounces || 0,
      scoreGain: 0,
      coinsGain: 0,
      phase: 'aim',
    };

    if (trace.snap) {
      const { r, c } = trace.snap;
      if (this.grid.add(r, c, shotColor)) {
        result.placed = { r, c, color: shotColor };
        const group = this.grid.sameColorCells(r, c);
        if (group.length >= 3) {
          result.popped = group;
          this.grid.removeCells(group);
          result.falling = this.grid.findFloating();
          this.grid.removeCells(result.falling);
        }
      }
    }

    const popped = result.popped.length;
    const falling = result.falling.length;
    const gain =
      popped * SCORE.bubble +
      Math.max(0, popped - 3) * SCORE.clusterBonus +
      falling * SCORE.falling;
    this.score += gain;
    this.coinsEarned += popped + falling;
    this.stats.popped += popped;
    this.stats.falling += falling;
    result.scoreGain = gain;
    result.coinsGain = popped + falling;

    this.current = this.next;
    this.next = this.pickColor();
    this.lastTrace = trace;
    this.lastResult = result;
    this.phase = this.evaluatePhase();
    result.phase = this.phase;
    result.stars = this.stars;
    result.remaining = this.grid.count();
    return result;
  }

  canUseBooster(type) {
    return this.phase === 'aim' && ['bomb', 'lightning', 'rainbow', 'rocket'].includes(type);
  }

  /**
   * Apply a booster. `cell` is required for targeted boosters, omitted for the
   * rainbow bubble which charges the current projectile instead.
   */
  useBooster(type, cell = null) {
    if (!this.canUseBooster(type)) return null;

    if (type === 'rainbow') {
      this.stats.boosters += 1;
      this.current = RAINBOW;
      return {
        type,
        removed: [],
        falling: [],
        scoreGain: 0,
        coinsGain: 0,
        phase: this.phase,
        rainbow: true,
      };
    }

    if (!cell) return null;
    const target = this.grid.get(cell.r, cell.c);
    if (!target) return null;

    let removed = [];
    if (type === 'bomb') {
      removed = [{ r: cell.r, c: cell.c }];
      for (const [r, c] of this.grid.neighbors(cell.r, cell.c)) {
        if (this.grid.get(r, c)) removed.push({ r, c });
      }
    } else if (type === 'lightning') {
      this.grid.forEachOccupied((color, r, c) => {
        if (color === target) removed.push({ r, c });
      });
    } else if (type === 'rocket') {
      this.grid.rows[cell.r].forEach((color, c) => {
        if (color) removed.push({ r: cell.r, c });
      });
    } else {
      return null;
    }

    removed = removed.filter((cell2, index, arr) =>
      arr.findIndex((x) => x.r === cell2.r && x.c === cell2.c) === index);
    const removedWithColors = removed.map(({ r, c }) => ({
      r,
      c,
      color: this.grid.get(r, c),
    }));

    this.grid.removeCells(removed);
    const falling = this.grid.findFloating();
    const fallingWithColors = falling.map(({ r, c }) => ({
      r,
      c,
      color: this.grid.get(r, c),
    }));
    this.grid.removeCells(falling);

    const gain =
      (removed.length + falling.length) * SCORE.boosterBubble;
    this.score += gain;
    this.stats.boosters += 1;
    this.stats.popped += removed.length;
    this.stats.falling += falling.length;

    this.phase = this.evaluatePhase();
    return {
      type,
      target: { r: cell.r, c: cell.c, color: target },
      removed: removedWithColors,
      falling: fallingWithColors,
      scoreGain: gain,
      coinsGain: 0,
      phase: this.phase,
      stars: this.stars,
    };
  }

  evaluatePhase() {
    if (this.grid.count() === 0) {
      this.loseReason = null;
      this.stars = this.calculateStars();
      return 'won';
    }
    const lowest = this.grid.lowestRow();
    if (lowest >= 0) {
      const bottom = this.layout.cellY(lowest) + this.layout.radius;
      if (bottom > this.layout.dangerY + 0.5) {
        this.loseReason = 'overflow';
        return 'lost';
      }
    }
    if (this.shots <= 0) {
      this.loseReason = 'shots';
      return 'lost';
    }
    return 'aim';
  }

  calculateStars() {
    const ratio = this.startShots > 0 ? this.shots / this.startShots : 1;
    if (ratio >= 0.4) return 3;
    if (ratio >= 0.15) return 2;
    return 1;
  }

  getState() {
    return {
      levelId: this.level.id,
      levelName: this.level.name,
      phase: this.phase,
      shots: this.shots,
      startShots: this.startShots,
      score: this.score,
      stars: this.stars,
      coinsEarned: this.coinsEarned,
      current: this.current,
      next: this.next,
      rainbow: this.isRainbow(),
      remaining: this.grid.count(),
      total: this.startBubbles,
      progress: this.startBubbles
        ? 1 - this.grid.count() / this.startBubbles
        : 1,
      loseReason: this.loseReason,
      stats: { ...this.stats },
      grid: this.grid.cloneRows(),
    };
  }
}
