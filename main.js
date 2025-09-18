"use strict";

(() => {
  const TOKENS = ["うー", "たつ", "みー"]; // 0,1,2
  const TOKEN_ICON_SRC = [
    "./assets/images/u.png",
    "./assets/images/tatsu.png",
    "./assets/images/mi.png",
  ];
  const TOKEN_VOICE_SRC = [
    "./assets/sounds/u.mp3",
    "./assets/sounds/tatsu.mp3",
    "./assets/sounds/mi.mp3",
  ];
  const KEY_TO_TOKEN = { ArrowUp: 0, ArrowLeft: 1, ArrowRight: 2 };
  const MAX_MISS = 5;
  const SEQ_LENGTH = 7; // 4 拍ランダム + うー・たつ・みー
  const RANDOM_HEAD = 4;
  const INITIAL_BPM = 90;
  const BPM_INC_PER_LOOP = 6; // 1周ごとに +6 BPM
  const MAX_BPM = 220;
  const COUNT_IN_BEATS = 4; // 開始時のカウント
  // 判定関連（拍末からのオフセットだけ手前にターゲット化）
  const HIT_TARGET_FROM_END_MS = 60; // 拍末からの手前オフセット
  const JUDGE_PERFECT_MS = 90; // PERFECT 判定幅（±）
  const JUDGE_OK_MS = 180; // OK 判定幅（±）

  /**
   * UI 参照
   */
  const el = {
    startBtn: document.getElementById("startBtn"),
    roundCount: document.getElementById("roundCount"),
    missCount: document.getElementById("missCount"),
    bpmDisplay: document.getElementById("bpmDisplay"),
    sequenceTrack: document.getElementById("sequenceTrack"),
    progressFill: document.getElementById("progressFill"),
    progressSection: document.querySelector(".progress"),
    countInHud: document.getElementById("countInHud"),
    countInNumber: document.getElementById("countInNumber"),
    overlay: document.getElementById("overlay"),
    finalRound: document.getElementById("finalRound"),
    overlayRestartBtn: document.getElementById("overlayRestartBtn"),
    inputButtons: Array.from(document.querySelectorAll(".input-btn")),
  };

  /**
   * シンセ: シンプルなクリック音
   */
  class BeepSynth {
    constructor(audioCtx) {
      this.audioCtx = audioCtx;
    }

    click(accent = false) {
      if (!this.audioCtx) return;
      const now = this.audioCtx.currentTime;
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      osc.type = "square";
      osc.frequency.value = accent ? 1280 : 980;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(accent ? 0.18 : 0.12, now + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
      osc.connect(gain).connect(this.audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.09);
    }
  }

  /**
   * 状態
   */
  const state = {
    running: false,
    paused: false,
    audioCtx: null,
    synth: null,
    voiceBuffers: [null, null, null],
    voiceElements: [null, null, null],
    bpm: INITIAL_BPM,
    sequence: [], // 数値 0,1,2
    beatIndex: 0, // 0..6
    roundCount: 0,
    missCount: 0,
    awaitingInput: false,
    receivedInput: false,
    lastInputToken: null,
    lastInputAt: 0,
    beatStartAt: 0,
    rafId: 0,
    inCountIn: false,
    countInLeft: 0,
  };

  function pickRandomToken() {
    return Math.floor(Math.random() * 3); // 0..2
  }

  function generateSequence() {
    const seq = [];
    for (let i = 0; i < RANDOM_HEAD; i++) {
      seq.push(pickRandomToken());
    }
    // 最後は うー・たつ・みー
    seq.push(0, 1, 2);
    return seq;
  }

  function tokenToClass(token) {
    return token === 0 ? "u" : token === 1 ? "ta" : "mi";
  }

  function tokenToKeyLabel(token) {
    return token === 0 ? "↑" : token === 1 ? "←" : "→";
  }

  function renderSequence() {
    el.sequenceTrack.innerHTML = "";
    for (let i = 0; i < state.sequence.length; i++) {
      const token = state.sequence[i];
      const cell = document.createElement("div");
      cell.className = `cell ${tokenToClass(token)}`;
      if (i === state.beatIndex) cell.classList.add("current");
      const iconWrap = document.createElement("div");
      iconWrap.className = "icon";
      const img = document.createElement("img");
      img.src = TOKEN_ICON_SRC[token];
      img.alt = TOKENS[token];
      img.decoding = "async";
      img.loading = "eager";
      iconWrap.appendChild(img);
      const jp = document.createElement("div");
      jp.className = "jp";
      jp.textContent = TOKENS[token];
      const num = document.createElement("div");
      num.className = "num";
      num.textContent = `${tokenToKeyLabel(token)}`;
      cell.appendChild(iconWrap);
      cell.appendChild(jp);
      cell.appendChild(num);
      el.sequenceTrack.appendChild(cell);
    }
  }

  async function loadVoices(ctx) {
    // まずHTMLAudioElementを準備（フォールバック）
    state.voiceElements = TOKEN_VOICE_SRC.map((src) => {
      const a = new Audio(src);
      a.preload = "auto";
      try { a.crossOrigin = "anonymous"; } catch (_) {}
      try { a.load(); } catch (_) {}
      return a;
    });
    // file:// の場合は fetch がCORS扱いになるためスキップ
    const isFile = typeof location !== "undefined" && location.protocol === "file:";
    if (isFile) {
      state.voiceBuffers = [null, null, null];
      return;
    }
    // 可能ならWebAudioデコードを試みる
    try {
      const buffers = await Promise.all(
        TOKEN_VOICE_SRC.map(async (src) => {
          const res = await fetch(src);
          const arr = await res.arrayBuffer();
          return await ctx.decodeAudioData(arr);
        })
      );
      state.voiceBuffers = buffers;
    } catch (_) {
      // fetch/decode失敗時は voiceElements 再生にフォールバック
    }
  }

  function playVoice(token) {
    const ctx = state.audioCtx;
    const buf = state.voiceBuffers[token];
    if (ctx && buf) {
      const src = ctx.createBufferSource();
      const gain = ctx.createGain();
      src.buffer = buf;
      gain.gain.value = 1.0;
      src.connect(gain).connect(ctx.destination);
      src.start();
      return;
    }
    const el = state.voiceElements[token];
    if (el) {
      // 同時再生に備えてクローンを使う
      const clone = el.cloneNode(true);
      clone.volume = 1.0;
      clone.play().catch(() => {});
    }
  }

  function scheduleBeatClick(accent = false, nowTs = performance.now()) {
    if (!state.synth) return;
    // クリック音を判定ターゲット（拍末 - オフセット）に合わせる
    const targetMs = state.beatStartAt + getBeatIntervalMs() - HIT_TARGET_FROM_END_MS;
    const delay = Math.max(0, targetMs - nowTs);
    setTimeout(() => {
      // running中のみ鳴らす
      if (state.running && !state.paused) state.synth.click(accent);
    }, delay);
  }

  function showJudgeOnCell(cell, type, timingLabel) {
    if (!cell) return;
    // type: 'perfect' | 'ok' | 'miss'
    cell.classList.remove("hit-perfect", "hit-ok", "hit-miss");
    const hitClass = type === "perfect" ? "hit-perfect" : type === "ok" ? "hit-ok" : "hit-miss";
    cell.classList.add(hitClass);
    // 既存バッジを除去
    const old = cell.querySelector(".judge-badge");
    if (old) old.remove();
    // バッジ追加
    const badge = document.createElement("div");
    badge.className = `judge-badge ${type}`;
    badge.textContent = type === "perfect" ? "PERFECT" : type === "ok" ? "OK" : "MISS";
    cell.appendChild(badge);
    // 少ししてフェードアウト（表示時間延長）
    setTimeout(() => {
      badge.classList.add("fade-out");
      setTimeout(() => badge.remove(), 380);
    }, 420);
    // ヒット枠のハイライトも短時間で戻す
    setTimeout(() => cell.classList.remove(hitClass), 260);
  }

  function updateSequenceHighlight() {
    const cells = el.sequenceTrack.querySelectorAll(".cell");
    cells.forEach((c, idx) => {
      if (idx === state.beatIndex) c.classList.add("current");
      else c.classList.remove("current");
    });
  }

  function updateStats() {
    el.roundCount.textContent = String(state.roundCount);
    el.missCount.textContent = String(state.missCount);
    el.bpmDisplay.textContent = String(Math.round(state.bpm));
  }

  function setButtonsEnabled(enabled) {
    el.inputButtons.forEach((b) => (b.disabled = !enabled));
  }

  function setControlStates() {
    el.startBtn.disabled = state.running;
  }

  function showOverlay(show) {
    el.overlay.classList.toggle("hidden", !show);
    if (show) {
      el.finalRound.textContent = String(state.roundCount);
    }
  }

  function getBeatIntervalMs() {
    return 60000 / state.bpm;
  }

  function startLoop(nowTs) {
    // 最初のビートへ遷移（小さなプリロール）
    state.beatStartAt = nowTs + 400;
    state.beatIndex = 0;
    state.awaitingInput = true;
    state.receivedInput = false;
    state.lastInputToken = null;
    state.lastInputAt = 0;
    renderSequence();
    // クリック音（低）を判定中心タイミングに合わせて再生
    scheduleBeatClick(false, nowTs);
    requestNextFrame();
  }

  function startCountIn(nowTs) {
    state.inCountIn = true;
    state.countInLeft = COUNT_IN_BEATS;
    state.beatStartAt = nowTs; // カウントは即開始
    state.beatIndex = -1; // カウント中
    state.awaitingInput = false;
    state.receivedInput = false;
    setButtonsEnabled(false);
    renderSequence();
    if (el.progressSection) el.progressSection.style.display = "none";
    if (el.countInHud) el.countInHud.classList.remove("hidden");
    // 1 拍目のカウントクリックを予約（低音）
    scheduleBeatClick(false, nowTs);
    requestNextFrame();
  }

  function advanceBeat(ts) {
    // ビート終了時に判定（タイミング幅あり）
    const expected = state.sequence[state.beatIndex];
    const cells = el.sequenceTrack.querySelectorAll(".cell");
    const cell = cells[state.beatIndex];
    let judgedType = "miss"; // 'perfect' | 'ok' | 'miss'
    let timingLabel = null; // timing feedback hidden from badge
    if (state.receivedInput && state.lastInputToken === expected) {
      const expectedTime = state.beatStartAt + getBeatIntervalMs() - HIT_TARGET_FROM_END_MS;
      const delta = state.lastInputAt - expectedTime; // マイナス=早い、プラス=遅い
      const absDelta = Math.abs(delta);
      if (absDelta <= JUDGE_PERFECT_MS) {
        judgedType = "perfect";
      } else if (absDelta <= JUDGE_OK_MS) {
        judgedType = "ok";
      } else {
        judgedType = "miss";
      }
      // timingLabelは今は使わない（表示しない）
    }
    if (judgedType === "miss") {
      state.missCount += 1;
      flashMiss();
      updateStats();
      if (state.missCount >= MAX_MISS) {
        // 直前セルにも MISS を表示
        showJudgeOnCell(cell, "miss", timingLabel);
        gameOver();
        return;
      }
    }
    // 視覚フィードバック
    showJudgeOnCell(cell, judgedType, timingLabel);

    // 次ビートへ
    state.beatIndex += 1;
    state.receivedInput = false;
    state.lastInputToken = null;
    state.lastInputAt = 0;
    state.awaitingInput = true;
    state.beatStartAt = ts;

    const endOfSeq = state.beatIndex >= state.sequence.length;
    if (endOfSeq) {
      // 1 周完了
      state.roundCount += 1;
      // 速度上昇
      state.bpm = Math.min(state.bpm + BPM_INC_PER_LOOP, MAX_BPM);
      state.sequence = generateSequence();
      state.beatIndex = 0;
      state.beatStartAt = ts + 400; // 次ループ頭に少し間をおく
      updateStats();
      renderSequence();
      // 次ループの頭は高音にしない
      scheduleBeatClick(false, ts);
    } else {
      updateSequenceHighlight();
      // 現在のビートが最終拍ならアクセント、それ以外は低音
      const isLastBeat = state.beatIndex === state.sequence.length - 1;
      scheduleBeatClick(isLastBeat, ts);
    }
  }

  function flashMiss() {
    document.body.animate(
      [
        { backgroundColor: "transparent" },
        { backgroundColor: "rgba(255, 92, 92, 0.18)" },
        { backgroundColor: "transparent" },
      ],
      { duration: 200, easing: "ease-out" }
    );
  }

  function updateProgress(ts) {
    const interval = getBeatIntervalMs();
    const p = Math.max(0, Math.min(1, (ts - state.beatStartAt) / interval));
    el.progressFill.style.width = `${p * 100}%`;
  }

  function onInput(token) {
    if (!state.running || state.paused) return;
    // 1 拍に 1 入力のみ有効
    if (!state.awaitingInput || state.receivedInput) return;
    state.receivedInput = true;
    state.lastInputToken = token;
    state.lastInputAt = performance.now();
    // 入力に応じた音声再生
    playVoice(token);
    // 押したボタンを軽くフィードバック
    const btn = el.inputButtons[token];
    if (btn) btn.animate([{ transform: "scale(1)" }, { transform: "scale(0.96)" }, { transform: "scale(1)" }], { duration: 120, easing: "ease-out" });
  }

  function loop(ts) {
    if (!state.running) return;
    if (state.paused) {
      el.progressFill.style.width = "0%";
      state.rafId = requestAnimationFrame(loop);
      return;
    }
    const interval = getBeatIntervalMs();
    // カウントイン中の処理
    if (state.inCountIn) {
      if (ts - state.beatStartAt >= interval) {
        state.countInLeft -= 1;
        state.beatStartAt = ts;
        if (state.countInLeft <= 0) {
          // カウントイン終了 → 通常進行へ
          state.inCountIn = false;
          state.beatIndex = 0;
          state.awaitingInput = true;
          state.receivedInput = false;
          setButtonsEnabled(true);
          updateSequenceHighlight();
          // 最初の実プレイビートのクリック（低音）を予約
          scheduleBeatClick(false, ts);
          if (el.progressSection) el.progressSection.style.display = "";
          if (el.countInHud) el.countInHud.classList.add("hidden");
        } else {
          // 次のカウントクリックを予約（最後だけ高音）
          const isLastCount = state.countInLeft === 1;
          scheduleBeatClick(isLastCount, ts);
        }
      }
      if (el.countInNumber) {
        const remaining = Math.max(0, state.countInLeft);
        el.countInNumber.textContent = String(remaining === 0 ? 1 : remaining);
      }
      updateProgress(ts);
      state.rafId = requestAnimationFrame(loop);
      return;
    }
    if (ts - state.beatStartAt >= interval) {
      advanceBeat(ts);
    }
    updateProgress(ts);
    state.rafId = requestAnimationFrame(loop);
  }

  function requestNextFrame() {
    cancelAnimationFrame(state.rafId);
    state.rafId = requestAnimationFrame(loop);
  }

  function gameOver() {
    state.running = false;
    setButtonsEnabled(false);
    setControlStates();
    showOverlay(true);
  }

  function startGame() {
    if (state.running) return;
    if (!state.audioCtx) {
      try {
        state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        state.synth = new BeepSynth(state.audioCtx);
        // 入力ボイスを非同期ロード
        loadVoices(state.audioCtx);
      } catch (e) {
        // Audio が使えない環境は無音でも進行
        state.audioCtx = null;
        state.synth = null;
      }
    }
    // 初期化
    state.running = true;
    state.paused = false;
    state.bpm = INITIAL_BPM;
    state.roundCount = 0;
    state.missCount = 0;
    state.sequence = generateSequence();
    updateStats();
    renderSequence();
    setButtonsEnabled(false);
    setControlStates();
    showOverlay(false);
    startCountIn(performance.now());
  }

  // ポーズ機能は削除

  function restartGame() {
    // 状態をリセットして start と同じ
    state.running = false;
    showOverlay(false);
    startGame();
  }

  // 入力イベント
  window.addEventListener("keydown", (ev) => {
    const token = KEY_TO_TOKEN[ev.key];
    if (token === 0 || token === 1 || token === 2) {
      ev.preventDefault();
      onInput(token);
    }
  });

  el.inputButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const token = Number(btn.getAttribute("data-token"));
      onInput(token);
    });
  });

  // コントロール
  el.startBtn.addEventListener("click", startGame);
  el.overlayRestartBtn.addEventListener("click", restartGame);

  // 初期状態
  setButtonsEnabled(false);
  setControlStates();
  renderSequence();
})();



