"use strict";
/* ぽんぽんリズム ── ビートに合わせてカニ🦀をタップするリズムゲーム */

// === 設定 ===
const BPM_START = 80;        // 開始テンポ（ゆっくり）
const BPM_MAX = 104;         // 最高テンポ（3歳児向けに控えめ）
const HIT_WINDOW = 0.18;     // 成功と判定する拍とのズレ（秒）。広めにとる
const MILESTONE = 8;         // この回数ごとにお祝い
const SCHEDULE_AHEAD = 0.12; // 先読みスケジュール時間（秒）
const LOOKAHEAD_MS = 25;     // スケジューラの起動間隔

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

// === DOM ===
const startScreen = document.getElementById("start-screen");
const gameScreen = document.getElementById("game-screen");
const startBtn = document.getElementById("start-btn");
const crab = document.getElementById("crab");
const ring = document.getElementById("ring");
const stage = document.getElementById("stage");
const starsBox = document.getElementById("stars");
const fx = document.getElementById("fx");

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
  void crab.offsetWidth; // アニメ再起動
  crab.classList.add("happy");
  addStar();
  burst("⭐");
  if (successCount % MILESTONE === 0) {
    celebrate();
    speedUp();
  }
}

function miss() {
  combo = 0;
  playSoft();
  burst("💧", 1);
}

// === 演出 ===
function addStar() {
  const s = document.createElement("span");
  s.className = "star";
  s.textContent = "⭐";
  starsBox.appendChild(s);
  // たまりすぎたら古いものを消す
  if (starsBox.children.length > 30) starsBox.removeChild(starsBox.firstChild);
}

// 星や水しぶきを飛ばす
function burst(emoji, count = 6) {
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
    const dist = 80 + Math.random() * 140;
    const dx = Math.cos(ang) * dist;
    const dy = Math.sin(ang) * dist - 60;
    el.animate(
      [
        { transform: "translate(-50%,-50%) scale(0.4)", opacity: 1 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(1.2)`, opacity: 0 },
      ],
      { duration: 700, easing: "cubic-bezier(.2,.8,.3,1)" }
    ).onfinish = () => el.remove();
  }
}

// お祝い（紙吹雪）
function celebrate() {
  playFanfare();
  const emojis = ["🎉", "✨", "🌟", "🎈", "🦀"];
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
      crab.classList.remove("bounce");
      void crab.offsetWidth;
      crab.classList.add("bounce");
      ring.classList.add("flash");
      setTimeout(() => ring.classList.remove("flash"), 90);
    }
  }
  // リングが拍に向かって縮む（予告）
  if (next) {
    const timeToNext = next.time - now;
    const frac = Math.max(0, Math.min(1, timeToNext / secondsPerBeat));
    const scale = 1 + 1.4 * frac;
    ring.style.transform = `scale(${scale})`;
    ring.style.opacity = (0.4 + 0.5 * (1 - frac)).toFixed(2);
  }
  requestAnimationFrame(render);
}

// === 開始 ===
function startGame() {
  if (isPlaying) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.6;
  masterGain.connect(audioCtx.destination);
  musicGain = audioCtx.createGain();
  musicGain.gain.value = 0.17;
  musicGain.connect(masterGain);
  // iOS対策：ユーザー操作の中でresume
  if (audioCtx.state === "suspended") audioCtx.resume();

  isPlaying = true;
  bpm = BPM_START;
  secondsPerBeat = 60 / bpm;
  successCount = 0;
  combo = 0;
  scheduledBeats = [];
  nextNoteTime = audioCtx.currentTime + 0.2;
  musicIndex = 0;
  musicTime = nextNoteTime;

  startScreen.classList.add("hidden");
  gameScreen.classList.remove("hidden");

  schedulerId = setInterval(scheduler, LOOKAHEAD_MS);
  requestAnimationFrame(render);
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
