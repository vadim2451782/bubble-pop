/**
 * Application controller: boots the game, wires DOM input, animation loop,
 * screen transitions, boosters, audio and PWA registration.
 */
import { BOOSTERS, BOOSTER_ORDER, RAINBOW, SCORE, TUNING } from './config.js';
import { getLevel, getNextLevel, LEVELS } from './levels.js';
import { createLayout } from './layout.js';
import { Game } from './game.js';
import { Renderer } from './renderer.js';
import { Store } from './storage.js';
import { AudioEngine } from './audio.js';
import { UI } from './ui.js';
import { bubbleAtPoint, clampAimAngle } from './physics.js';

const QA = new URLSearchParams(window.location.search).has('qa');
const canvas = document.getElementById('game');
const stage = document.getElementById('stage');
const store = new Store();
const audio = new AudioEngine(store.settings);
const renderer = new Renderer(canvas);
const ui = new UI({ store, onAction });

let game = null;
let layout = null;
let currentLevelId = 1;
let view = makeView();
let paused = false;
let resultScreenOpen = false;
let resolveTimer = 0;
let rafId = 0;
let lastTs = 0;
let currentMetaBack = 'menu';
let currentSettingsBack = 'menu';
let resizeQueued = false;
let activePointerId = null;

function makeView() {
  return {
    aimAngle: -Math.PI / 2,
    aiming: false,
    aimTrace: null,
    flying: null,
    boosterMode: null,
    hoverCell: null,
    nextHovered: false,
    rainbow: false,
  };
}

/* --------------------------------------------------------------- lifecycle */

function startLoop() {
  if (rafId) return;
  lastTs = performance.now();
  const frame = (ts) => {
    rafId = requestAnimationFrame(frame);
    let dt = (ts - lastTs) / 1000;
    lastTs = ts;
    if (!Number.isFinite(dt) || dt <= 0) dt = 1 / 60;
    dt = Math.min(dt, 0.05);
    renderer.update(dt);
    updateGame(dt);
    if (game) renderer.draw(view);
  };
  rafId = requestAnimationFrame(frame);
}

function updateGame(dt) {
  if (!game) return;
  if (view.flying) {
    if (!paused && !resultScreenOpen) {
      const trace = view.flying.trace;
      view.flying.progress += (TUNING.shotSpeed * dt) / Math.max(1, trace.length);
      if (view.flying.progress >= 1) {
        view.flying.progress = 1;
        finishFlight();
      }
    }
    return;
  }
  if (!paused && game.phase === 'aim' && !view.aimTrace) refreshAim();
}

function resizeStage() {
  const rect = stage.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  renderer.resize(rect.width, rect.height);
  if (game) {
    layout = createLayout(rect.width, rect.height, game.level.rows.length);
    game.layout = layout;
    renderer.layout = layout;
    renderer.sprites.clear();
    renderer.ensureSprites();
    refreshAim();
  }
}

function queueResize() {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    resizeStage();
  });
}

/* ------------------------------------------------------------------ audio */

function unlockAudio() {
  if (audio.unlocked) return;
  audio.unlock().catch(() => {});
}

function toggleSound() {
  const next = !store.settings.sound;
  store.setSettings({ sound: next });
  audio.setSettings({ sound: next });
  ui.applySettings();
  if (next) {
    unlockAudio();
    audio.play('click');
  }
}

function toggleMusic() {
  const next = !store.settings.music;
  store.setSettings({ music: next });
  audio.setSettings({ music: next });
  ui.applySettings();
  if (next) {
    unlockAudio();
    audio.play('click');
  }
}

/* ------------------------------------------------------------------ level */

function startLevel(id, { announce = true } = {}) {
  const level = getLevel(id);
  clearTimeout(resolveTimer);
  resolveTimer = 0;
  resultScreenOpen = false;
  paused = false;
  currentLevelId = level.id;
  view = makeView();
  activePointerId = null;

  const rect = stage.getBoundingClientRect();
  const width = rect.width || window.innerWidth;
  const height = rect.height || window.innerHeight;
  layout = createLayout(width, height, level.rows.length);
  game = new Game({ level, layout, rng: Math.random });

  renderer.resize(width, height);
  renderer.setLevel(game);
  ui.showScreen(null);
  ui.hideTargetHint();
  ui.syncHud(game);
  if (announce) ui.flashLevelName(`${level.id} · ${level.name}`);
  refreshAim();
  ensureAudioOnGesture();
  startLoop();
}

function ensureAudioOnGesture() {
  unlockAudio();
}

function refreshAim() {
  if (!game || game.phase !== 'aim' || view.flying) {
    view.aimTrace = null;
    return;
  }
  view.aimAngle = clampAimAngle(view.aimAngle);
  view.aimTrace = game.createShot(view.aimAngle);
  view.rainbow = !!(game && game.isRainbow());
}

function finishFlight() {
  if (!game || !view.flying) return;
  const trace = view.flying.trace;
  view.flying = null;
  const result = game.applyShot(trace);
  if (!result) {
    refreshAim();
    return;
  }
  handleShotResult(result, trace);
}

function handleShotResult(result, trace) {
  const R = layout.radius;
  if (result.popped.length) {
    renderer.popCells(result.popped, result.shotColor);
    const average = result.popped.reduce(
      (acc, cell) => ({
        x: acc.x + layout.cellX(cell.r, cell.c),
        y: acc.y + layout.cellY(cell.r),
      }),
      { x: 0, y: 0 },
    );
    average.x /= result.popped.length;
    average.y /= result.popped.length;
    renderer.addFloater(average.x, average.y - R * 0.4, `+${result.scoreGain}`);
    renderer.shake(3 + Math.min(7, result.popped.length * 0.6));
    audio.play('pop', { combo: result.popped.length });
  } else if (result.placed) {
    const x = layout.cellX(result.placed.r, result.placed.c);
    const y = layout.cellY(result.placed.r);
    renderer.ring(x, y, result.shotColor, R * 1.5);
    renderer.addParticles(x, y, result.shotColor, 3, 0.35);
    audio.play(result.bounces ? 'bounce' : 'place');
  }

  if (result.falling.length) {
    renderer.fallCells(result.falling);
    audio.play('fall');
    const average = result.falling.reduce(
      (acc, cell) => ({
        x: acc.x + layout.cellX(cell.r, cell.c),
        y: acc.y + layout.cellY(cell.r),
      }),
      { x: 0, y: 0 },
    );
    average.x /= result.falling.length;
    average.y /= result.falling.length;
    renderer.addFloater(average.x, average.y, `+${result.falling.length * SCORE.falling}`, '#a9e0ff');
  }

  if (result.coinsGain) {
    store.addCoins(result.coinsGain);
    ui.setCoins(store.coins);
  }
  ui.syncHud(game);
  refreshAim();
  scheduleResult();
}

function scheduleResult() {
  if (!game) return;
  if (game.phase === 'won') {
    clearTimeout(resolveTimer);
    resolveTimer = setTimeout(finishWin, 700);
  } else if (game.phase === 'lost') {
    clearTimeout(resolveTimer);
    resolveTimer = setTimeout(finishLose, 700);
  }
}

function finishWin() {
  if (!game || game.phase !== 'won' || resultScreenOpen) return;
  resultScreenOpen = true;
  paused = true;
  const level = game.level;
  const stars = Math.max(1, game.stars || 1);
  const bonus = SCORE.winBase + stars * SCORE.winPerStar;
  store.addCoins(bonus);
  store.completeLevel(level.id, stars, game.score);
  ui.setCoins(store.coins);
  ui.renderAll();
  audio.play('win');
  const next = getNextLevel(level.id);
  ui.showWin({
    game,
    stars,
    coins: game.coinsEarned + bonus,
    nextExists: !!next,
  });
  for (let i = 0; i < stars; i += 1) {
    setTimeout(() => audio.play('star'), 420 + i * 240);
  }
}

function finishLose() {
  if (!game || game.phase !== 'lost' || resultScreenOpen) return;
  resultScreenOpen = true;
  paused = true;
  audio.play('lose');
  ui.showLose({ game, reason: game.loseReason });
}

function pauseGame() {
  if (!game || resultScreenOpen) return;
  cancelBooster();
  paused = true;
  view.aiming = false;
  activePointerId = null;
  ui.showPause(game);
}

function resumeGame() {
  if (!game) return;
  paused = false;
  resultScreenOpen = false;
  ui.showScreen(null);
  ui.syncHud(game);
  refreshAim();
  lastTs = performance.now();
}

function returnToMenu() {
  clearTimeout(resolveTimer);
  resolveTimer = 0;
  resultScreenOpen = false;
  paused = false;
  game = null;
  view = makeView();
  ui.hideTargetHint();
  ui.showScreen('menu');
  ui.renderAll();
}

function openLevels() {
  clearTimeout(resolveTimer);
  resultScreenOpen = false;
  paused = true;
  ui.showScreen('levels');
  ui.renderLevels();
  currentMetaBack = 'menu';
}

function openShop(from = 'menu') {
  currentMetaBack = from;
  if (from === 'pause' || from === 'game') paused = true;
  view.aiming = false;
  audio.play('click');
  ui.showScreen('shop');
  ui.renderShop();
  ui.setCoins(store.coins, { bump: false });
}

function backFromShop() {
  if (currentMetaBack === 'pause' && game) {
    ui.showScreen('pause');
    paused = true;
  } else if (currentMetaBack === 'lose' && game) {
    ui.showScreen('lose');
  } else if (currentMetaBack === 'game' && game) {
    ui.showScreen(null);
    paused = false;
    ui.syncHud(game);
    refreshAim();
  } else {
    returnToMenu();
  }
}

function openSettings(from = 'menu') {
  currentSettingsBack = from;
  if (from === 'pause') paused = true;
  ui.showScreen('settings');
  ui.applySettings();
  audio.play('click');
}

function backFromSettings() {
  if (currentSettingsBack === 'pause' && game) {
    ui.showScreen('pause');
    paused = true;
  } else {
    returnToMenu();
  }
}

function nextLevel() {
  const next = getNextLevel(currentLevelId);
  if (next && next.id <= store.unlocked) {
    startLevel(next.id);
  } else {
    openLevels();
  }
}

function buyBooster(id) {
  const booster = BOOSTERS[id];
  if (!booster) return;
  const result = store.buyBooster(id, booster.price);
  if (!result.ok) {
    ui.toast('Не хватает монет — лопайте шарики!');
    audio.play('click');
    return;
  }
  unlockAudio();
  audio.play('buy');
  ui.setCoins(store.coins);
  ui.renderShop();
  ui.renderMenu();
  ui.syncBoosters();
  ui.toast(`${booster.name} куплен!`);
}

/* ---------------------------------------------------------------- boosters */

function cancelBooster() {
  view.boosterMode = null;
  view.hoverCell = null;
  ui.hideTargetHint();
}

function onBoosterClick(type) {
  if (!game || game.phase !== 'aim' || view.flying || paused || resultScreenOpen) return;
  if (!BOOSTER_ORDER.includes(type)) return;
  unlockAudio();

  if (view.boosterMode === type) {
    cancelBooster();
    return;
  }
  if (store.boosterCount(type) <= 0) {
    ui.toast(`${BOOSTERS[type].name}: купите в магазине`);
    audio.play('click');
    return;
  }

  if (type === 'rainbow') {
    if (!game.canUseBooster('rainbow')) return;
    store.consumeBooster('rainbow');
    game.useBooster('rainbow');
    view.rainbow = true;
    cancelBooster();
    ui.syncHud(game);
    ui.syncBoosters();
    ui.toast('Радужный шар заряжен!', 1400);
    audio.play('rainbow');
    refreshAim();
    return;
  }

  cancelBooster();
  view.boosterMode = type;
  view.aiming = false;
  ui.showTargetHint(type);
  audio.play('click');
}

function applyBoosterAt(cell) {
  const type = view.boosterMode;
  if (!type || !game || game.phase !== 'aim') return;
  if (store.boosterCount(type) <= 0) {
    cancelBooster();
    ui.toast('Бустеры закончились');
    return;
  }
  const result = game.useBooster(type, cell);
  if (!result) return;
  store.consumeBooster(type);
  cancelBooster();
  ui.syncHud(game);
  handleBoosterResult(result, type);
}

function handleBoosterResult(result, type) {
  const R = layout.radius;
  const targetColor = result.target?.color || 'blue';

  if (type === 'bomb') {
    for (const cell of result.removed) {
      const x = layout.cellX(cell.r, cell.c);
      const y = layout.cellY(cell.r);
      renderer.ring(x, y, cell.color, R * 2.2);
      renderer.addParticles(x, y, cell.color, 8, 1.1);
    }
    renderer.shake(10);
    renderer.flash(0.16, '#ffd3a1');
    audio.play('bomb');
  } else if (type === 'lightning') {
    const seen = new Set();
    for (const cell of result.removed) {
      const x = layout.cellX(cell.r, cell.c);
      const y = layout.cellY(cell.r);
      if (!seen.has(cell.c)) {
        renderer.addStreak(x, layout.top, x, y, '#bdefff', 3.2, 0.45);
        seen.add(cell.c);
      }
      renderer.addParticles(x, y, cell.color, 7, 0.9);
      renderer.ring(x, y, cell.color, R * 1.9);
    }
    renderer.flash(0.22, '#c9f2ff');
    renderer.shake(8);
    audio.play('lightning');
  } else if (type === 'rocket') {
    const rowY = layout.cellY(result.target.r);
    renderer.addStreak(layout.left, rowY, layout.right, rowY, '#ffd27a', 9, 0.55);
    for (const cell of result.removed) {
      const x = layout.cellX(cell.r, cell.c);
      renderer.addParticles(x, rowY, cell.color, 8, 1);
      renderer.ring(x, rowY, cell.color, R * 1.9);
    }
    renderer.shake(9);
    renderer.flash(0.15, '#ffe0a8');
    audio.play('rocket');
  }

  if (result.falling.length) {
    renderer.fallCells(result.falling);
    audio.play('fall');
  }

  renderer.addFloater(
    layout.cellX(result.target.r, result.target.c),
    layout.cellY(result.target.r) - R * 0.6,
    `+${result.scoreGain}`,
  );

  ui.syncHud(game);
  refreshAim();
  scheduleResult();
}

/* ------------------------------------------------------------------ input */

function canvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function angleFromPoint(point) {
  const dx = point.x - layout.shooterX;
  const dy = point.y - layout.shooterY;
  let angle = Math.atan2(dy, dx);
  if (angle >= 0) {
    angle = dx >= 0 ? -0.08 : -Math.PI + 0.08;
  }
  return clampAimAngle(angle);
}

function nearNextBubble(point) {
  const next = renderer.getNextBubblePosition();
  return Math.hypot(point.x - next.x, point.y - (next.y - next.radius * 0.15)) < next.radius * 1.75;
}

function swapBubbles() {
  if (!game || game.phase !== 'aim' || view.flying) return;
  if (!game.swap()) return;
  unlockAudio();
  audio.play('swap');
  ui.syncHud(game);
  refreshAim();
}

function shoot() {
  if (!game || game.phase !== 'aim' || view.flying || paused || resultScreenOpen) return;
  const trace = game.createShot(view.aimAngle);
  if (!trace) return;
  unlockAudio();
  view.aiming = false;
  view.aimTrace = null;
  view.flying = { trace, progress: 0 };
  audio.play('shoot');
}

function handlePointerDown(event) {
  if (!game || paused || resultScreenOpen) return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  const point = canvasPoint(event);

  if (view.boosterMode) {
    const cell = bubbleAtPoint(game.grid, layout, point.x, point.y, 1.08);
    if (cell) applyBoosterAt(cell);
    else ui.toast('Нажмите на шарик');
    return;
  }

  if (nearNextBubble(point)) {
    swapBubbles();
    return;
  }

  if (game.phase !== 'aim' || view.flying) return;
  if (activePointerId !== null) return;
  activePointerId = event.pointerId;
  unlockAudio();
  view.aiming = true;
  view.aimAngle = angleFromPoint(point);
  refreshAim();
}

function handlePointerMove(event) {
  if (!game) return;
  if (view.aiming && activePointerId !== null && event.pointerId !== activePointerId) return;
  const point = canvasPoint(event);
  view.nextHovered = nearNextBubble(point);

  if (view.boosterMode) {
    const cell = bubbleAtPoint(game.grid, layout, point.x, point.y, 1.08);
    view.hoverCell = cell;
    updateCursor(cell ? 'pointer' : 'crosshair');
    return;
  }

  if (view.aiming && !paused) {
    const previous = view.aimAngle;
    const next = angleFromPoint(point);
    if (Math.abs(previous - next) > 0.002) {
      view.aimAngle = next;
      refreshAim();
    }
  }
  updateCursor(view.nextHovered ? 'pointer' : 'crosshair');
}

function updateCursor(value) {
  if (canvas.style.cursor !== value) canvas.style.cursor = value;
}

function handlePointerUp(event) {
  if (!view.aiming || !game) return;
  if (activePointerId !== null && event.pointerId !== activePointerId) return;
  const point = canvasPoint(event);
  view.aiming = false;
  activePointerId = null;
  view.aimAngle = angleFromPoint(point);
  refreshAim();
  shoot();
}

canvas.addEventListener('pointerdown', handlePointerDown, { passive: false });
window.addEventListener('pointermove', handlePointerMove, { passive: true });
window.addEventListener('pointerup', handlePointerUp, { passive: true });
window.addEventListener('pointercancel', (event) => {
  if (activePointerId !== null && event.pointerId !== activePointerId) return;
  view.aiming = false;
  activePointerId = null;
});

canvas.addEventListener('touchmove', (event) => event.preventDefault(), { passive: false });
document.addEventListener('gesturestart', (event) => event.preventDefault());
document.addEventListener('dblclick', (event) => {
  if (event.target.closest('#game') || event.target.closest('.screen')) event.preventDefault();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (ui.installOpen) {
      ui.closeInstall();
      return;
    }
    if (ui.currentScreen === 'settings') backFromSettings();
    else if (ui.currentScreen === 'shop') backFromShop();
    else if (ui.currentScreen === 'levels') openLevelsBack();
    else if (ui.currentScreen === 'pause') resumeGame();
    else if (ui.currentScreen) returnToMenu();
    else if (game) pauseGame();
    return;
  }
  if (!game || paused || resultScreenOpen || ui.currentScreen) return;
  if (event.key === 'ArrowLeft') {
    view.aimAngle = clampAimAngle(view.aimAngle - 0.07);
    refreshAim();
    event.preventDefault();
  } else if (event.key === 'ArrowRight') {
    view.aimAngle = clampAimAngle(view.aimAngle + 0.07);
    refreshAim();
    event.preventDefault();
  } else if (event.key === ' ' || event.key === 'ArrowUp') {
    event.preventDefault();
    unlockAudio();
    shoot();
  } else if (event.key === 's' || event.key === 'S') {
    swapBubbles();
  }
});

function openLevelsBack() {
  returnToMenu();
}

/* ----------------------------------------------------------------- actions */

function onAction(action, data = {}) {
  switch (action) {
    case 'play':
      unlockAudio();
      startLevel(store.unlocked);
      break;
    case 'levels':
      openLevels();
      break;
    case 'levelsBack':
      returnToMenu();
      break;
    case 'shop':
      openShop(ui.currentScreen === 'pause' ? 'game' : 'menu');
      break;
    case 'hudShop':
      if (game && !resultScreenOpen) {
        pauseGame();
        openShop('game');
      } else {
        openShop('menu');
      }
      break;
    case 'shopBack':
      backFromShop();
      break;
    case 'settings':
      openSettings('menu');
      break;
    case 'settingsBack':
      backFromSettings();
      break;
    case 'pauseSettings':
      openSettings('pause');
      break;
    case 'pauseShop':
      openShop('pause');
      break;
    case 'loseShop':
      openShop('lose');
      break;
    case 'install':
      ui.showInstall();
      break;
    case 'installBack':
      ui.closeInstall();
      break;
    case 'resume':
      resumeGame();
      break;
    case 'retry':
      startLevel(currentLevelId);
      break;
    case 'next':
      nextLevel();
      break;
    case 'menu':
      returnToMenu();
      break;
    case 'level':
      startLevel(Number(data.level) || 1);
      break;
    case 'lockedLevel':
      ui.toast('Уровень закрыт — пройдите предыдущие');
      break;
    case 'buy':
      buyBooster(data.booster);
      break;
    case 'reset':
      ui.showConfirm();
      break;
    default:
      break;
  }
}

/* ------------------------------------------------------------------- boot */

document.getElementById('btnPause').addEventListener('click', pauseGame);
document.getElementById('btnSound').addEventListener('click', toggleSound);
document.getElementById('btnMusic').addEventListener('click', toggleMusic);
document.getElementById('toggleSound').addEventListener('click', toggleSound);
document.getElementById('toggleMusic').addEventListener('click', toggleMusic);
document.getElementById('btnCancelBooster').addEventListener('click', () => {
  cancelBooster();
  ui.toast('Бустер отменён', 1100);
});
document.getElementById('boosterBar').addEventListener('click', (event) => {
  const button = event.target.closest('[data-booster]');
  if (button) onBoosterClick(button.dataset.booster);
});
document.getElementById('confirmResetYes').addEventListener('click', () => {
  store.resetProgress();
  ui.hideConfirm();
  returnToMenu();
  ui.renderAll();
  ui.toast('Прогресс сброшен', 1800);
});
document.getElementById('confirmResetNo').addEventListener('click', () => {
  ui.hideConfirm();
});

window.addEventListener('resize', queueResize);
window.addEventListener('orientationchange', () => setTimeout(resizeStage, 250));

document.addEventListener('visibilitychange', () => {
  if (document.hidden && game && !paused && !resultScreenOpen && !ui.currentScreen) {
    pauseGame();
  }
});

/* PWA ---------------------------------------------------------------- */

async function initServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    ui.setOfflineReady(false);
    return;
  }
  if (!window.isSecureContext) {
    ui.setOfflineReady(false);
    return;
  }
  ui.setOfflineReady(false);
  try {
    const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    const ready = await navigator.serviceWorker.ready;
    ui.setOfflineReady(Boolean(ready.active));
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          ui.toast('Игра обновилась — перезапустите её', 3200);
        }
      });
    });
  } catch (error) {
    console.warn('BubblePop: service worker registration failed.', error);
    ui.setOfflineReady(false);
  }
}

window.addEventListener('load', initServiceWorker);
window.addEventListener('beforeinstallprompt', (event) => {
  // Safari does not use this, but Chrome/Edge can offer an install prompt.
  event.preventDefault();
  window.__installPrompt = event;
});

startLoop();

/* Debug/QA hooks ------------------------------------------------------ */

const debugApi = {
  startLevel,
  aim(angle) {
    if (!game) return;
    view.aimAngle = clampAimAngle(Number(angle));
    refreshAim();
  },
  shoot(angle) {
    if (angle !== undefined) {
      view.aimAngle = clampAimAngle(Number(angle));
      refreshAim();
    }
    shoot();
  },
  swap: swapBubbles,
  onBoosterClick,
  nextBubblePosition: () => renderer.getNextBubblePosition(),
};

if (QA) {
  debugApi.debug = {
    addCoins(amount) {
      store.addCoins(Number(amount) || 0);
      ui.setCoins(store.coins);
      ui.renderAll();
    },
    giveBoosters(amount = 1) {
      for (const id of BOOSTER_ORDER) store.addBooster(id, amount);
      ui.syncBoosters();
      ui.renderShop();
    },
    setShots(value) {
      if (!game) return;
      game.shots = Number(value) || 0;
      game.phase = game.evaluatePhase();
      ui.syncHud(game);
    },
    setCurrent(color) {
      if (!game) return;
      game.current = color;
      ui.syncHud(game);
      refreshAim();
    },
    clearBoard() {
      if (!game) return null;
      const cells = [];
      game.grid.forEachOccupied((color, r, c) => cells.push({ r, c }));
      game.grid.removeCells(cells);
      game.phase = game.evaluatePhase();
      game.stars = 3;
      ui.syncHud(game);
      refreshAim();
      return game.getState();
    },
    winNow() {
      if (!game) return;
      debugApi.debug.clearBoard();
      game.phase = 'won';
      game.stars = 3;
      finishWin();
    },
    loseNow() {
      if (!game) return;
      game.shots = 0;
      game.phase = 'lost';
      game.loseReason = 'shots';
      ui.syncHud(game);
      finishLose();
    },
    instantShot(angle) {
      if (!game) return null;
      view.aimAngle = clampAimAngle(Number(angle));
      const trace = game.createShot(view.aimAngle);
      if (!trace) return null;
      const result = game.applyShot(trace);
      handleShotResult(result, trace);
      return result;
    },
    state: () => (game ? game.getState() : null),
  };
}

window.__bubblePop = {
  ...debugApi,
  get state() {
    return game ? game.getState() : null;
  },
  get layout() {
    return layout;
  },
  get view() {
    return {
      aimAngle: view.aimAngle,
      aiming: view.aiming,
      flying: !!view.flying,
      boosterMode: view.boosterMode,
      aimTrace: view.aimTrace,
    };
  },
  get screen() {
    return ui.currentScreen;
  },
  get save() {
    return JSON.parse(JSON.stringify(store.state));
  },
  get paused() {
    return paused;
  },
  get levelId() {
    return currentLevelId;
  },
  ui,
  store,
};
