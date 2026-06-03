"use strict";
/* ぽんぽんリズム ── ビートに合わせてカニ🦀をタップするリズムゲーム */

// === 設定 ===
const BPM_START = 80;        // 開始テンポ（ゆっくり）
const BPM_MAX = 104;         // 最高テンポ（3歳児向けに控えめ）
const HIT_WINDOW = 0.18;     // 成功と判定する拍とのズレ（秒）。広めにとる
const MILESTONE = 8;         // この回数ごとにお祝い
const SCHEDULE_AHEAD = 0.12; // 先読みスケジュール時間（秒）
const LOOKAHEAD_MS = 25;     // スケジューラの起動間隔
const CUE_LIGHTS = 4;        // 拍を先読みするあわライト
const COUNT_IN_BEATS = 4;    // スタート前のカウントイン拍数

// C メジャーペンタトニック（外れた音にならないので連打しても気持ちいい）
const PENTATONIC = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5];

// BGM の短いループメロディ（C メジャーペンタトニックだけで作る）
const MUSIC_PHRASE = [
  { freq: PENTATONIC[0], beats: 1 },
  { freq: PENTATONIC[1], beats: 1 },
  { freq: PENTATONIC[2], beats: 1 },
  { freq: PENTATONIC[4], beats: 1 },
  { freq: PENTATONIC[2], beats: 1 },
  { freq: PENTATONIC[1], beats: 1 },
  { freq: PENTATONIC[0], beats: 2 },
  { freq: PENTATONIC[2], beats: 1 },
  { freq: PENTATONIC[4], beats: 1 },
  { freq: PENTATONIC[5], beats: 1 },
  { freq: PENTATONIC[4], beats: 1 },
  { freq: PENTATONIC[2], beats: 1 },
  { freq: PENTATONIC[1], beats: 1 },
  { freq: PENTATONIC[0], beats: 2 },
];

// === 状態 ===
let audioCtx = null;
let masterGain = null;
let musicGain = null;
let isPlaying = false;
let bpm = BPM_START;
let secondsPerBeat = 60 / bpm;
let nextNoteTime = 0;
let musicTime = 0;
let musicIndex = 0;
let schedulerId = null;
let scheduledBeats = [];     // {time, bounced} 拍の予定時刻
let successCount = 0;        // 累計成功数
let combo = 0;               // 連続成功（メロディを上げる用）
let isCountingIn = false;    // スタート直後のライト練習中
let lastBeatFlashAt = -1;    // 拍の瞬間のライトを少し残すための時刻

// === DOM ===
const startScreen = document.getElementById("start-screen");
const gameScreen = document.getElementById("game-screen");
const startBtn = document.getElementById("start-btn");
const crab = document.getElementById("crab");
const crabShadow = document.getElementById("crab-shadow");
const ring = document.getElementById("ring");
const stage = document.getElementById("stage");
const starsBox = document.getElementById("stars");
const fx = document.getElementById("fx");
const cueLights = Array.from(document.querySelectorAll(".cue-light"));
const levelSweep = document.getElementById("level-sweep");

// === 音の合成（Web Audio API・ファイル不要） ===
function tone(freq, start, dur, type = "sine", peak = 0.3) {
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = type;
  o.frequency.value = freq;
  o.connect(g);
  g.connect(masterGain);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(peak, start + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.start(start);
  o.stop(start + dur + 0.02);
}

// BGM 用のやわらかいベル音。拍音を邪魔しないよう musicGain にだけ送る
function musicNote(freq, start, durSec) {
  const o = audioCtx.createOscillator();
  const h = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  const hg = audioCtx.createGain();
  o.type = "triangle";
  h.type = "sine";
  o.frequency.value = freq;
  h.frequency.value = freq * 2;
  o.connect(g);
  h.connect(hg);
  g.connect(musicGain);
  hg.connect(musicGain);
  g.gain.setValueAtTime(0.0001, start);
  hg.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(0.5, start + 0.015);
  hg.gain.exponentialRampToValueAtTime(0.08, start + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, start + durSec);
  hg.gain.exponentialRampToValueAtTime(0.0001, start + durSec);
  o.start(start);
  h.start(start);
  o.stop(start + durSec + 0.03);
  h.stop(start + durSec + 0.03);
}

// 拍の音（やわらかいウッドブロック風）
function playBeat(time) {
  tone(1100, time, 0.06, "triangle", 0.12);
}
// 成功の音（ベル。連続成功でメロディが上がる）
function playSuccess() {
  const t = audioCtx.currentTime;
  const f = PENTATONIC[Math.min(combo, PENTATONIC.length - 1)];
  tone(f, t, 0.4, "sine", 0.32);
  tone(f * 2, t, 0.4, "sine", 0.12); // 倍音できらびやかに
}
// 外したときの音（罰ではなく、やさしいポンッ）
function playSoft() {
  tone(300, audioCtx.currentTime, 0.12, "sine", 0.12);
}
// お祝いのファンファーレ
function playFanfare() {
  const t = audioCtx.currentTime;
  [0, 1, 2, 3, 5].forEach((i, n) => {
    tone(PENTATONIC[i], t + n * 0.09, 0.35, "sine", 0.3);
  });
}

// === ビートスケジューラ（先読みで正確に刻む） ===
function scheduler() {
  while (nextNoteTime < audioCtx.currentTime + SCHEDULE_AHEAD) {
    playBeat(nextNoteTime);
    scheduledBeats.push({ time: nextNoteTime, bounced: false });
    nextNoteTime += secondsPerBeat;
  }
  while (musicTime < audioCtx.currentTime + SCHEDULE_AHEAD) {
    const note = MUSIC_PHRASE[musicIndex];
    const durSec = note.beats * secondsPerBeat;
    musicNote(note.freq, musicTime, durSec * 0.88);
    musicTime += durSec;
    musicIndex = (musicIndex + 1) % MUSIC_PHRASE.length;
  }
}

// === 拍とタップの判定 ===
function handleTap() {
  if (!isPlaying) return;
  const now = audioCtx.currentTime;
  // 最も近い拍を探す
  let nearest = Infinity;
  for (const b of scheduledBeats) {
    const d = Math.abs(b.time - now);
    if (d < nearest) nearest = d;
  }
  if (nearest <= HIT_WINDOW) {
    success();
  } else {
    miss();
  }
}

function success() {
  successCount++;
  combo++;
  playSuccess();
  crab.classList.remove("happy");
  crabShadow.classList.remove("happy");
  void crab.offsetWidth; // アニメ再起動
  crab.classList.add("happy");
  crabShadow.classList.add("happy");
  addStar();
  burst("⭐", 5);
  burst("🐠", 2);
  burst("🫧", 3);
  if (successCount % MILESTONE === 0) {
    celebrate();
    speedUp();
  }
}

function miss() {
  combo = 0;
  playSoft();
  burst("💧", 2, 0.55);
}

// === 演出 ===
function setCueLights(count, isHit = false) {
  cueLights.forEach((light, index) => {
    const on = index < count;
    light.classList.toggle("on", on);
    if (isHit && on) {
      light.classList.remove("hit");
      void light.offsetWidth;
      light.classList.add("hit");
    }
  });
}

function triggerBeatVisual(lightCount = CUE_LIGHTS) {
  crab.classList.remove("bounce");
  crabShadow.classList.remove("bounce");
  void crab.offsetWidth;
  crab.classList.add("bounce");
  crabShadow.classList.add("bounce");
  ring.classList.add("flash");
  lastBeatFlashAt = audioCtx.currentTime;
  setCueLights(lightCount, true);
  setTimeout(() => ring.classList.remove("flash"), 90);
}

function addStar() {
  const s = document.createElement("span");
  s.className = "star";
  s.textContent = "⭐";
  starsBox.appendChild(s);
  // たまりすぎたら古いものを消す
  if (starsBox.children.length > 30) starsBox.removeChild(starsBox.firstChild);
}

// 星や水しぶきを飛ばす
function burst(emoji, count = 6, power = 1) {
  const rect = stage.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  for (let i = 0; i < count; i++) {
    const el = document.createElement("span");
    el.className = "burst";
    el.textContent = emoji;
    el.style.left = cx + "px";
    el.style.top = cy + "px";
    fx.appendChild(el);
    const ang = Math.random() * Math.PI * 2;
    const dist = (80 + Math.random() * 140) * power;
    const dx = Math.cos(ang) * dist;
    const dy = Math.sin(ang) * dist - 60 * power;
    el.animate(
      [
        { transform: "translate(-50%,-50%) scale(0.4)", opacity: 1 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(1.2)`, opacity: 0 },
      ],
      { duration: 700, easing: "cubic-bezier(.2,.8,.3,1)" }
    ).onfinish = () => el.remove();
  }
}

function fishParade() {
  for (let i = 0; i < 5; i++) {
    const el = document.createElement("span");
    el.className = "fish";
    el.textContent = i % 2 === 0 ? "🐠" : "🐟";
    el.style.left = "-12vmin";
    el.style.top = 18 + Math.random() * 54 + "%";
    fx.appendChild(el);
    el.animate(
      [
        { transform: "translateX(0) scale(0.7)", opacity: 0 },
        { transform: `translateX(${35 + i * 6}vw) translateY(-3vmin) scale(1)`, opacity: 1 },
        { transform: "translateX(118vw) translateY(3vmin) scale(0.86)", opacity: 0 },
      ],
      { duration: 1700 + i * 140, delay: i * 80, easing: "cubic-bezier(.18,.72,.28,1)" }
    ).onfinish = () => el.remove();
  }
}

function fireworks() {
  const colors = ["#fff2a8", "#ff8fa3", "#73f5ff", "#a8ffcb"];
  for (let burstIndex = 0; burstIndex < 4; burstIndex++) {
    const cx = 20 + Math.random() * 60;
    const cy = 18 + Math.random() * 32;
    for (let i = 0; i < 12; i++) {
      const el = document.createElement("span");
      el.className = "firework";
      el.style.left = cx + "%";
      el.style.top = cy + "%";
      el.style.background = colors[(i + burstIndex) % colors.length];
      fx.appendChild(el);
      const ang = (Math.PI * 2 * i) / 12;
      const dist = 52 + Math.random() * 42;
      const dx = Math.cos(ang) * dist;
      const dy = Math.sin(ang) * dist;
      el.animate(
        [
          { transform: "translate(-50%,-50%) scale(0.2)", opacity: 1 },
          { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(1)`, opacity: 0 },
        ],
        { duration: 780, delay: burstIndex * 130, easing: "cubic-bezier(.16,.78,.28,1)" }
      ).onfinish = () => el.remove();
    }
  }
}

// お祝い（光・魚・花火）
function celebrate() {
  playFanfare();
  document.body.classList.remove("level-shift");
  levelSweep.classList.remove("show");
  void levelSweep.offsetWidth;
  document.body.classList.add("level-shift");
  levelSweep.classList.add("show");
  setTimeout(() => document.body.classList.remove("level-shift"), 1500);
  fishParade();
  fireworks();
  const emojis = ["✨", "🌟", "🫧", "🐠", "🦀"];
  for (let i = 0; i < 24; i++) {
    const el = document.createElement("span");
    el.className = "burst";
    el.textContent = emojis[i % emojis.length];
    el.style.left = Math.random() * 100 + "%";
    el.style.top = "-10%";
    fx.appendChild(el);
    el.animate(
      [
        { transform: "translateY(0) rotate(0)", opacity: 1 },
        { transform: `translateY(110vh) rotate(${Math.random() * 720 - 360}deg)`, opacity: 1 },
      ],
      { duration: 1800 + Math.random() * 1200, easing: "ease-in" }
    ).onfinish = () => el.remove();
  }
}

function speedUp() {
  bpm = Math.min(BPM_MAX, bpm + 4);
  secondsPerBeat = 60 / bpm;
}

// === 描画ループ（拍に合わせてカニとリングを動かす） ===
function render() {
  if (!isPlaying) return;
  const now = audioCtx.currentTime;

  // 古い拍を捨てる
  while (scheduledBeats.length && scheduledBeats[0].time < now - 1) {
    scheduledBeats.shift();
  }
  // 次の拍を探す
  let next = null;
  for (const b of scheduledBeats) {
    if (b.time >= now) { next = b; break; }
    // まだ跳ねていない過ぎた拍 → 今が拍。跳ねる
    if (!b.bounced) {
      b.bounced = true;
      triggerBeatVisual();
    }
  }
  // リングが拍に向かって縮む（予告）
  if (next) {
    const timeToNext = next.time - now;
    const frac = Math.max(0, Math.min(1, timeToNext / secondsPerBeat));
    const scale = 1 + 1.4 * frac;
    const cueCount = Math.min(CUE_LIGHTS - 1, Math.floor((1 - frac) * CUE_LIGHTS));
    ring.style.transform = `scale(${scale})`;
    ring.style.opacity = (0.4 + 0.5 * (1 - frac)).toFixed(2);
    if (now - lastBeatFlashAt > 0.13) setCueLights(cueCount);
  }
  requestAnimationFrame(render);
}

function startCountIn(firstBeatTime) {
  isCountingIn = true;
  setCueLights(0);
  ring.style.transform = "scale(2.4)";
  ring.style.opacity = "0.45";

  for (let i = 0; i < COUNT_IN_BEATS; i++) {
    const beatTime = firstBeatTime + i * secondsPerBeat;
    playBeat(beatTime);
    setTimeout(() => {
      triggerBeatVisual(i + 1);
    }, Math.max(0, (beatTime - audioCtx.currentTime) * 1000));
  }

  const playTime = firstBeatTime + COUNT_IN_BEATS * secondsPerBeat;
  setTimeout(() => {
    isCountingIn = false;
    isPlaying = true;
    scheduledBeats = [];
    nextNoteTime = playTime;
    musicTime = nextNoteTime;
    schedulerId = setInterval(scheduler, LOOKAHEAD_MS);
    scheduler();
    requestAnimationFrame(render);
  }, Math.max(0, (playTime - audioCtx.currentTime) * 1000));
}

// === 開始 ===
function startGame() {
  if (isPlaying || isCountingIn) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.6;
  masterGain.connect(audioCtx.destination);
  musicGain = audioCtx.createGain();
  musicGain.gain.value = 0.17;
  musicGain.connect(masterGain);
  // iOS対策：ユーザー操作の中でresume
  if (audioCtx.state === "suspended") audioCtx.resume();

  isPlaying = false;
  bpm = BPM_START;
  secondsPerBeat = 60 / bpm;
  successCount = 0;
  combo = 0;
  lastBeatFlashAt = -1;
  scheduledBeats = [];
  nextNoteTime = 0;
  musicIndex = 0;
  musicTime = 0;
  starsBox.textContent = "";
  fx.textContent = "";
  setCueLights(0);

  startScreen.classList.add("hidden");
  gameScreen.classList.remove("hidden");

  startCountIn(audioCtx.currentTime + 0.2);
}

// === イベント ===
startBtn.addEventListener("click", startGame);

// ゲーム画面はどこをタップしても判定（大きなタップ領域）
gameScreen.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  handleTap();
});

// ダブルタップによる拡大を抑止
document.addEventListener("gesturestart", (e) => e.preventDefault());
document.addEventListener("dblclick", (e) => e.preventDefault());

// サービスワーカー登録（オフライン対応）
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
