/* ================= バイブコーディング プロの作法 ナレータ ================= */
(function () {
  'use strict';

  const MANIFEST_URL = 'audio-manifest.json';

  class Narrator {
    constructor() {
      this.manifest = null;
      this.blocks = [];
      this.idx = -1;
      this.audio = new Audio();
      this.audio.preload = 'auto';
      this.playing = false;
      this.rate = 1.0;
      this.cumStart = [];      // 各ブロックの開始累積秒
      this.totalSec = 0;
      this.userScrollingUntil = 0;
      this.ready = false;

      this.nextTimer = null;
      this.audio.addEventListener('ended', () => this.scheduleNext());
      // 章扉 / オープニングの読み上げ用（本編 audio とは別ストリーム）
      this.transAudio = new Audio();
      this.transAudio.preload = 'auto';
      this.audio.addEventListener('timeupdate', () => this.onTimeUpdate());
      this.captionEnabled = true;
      this.captionEl = null;
      this.captionCharEls = null;
      this.captionCumWeights = null;
      this.captionTotalWeight = 0;
      this.chapterLabels = {
        'intro': 'Introduction',
        'speaker': 'Chapter 01 · Speaker',
        'definition': 'Chapter 02 · What is Vibe Coding',
        'dangers': 'Chapter 03 · Pitfalls',
        'exponential': 'Chapter 04 · The Exponential',
        'leaf-nodes': 'Chapter 05 · Leaf Nodes',
        'be-pm': "Chapter 06 · Be Claude's PM",
        'case-study': 'Chapter 07 · Case Study',
        'closing': 'Chapter 08 · Closing Thoughts',
        'qa': 'Chapter 09 · Q & A',
        'checklist': 'Chapter 10 · Checklist',
      };
      this.chapterInfo = {
        'intro':          { num: '00', en: 'Introduction',         jp: 'はじめに' },
        'speaker':        { num: '01', en: 'Speaker',              jp: '話し手について' },
        'definition':     { num: '02', en: 'What is Vibe Coding',  jp: 'バイブコーディングとは' },
        'dangers':        { num: '03', en: 'Pitfalls',             jp: '落とし穴と期待値' },
        'exponential':    { num: '04', en: 'The Exponential',      jp: '指数関数の波' },
        'leaf-nodes':     { num: '05', en: 'Leaf Nodes',           jp: '葉ノード戦略' },
        'be-pm':          { num: '06', en: "Be Claude's PM",       jp: 'Claude の PM になる' },
        'case-study':     { num: '07', en: 'Case Study',           jp: '2万2千行のPR' },
        'closing':        { num: '08', en: 'Closing Thoughts',     jp: '持ち帰るべきこと' },
        'qa':             { num: '09', en: 'Q & A',                jp: '質疑応答' },
        'checklist':      { num: '10', en: 'Checklist',            jp: 'チェックリスト' },
      };
      this.audio.addEventListener('loadedmetadata', () => this.onMeta());
    }

    async load() {
      const res = await fetch(MANIFEST_URL);
      this.manifest = await res.json();
      this.blocks = this.manifest.blocks || [];

      // Piyoブロックは本文に存在しないので、DOMに挿入
      this.injectPiyoBubbles();

      // duration 累積
      let t = 0;
      this.cumStart = this.blocks.map(b => {
        const s = t;
        t += (b.duration_sec || 0);
        return s;
      });
      this.totalSec = t;

      // 既存のクリックハンドラ（TOC）を尊重しつつ、ブロッククリックで再生
      this.attachBlockClicks();

      // スクロール検知
      this.attachUserScrollDetection();

      this.ready = true;
      this.updateTime();
      this.updateNowLabel();
    }

    injectPiyoBubbles() {
      // grid/list の内側に挿入すると縦長表示になるため、外へ這い上がる
      const CLIMB_TAGS = new Set(['UL', 'OL', 'DL']);
      const CLIMB_CLASSES = ['feat-grid', 'doc-meta', 'checklist-group', 'checklist'];

      for (const b of this.blocks) {
        if (b.type !== 'piyo') continue;
        if (document.querySelector(`[data-narr-id="${b.id}"]`)) continue;
        const { mode, ref } = b.anchor || {};
        const anchor = document.querySelector(`[data-narr-id="${ref}"]`);
        if (!anchor) continue;

        let target = anchor;
        while (target.parentNode && target.parentNode.nodeType === 1) {
          const p = target.parentNode;
          const hasClimbClass = Array.from(p.classList || [])
            .some(c => CLIMB_CLASSES.includes(c));
          if (CLIMB_TAGS.has(p.tagName) || hasClimbClass) {
            target = p;
          } else {
            break;
          }
        }

        const div = document.createElement('div');
        div.className = 'piyo-bubble';
        div.setAttribute('data-narr-id', b.id);
        div.innerHTML = `<div class="piyo-label">Piyofeed comment</div><div>${escapeHtml(b.text)}</div>`;

        if (mode === 'before') {
          target.parentNode.insertBefore(div, target);
        } else {
          target.parentNode.insertBefore(div, target.nextSibling);
        }
      }
    }

    // ブロック種別に応じた「間」
    getPauseAfter(block) {
      if (!block) return 150;
      switch (block.kind) {
        case 'h1': return 1400;
        case 'h2': return 1100;
        case 'h3': return 750;
        case 'h4': return 500;
        case 'p.subtitle': return 1000;
        default: break;
      }
      // 次のブロックが章見出しなら、今のブロックの後に少し余韻
      const nextIdx = this.idx + 1;
      if (nextIdx < this.blocks.length) {
        const nk = this.blocks[nextIdx].kind;
        if (nk === 'h1' || nk === 'h2') return 900;
        if (nk === 'h3') return 500;
      }
      return 220;
    }

    scheduleNext() {
      const cur = this.blocks[this.idx];
      const delay = this.getPauseAfter(cur);
      this.cancelNextTimer();
      this.nextTimer = setTimeout(() => {
        this.nextTimer = null;
        this.next();
      }, delay);
    }

    cancelNextTimer() {
      if (this.nextTimer) {
        clearTimeout(this.nextTimer);
        this.nextTimer = null;
      }
    }

    attachBlockClicks() {
      document.querySelectorAll('[data-narr-id]').forEach(el => {
        el.addEventListener('click', (e) => {
          // チェックボックス/リンクの操作を邪魔しない
          const tag = e.target.tagName;
          if (tag === 'INPUT' || tag === 'A' || tag === 'LABEL') return;
          if (e.target.closest('a')) return;
          const id = el.getAttribute('data-narr-id');
          const i = this.blocks.findIndex(b => b.id === id);
          if (i >= 0) this.playBlock(i);
        });
      });
    }

    attachUserScrollDetection() {
      const onUserIntent = () => {
        this.userScrollingUntil = Date.now() + 2500;
      };
      window.addEventListener('wheel', onUserIntent, { passive: true });
      window.addEventListener('touchmove', onUserIntent, { passive: true });
      window.addEventListener('keydown', (e) => {
        if (['ArrowUp','ArrowDown','PageUp','PageDown','Home','End'].includes(e.key)) {
          onUserIntent();
        }
      });
    }

    // ===== 再生制御 =====
    playBlock(i) {
      if (i < 0 || i >= this.blocks.length) return;
      this.cancelNextTimer();
      const prevChapter = (this.idx >= 0) ? this.blocks[this.idx].chapter : null;
      const wasPlayingSomething = this.idx >= 0;
      const isFirstPlay = !wasPlayingSomething && !this._openingPlayed;
      this.idx = i;
      const b = this.blocks[i];
      this.enterTheater();
      this.updateChapterTint(b);
      // audio_version をクエリ文字列に付けてブラウザキャッシュを無効化
      const v = b.audio_version ? `?v=${b.audio_version}` : '';
      this.audio.src = b.audio + v;
      this.audio.playbackRate = this.rate;
      this.highlight(b.id);
      this.scrollToBlock(b.id);
      this.updateNowLabel();

      const isChapterChange = wasPlayingSomething && prevChapter && prevChapter !== b.chapter;

      if (isFirstPlay) {
        this._openingPlayed = true;
        if (this.captionEl) this.captionEl.classList.add('hidden');
        this.playOpeningCinema().then(() => {
          this.updateCaption(b);
          this._startAudio();
        });
      } else if (isChapterChange) {
        // 章扉の間は字幕を一時的に隠す
        if (this.captionEl) this.captionEl.classList.add('hidden');
        this.playChapterTransition(b.chapter).then(() => {
          this.updateCaption(b);
          this._startAudio();
        });
      } else {
        this.updateCaption(b);
        this._startAudio();
      }
      this.playing = true;
      this.updatePlayButton();
    }

    _startAudio() {
      this._initAudioGraph();
      if (this._audioCtx && this._audioCtx.state === 'suspended') {
        this._audioCtx.resume().catch(() => {});
      }
      const p = this.audio.play();
      if (p && typeof p.catch === 'function') {
        p.catch(err => console.warn('play blocked:', err));
      }
    }

    // ===== Living Background (canvas + WebAudio) =====
    _initAudioGraph() {
      if (this._audioCtx) return;
      try {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return;
        this._audioCtx = new Ctor();
        const src = this._audioCtx.createMediaElementSource(this.audio);
        this._analyser = this._audioCtx.createAnalyser();
        this._analyser.fftSize = 512;
        this._analyser.smoothingTimeConstant = 0.82;
        src.connect(this._analyser);
        this._analyser.connect(this._audioCtx.destination);
        this._freqData = new Uint8Array(this._analyser.frequencyBinCount);
      } catch (err) {
        console.warn('audio graph init failed:', err);
      }
    }

    initLivingBg() {
      const cvs = document.createElement('canvas');
      cvs.className = 'living-bg';
      document.body.insertBefore(cvs, document.body.firstChild);
      this._bgCanvas = cvs;
      this._bgCtx = cvs.getContext('2d');
      this._mouseX = window.innerWidth / 2;
      this._mouseY = window.innerHeight / 2;
      window.addEventListener('mousemove', (e) => {
        this._mouseX = e.clientX;
        this._mouseY = e.clientY;
      }, { passive: true });

      // パララックス粒子
      this._particles = [];
      const N = 70;
      for (let i = 0; i < N; i++) {
        this._particles.push({
          x: Math.random() * window.innerWidth,
          y: Math.random() * window.innerHeight,
          r: 0.5 + Math.random() * 2.2,
          depth: 0.15 + Math.random() * 0.85,
          phase: Math.random() * Math.PI * 2,
          freq: 0.00025 + Math.random() * 0.0008,
          drift: (Math.random() - 0.5) * 0.08,
        });
      }

      this._resizeBg();
      window.addEventListener('resize', () => this._resizeBg());
      this._animateBg();
    }

    _resizeBg() {
      if (!this._bgCanvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = window.innerWidth;
      const h = window.innerHeight;
      this._bgCanvas.width = w * dpr;
      this._bgCanvas.height = h * dpr;
      this._bgCanvas.style.width = w + 'px';
      this._bgCanvas.style.height = h + 'px';
      this._bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    _animateBg() {
      const loop = () => {
        this._drawBg();
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }

    _cssColor(name, fallback) {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    }
    _rgbToHue(r, g, b) {
      r /= 255; g /= 255; b /= 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const d = max - min;
      if (d === 0) return 0;
      let h;
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
      return h;
    }
    _toRgb(css) {
      // "#RRGGBB" or "rgb(r,g,b)" → [r,g,b]
      css = (css || '').trim();
      if (css.startsWith('#')) {
        const h = css.slice(1);
        const n = h.length === 3
          ? h.split('').map(c => parseInt(c + c, 16))
          : [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
        return n;
      }
      const m = css.match(/rgba?\(([^)]+)\)/);
      if (m) {
        const p = m[1].split(',').map(s => parseFloat(s));
        return [p[0]|0, p[1]|0, p[2]|0];
      }
      return [232, 177, 90];
    }

    _drawBg() {
      const ctx = this._bgCtx;
      if (!ctx) return;
      const w = window.innerWidth;
      const h = window.innerHeight;
      ctx.clearRect(0, 0, w, h);
      // シアターモード時のみ描画（それ以外は透明のまま）
      if (!document.documentElement.classList.contains('theater-on')) return;

      const [ar, ag, ab] = this._toRgb(this._cssColor('--theater-accent', '#E8B15A'));
      const [sr, sg, sb] = this._toRgb(this._cssColor('--theater-accent-soft', '#F0C988'));
      const t = performance.now();
      const scroll = window.scrollY || 0;

      // 1) マウス追従ライト（ソフトな大きなグラデ）
      const radius = Math.min(w, h) * 0.55;
      const grad = ctx.createRadialGradient(this._mouseX, this._mouseY, 0, this._mouseX, this._mouseY, radius);
      grad.addColorStop(0, `rgba(${ar},${ag},${ab},0.11)`);
      grad.addColorStop(0.4, `rgba(${sr},${sg},${sb},0.05)`);
      grad.addColorStop(1, `rgba(${ar},${ag},${ab},0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      // 2) パララックス粒子（スクロール + 時間でドリフト）
      for (const p of this._particles) {
        const offset = scroll * p.depth * 0.25 + Math.sin(t * p.freq + p.phase) * 12;
        let yy = (p.y - offset) % (h + 40);
        if (yy < -20) yy += (h + 40);
        const xx = p.x + Math.cos(t * p.freq * 0.6 + p.phase) * 6;
        const alpha = 0.18 + p.depth * 0.42;
        ctx.fillStyle = `rgba(${sr},${sg},${sb},${alpha})`;
        ctx.beginPath();
        ctx.arc(xx, yy, p.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // 3) 音声スペクトル：下部に薄い多色バー（さりげないレインボー）
      if (this._analyser && this.audio && !this.audio.paused) {
        if (!this._freqData) this._freqData = new Uint8Array(this._analyser.frequencyBinCount);
        this._analyser.getByteFrequencyData(this._freqData);
        const bins = this._freqData.length;
        const barCount = 72;
        const step = Math.floor(bins / barCount);
        const bw = w / barCount;
        const maxH = Math.min(90, h * 0.12);
        const base = h - 4;

        // 色：画面左→右で hue が滑らかに変化（cyan→blue→purple→magenta→red→amber）
        // 章アクセントの hue を中心に ±60 度 ずらす
        const accentHue = this._rgbToHue(ar, ag, ab);
        const hueStart = accentHue - 70;
        const hueEnd = accentHue + 90;

        // バー本体（やや太め、角が丸く見えるよう2段重ね）
        for (let i = 0; i < barCount; i++) {
          let v = 0;
          for (let j = 0; j < step; j++) v += this._freqData[i * step + j];
          v = (v / step) / 255;
          const bh = Math.pow(v, 1.25) * maxH;
          if (bh < 1) continue;
          const hue = hueStart + (i / (barCount - 1)) * (hueEnd - hueStart);
          // 本体
          ctx.fillStyle = `hsla(${hue}, 65%, 62%, 0.32)`;
          ctx.fillRect(i * bw + 1.5, base - bh, bw - 3, bh);
          // 天頂のわずかな明るい一点（ピーク強調、さりげない）
          ctx.fillStyle = `hsla(${hue}, 80%, 78%, 0.55)`;
          ctx.fillRect(i * bw + 1.5, base - bh, bw - 3, Math.min(1.5, bh));
        }
      }
    }

    _playTransitionAudio(name) {
      const meta = this.manifest && this.manifest.transition_audio && this.manifest.transition_audio[name];
      if (!meta) return;
      const v = meta.audio_version ? `?v=${meta.audio_version}` : '';
      this.transAudio.src = meta.audio + v;
      this.transAudio.currentTime = 0;
      const p = this.transAudio.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => {});
      }
    }

    async playOpeningCinema() {
      if (this._transitionBusy) return;
      this._transitionBusy = true;
      const prev = document.querySelector('.opening-cinema');
      if (prev) prev.remove();
      const overlay = document.createElement('div');
      overlay.className = 'opening-cinema';
      overlay.innerHTML = `
        <div class="oc-inner">
          <div class="oc-eyebrow">A Claude Opus 4.7 Production</div>
          <div class="oc-title-jp">バイブコーディング</div>
          <div class="oc-title-accent">プロの作法</div>
          <div class="oc-sub">— Claude Code 完 全 ガ イ ド —</div>
          <div class="oc-line"></div>
          <div class="oc-credit">Based on a talk by <strong>Eric</strong> · Anthropic Research</div>
          <div class="oc-event">Code w/ Claude · Coding Agents Session</div>
        </div>
        <div class="oc-skip">click to skip</div>
      `;
      document.body.appendChild(overlay);

      let skipped = false;
      overlay.addEventListener('click', () => {
        skipped = true;
        try { this.transAudio.pause(); } catch(e) {}
      });

      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      overlay.classList.add('is-visible');
      // 少し遅らせてタイトル読み上げ開始（文字が出るのに合わせる）
      setTimeout(() => this._playTransitionAudio('opening'), 700);

      // 総尺：最後の要素（oc-event）が 2.95+0.6=3.55s で出揃う → 1.8s hold → 5.35s
      const waitStep = 60;
      const totalMs = 5400;
      let elapsed = 0;
      while (elapsed < totalMs && !skipped) {
        await new Promise(r => setTimeout(r, waitStep));
        elapsed += waitStep;
      }

      overlay.classList.remove('is-visible');
      await new Promise(r => setTimeout(r, 700));
      overlay.remove();
      this._transitionBusy = false;
    }

    async playEndingCredits(force = false) {
      if (this._creditsPlayed && !force) return;
      this._creditsPlayed = true;
      const prev = document.querySelector('.ending-credits');
      if (prev) prev.remove();
      const overlay = document.createElement('div');
      overlay.className = 'ending-credits';
      overlay.innerHTML = `
        <div class="ec-reel">
          <div class="ec-fin">Fin.</div>
          <div class="ec-divider"></div>

          <div class="ec-block">
            <div class="ec-label">The Guide</div>
            <div class="ec-value">バイブコーディング プロの作法</div>
            <div class="ec-value is-small">Claude Code 完全ガイド — 音声ナレーション版</div>
          </div>

          <div class="ec-divider"></div>

          <div class="ec-block">
            <div class="ec-label">Based on a talk by</div>
            <div class="ec-value">Eric</div>
            <div class="ec-value is-small">Research · Coding Agents, Anthropic</div>
          </div>

          <div class="ec-block">
            <div class="ec-label">Event</div>
            <div class="ec-value">Code w/ Claude</div>
            <div class="ec-value is-small">Session: How to Vibe Code in Prod Responsibly</div>
          </div>

          <div class="ec-divider"></div>

          <div class="ec-block">
            <div class="ec-label">Narration</div>
            <div class="ec-value">クロード</div>
            <div class="ec-value is-small">— 賢きフクロウの案内役 —</div>
          </div>

          <div class="ec-block">
            <div class="ec-label">Companion</div>
            <div class="ec-value">Piyofeed</div>
            <div class="ec-value is-small">— やわらかなひよこの相棒 —</div>
          </div>

          <div class="ec-divider"></div>

          <div class="ec-block">
            <div class="ec-label">Voice Synthesis</div>
            <div class="ec-value">Fish Audio · S2-Pro</div>
          </div>

          <div class="ec-block">
            <div class="ec-label">Designed & Built with</div>
            <div class="ec-value">Claude Opus 4.7</div>
            <div class="ec-value is-small">Claude Code · 1M context</div>
          </div>

          <div class="ec-divider"></div>

          <div class="ec-thanks">Thank you for listening.</div>
          <div class="ec-note">
            ここまで聴いてくれてありがとう。<br/>
            次は、あなたと Claude Code で何を作りましょうか。
          </div>

          <div class="ec-year">MMXXVI</div>
        </div>
        <div class="ec-skip">click to close</div>
      `;
      document.body.appendChild(overlay);

      // クリックで即終了
      let closed = false;
      const closeIt = async () => {
        if (closed) return;
        closed = true;
        overlay.classList.remove('is-visible');
        await new Promise(r => setTimeout(r, 1000));
        overlay.remove();
        this.exitTheater();
      };
      overlay.addEventListener('click', closeIt);

      // 表示開始
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      overlay.classList.add('is-visible');

      // スクロール（CSS animation 36s）終了を待って自動クローズ
      const reel = overlay.querySelector('.ec-reel');
      reel.addEventListener('animationend', () => {
        // 1.5 秒余韻を置いてから閉じる
        setTimeout(closeIt, 1500);
      });
    }

    async playChapterTransition(chapter) {
      // 同時に複数起動されるのを防ぐ
      if (this._transitionBusy) return;
      this._transitionBusy = true;
      const info = this.chapterInfo[chapter] || { num: '??', en: chapter, jp: chapter };
      const prev = document.querySelector('.chapter-transition');
      if (prev) prev.remove();
      const overlay = document.createElement('div');
      overlay.className = 'chapter-transition';
      overlay.innerHTML = `
        <div class="ct-inner">
          <div class="ct-eyebrow">Chapter</div>
          <div class="ct-num">${info.num}</div>
          <div class="ct-line"></div>
          <div class="ct-jp">${info.jp}</div>
          <div class="ct-en">${info.en}</div>
        </div>
        <div class="ct-skip-hint">click to skip</div>
      `;
      document.body.appendChild(overlay);

      // クリックでスキップ
      let skipped = false;
      const onClick = () => {
        skipped = true;
        try { this.transAudio.pause(); } catch(e) {}
      };
      overlay.addEventListener('click', onClick);

      // 次フレームで表示開始（アニメーション発火）
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      overlay.classList.add('is-visible');
      // 番号が出るタイミングに合わせて章タイトル読み上げ
      setTimeout(() => this._playTransitionAudio(`chapter_${chapter}`), 500);

      // 表示時間：テキストが出揃ってから読む時間を確保（スキップで即短縮）
      const waitStep = 60;
      const totalMs = 4200;
      let elapsed = 0;
      while (elapsed < totalMs && !skipped) {
        await new Promise(r => setTimeout(r, waitStep));
        elapsed += waitStep;
      }

      // フェードアウト
      overlay.classList.remove('is-visible');
      await new Promise(r => setTimeout(r, 500));
      overlay.remove();
      this._transitionBusy = false;
    }

    toggle() {
      if (!this.ready) return;
      if (this.idx < 0) { this.playBlock(0); return; }
      if (this.audio.paused && !this.nextTimer) {
        this.audio.play();
        this.playing = true;
      } else {
        this.cancelNextTimer();
        this.audio.pause();
        this.playing = false;
      }
      this.updatePlayButton();
    }

    next() {
      if (this.idx + 1 < this.blocks.length) {
        this.playBlock(this.idx + 1);
      } else {
        // 終端：エンディング クレジットを再生
        this.playing = false;
        this.updatePlayButton();
        this.playEndingCredits();
      }
    }

    prev() {
      if (this.idx > 0) this.playBlock(this.idx - 1);
      else this.playBlock(0);
    }

    // 章スキップ：次/前の h2 を含むブロックまでジャンプ
    nextChapter() {
      for (let i = this.idx + 1; i < this.blocks.length; i++) {
        if (this.blocks[i].kind === 'h2' || this.blocks[i].kind === 'h1') {
          this.playBlock(i); return;
        }
      }
      this.playBlock(this.blocks.length - 1);
    }
    prevChapter() {
      // 現在より前で最も近い h2
      let target = 0;
      for (let i = this.idx - 1; i >= 0; i--) {
        if (this.blocks[i].kind === 'h2' || this.blocks[i].kind === 'h1') {
          target = i; break;
        }
      }
      this.playBlock(target);
    }

    setRate(r) {
      this.rate = r;
      this.audio.playbackRate = r;
      const btn = document.querySelector('.narrator-bar .rate');
      if (btn) btn.textContent = `${r}x`;
    }
    cycleRate() {
      const rates = [1.0, 1.2, 1.5, 0.8];
      const i = rates.indexOf(this.rate);
      const next = rates[(i + 1) % rates.length] || 1.0;
      this.setRate(next);
    }

    // 全体シークバーでクリック → 対応するブロックへ
    seekPct(pct) {
      const target = pct * this.totalSec;
      for (let i = this.blocks.length - 1; i >= 0; i--) {
        if (this.cumStart[i] <= target) {
          this.playBlock(i);
          const offset = target - this.cumStart[i];
          this.audio.currentTime = Math.max(0, offset);
          return;
        }
      }
    }

    // ===== シアターモード・章パレット =====
    enterTheater() {
      const html = document.documentElement;
      if (!html.classList.contains('theater-mode')) {
        html.classList.add('theater-mode');
        // 次フレームで theater-on を付与して vignette をフェードイン
        requestAnimationFrame(() => {
          requestAnimationFrame(() => html.classList.add('theater-on'));
        });
      }
    }
    exitTheater() {
      const html = document.documentElement;
      html.classList.remove('theater-on');
      // フェードアウト後にモード自体を外す
      setTimeout(() => html.classList.remove('theater-mode'), 900);
    }
    updateChapterTint(block) {
      if (!block) return;
      const ch = block.chapter || 'intro';
      const html = document.documentElement;
      if (html.dataset.chapter !== ch) {
        html.dataset.chapter = ch;
      }
    }

    // ===== UI更新 =====
    highlight(id) {
      document.querySelectorAll('.narr-active').forEach(e => e.classList.remove('narr-active'));
      // 過去ブロックをpast化
      for (let i = 0; i < this.idx; i++) {
        const el = document.querySelector(`[data-narr-id="${this.blocks[i].id}"]`);
        if (el) el.classList.add('narr-past');
      }
      for (let i = this.idx; i < this.blocks.length; i++) {
        const el = document.querySelector(`[data-narr-id="${this.blocks[i].id}"]`);
        if (el) el.classList.remove('narr-past');
      }
      const cur = document.querySelector(`[data-narr-id="${id}"]`);
      if (cur) cur.classList.add('narr-active');
    }

    scrollToBlock(id) {
      if (Date.now() < this.userScrollingUntil) return;
      const el = document.querySelector(`[data-narr-id="${id}"]`);
      if (!el) return;
      // 字幕が表示中ならその高さ分オフセットして、本文が字幕下の中央に来るように
      const capH = (this.captionEnabled && this.captionEl && !this.captionEl.classList.contains('hidden'))
        ? (this.captionEl.offsetHeight + 60)
        : 0;
      const vh = window.innerHeight;
      const elH = el.offsetHeight;
      const targetTop = capH + Math.max(0, (vh - capH - elH) / 2);
      const rect = el.getBoundingClientRect();
      const delta = rect.top - targetTop;
      window.scrollBy({ top: delta, behavior: 'smooth' });
    }

    onMeta() {
      // 単ブロックの長さが確定するたびに total 更新の余地があるが、
      // manifest 側の値を優先するので特に何もしない
    }

    onTimeUpdate() {
      this.updateTime();
      this.updateSeek();
      this.updateCaptionHighlight();
    }

    // ===== Caption / 文節カラオケ =====
    tokenizePhrases(text) {
      // 句読点・ダッシュで文節分割
      const phrases = [];
      let buf = '';
      const delims = /[、。！？,\.\?!—―]/;
      for (const ch of text) {
        buf += ch;
        if (delims.test(ch)) {
          phrases.push(buf);
          buf = '';
        }
      }
      if (buf.trim()) phrases.push(buf);
      // 長すぎる文節は空白や 20字ごとに分割
      return phrases.flatMap(p => this._splitLongPhrase(p));
    }

    _splitLongPhrase(p) {
      if (p.length <= 26) return [p];
      const parts = p.split(/(\s+)/);
      const merged = [];
      let cur = '';
      for (const part of parts) {
        if ((cur + part).length > 22 && cur) {
          merged.push(cur);
          cur = part;
        } else {
          cur += part;
        }
      }
      if (cur) merged.push(cur);
      const out = [];
      for (const m of merged) {
        if (m.length <= 26) { out.push(m); continue; }
        for (let i = 0; i < m.length; i += 20) {
          out.push(m.slice(i, i + 20));
        }
      }
      return out;
    }

    phraseWeight(p) {
      let w = p.length;
      const brackets = (p.match(/[「」『』（）()【】\[\]〈〉《》]/g) || []).length;
      w -= brackets * 0.35;
      // 音声の伸びる文字
      const longVowels = (p.match(/ー/g) || []).length;
      w += longVowels * 0.25;
      const trimmed = p.trim();
      // 句読点ごとの実測的な pause weight
      if (/[。！？!?]$/.test(trimmed)) w += 5.5;         // 文末：長い pause
      else if (/[、,]$/.test(trimmed)) w += 2.2;          // 読点：短い pause
      else if (/[—―]$/.test(trimmed)) w += 2.8;           // ダッシュ：中間
      else if (/[：]$/.test(trimmed)) w += 1.8;           // コロン
      return Math.max(w, 1);
    }

    updateCaption(block) {
      if (!this.captionEl) return;
      const meta = this.captionEl.querySelector('.caption-meta');
      const body = this.captionEl.querySelector('.caption-body');

      // メタラベル
      const chLabel = this.chapterLabels[block.chapter] || block.chapter;
      meta.textContent = block.type === 'piyo' ? 'Piyofeed Comment' : chLabel;

      // バリアントクラス
      this.captionEl.classList.remove('is-piyo','is-heading','is-subtitle','hidden');
      if (block.type === 'piyo') this.captionEl.classList.add('is-piyo');
      if (['h1','h2','h3','h4'].includes(block.kind)) this.captionEl.classList.add('is-heading');
      if (block.kind === 'p.subtitle') this.captionEl.classList.add('is-subtitle');

      // 一旦フェードアウト → 差し替え → フェードイン
      body.style.opacity = '0';
      body.style.transform = 'translateY(6px)';

      setTimeout(() => {
        const phrases = this.tokenizePhrases(block.text);
        const weights = phrases.map(p => this.phraseWeight(p));
        const sum = weights.reduce((a,b) => a+b, 0) || 1;
        const starts = [];
        let acc = 0;
        for (const w of weights) { starts.push(acc); acc += w; }

        // 音声にはリーディング/トレーリングの無音があるので
        // 実発話部分のみを各文節に割り当てる
        const totalDur = block.duration_sec || this.audio.duration || 1;
        const LEADING = 0.24;   // 音声生成時の先頭無音（タグ解釈含む）
        const TRAILING = 0.32;  // 末尾の句点余韻
        const speechDur = Math.max(0.3, totalDur - LEADING - TRAILING);
        const scale = speechDur / sum;
        this.phraseStarts = starts.map(s => LEADING + s * scale);
        this.phraseDurs = weights.map(w => Math.max(w * scale, 0.12));

        body.innerHTML = phrases.map((p, i) => {
          const esc = escapeHtml(p);
          return `<span class="caption-phrase" data-text="${esc}" style="--d:${i * 35}ms">${esc}</span>`;
        }).join(' ');
        this.captionPhraseEls = body.querySelectorAll('.caption-phrase');

        requestAnimationFrame(() => {
          body.style.opacity = '';
          body.style.transform = '';
        });
      }, 200);
    }

    updateCaptionHighlight() {
      if (!this.captionPhraseEls || !this.captionPhraseEls.length) return;
      if (!this.captionEnabled) return;
      const block = this.blocks[this.idx];
      if (!block) return;
      const t = this.audio.currentTime || 0;

      // どの文節がアクティブか
      let activeIdx = -1;
      for (let i = 0; i < this.phraseStarts.length; i++) {
        if (t >= this.phraseStarts[i]) activeIdx = i;
        else break;
      }
      if (activeIdx < 0) activeIdx = 0;

      for (let i = 0; i < this.captionPhraseEls.length; i++) {
        const el = this.captionPhraseEls[i];
        let cls = 'caption-phrase';
        if (i < activeIdx) cls += ' past';
        else if (i === activeIdx) cls += ' active';
        else cls += ' future';
        if (el.className !== cls) el.className = cls;
        // アクティブ以外では inline --progress を消して CSS 側のクラス値
        // （past=112%, future=-10%）を効かせる。これが非アクティブ時の
        // 見た目（full ink / 未読）を安定させる。
        if (i !== activeIdx && el.style.getPropertyValue('--progress')) {
          el.style.removeProperty('--progress');
        }
      }

      // アクティブ文節内の進捗
      if (activeIdx >= 0) {
        const el = this.captionPhraseEls[activeIdx];
        const s = this.phraseStarts[activeIdx];
        const d = this.phraseDurs[activeIdx];
        const p = Math.max(0, Math.min(1, (t - s) / d));
        el.style.setProperty('--progress', (p * 100).toFixed(2) + '%');
      }
    }

    toggleCaption() {
      this.captionEnabled = !this.captionEnabled;
      if (this.captionEl) {
        this.captionEl.classList.toggle('hidden', !this.captionEnabled);
      }
      const btn = document.querySelector('.narrator-bar .cc');
      if (btn) btn.classList.toggle('active', this.captionEnabled);
    }

    updateTime() {
      const curBlock = this.idx >= 0 ? this.blocks[this.idx] : null;
      const base = curBlock ? this.cumStart[this.idx] : 0;
      const cur = base + (this.audio.currentTime || 0);
      const tEl = document.querySelector('.narrator-bar .time');
      if (tEl) tEl.textContent = `${fmt(cur)} / ${fmt(this.totalSec)}`;
    }

    updateSeek() {
      if (this.totalSec <= 0) return;
      const curBlock = this.idx >= 0 ? this.blocks[this.idx] : null;
      const base = curBlock ? this.cumStart[this.idx] : 0;
      const cur = base + (this.audio.currentTime || 0);
      const pct = Math.min(1, Math.max(0, cur / this.totalSec));
      const fill = document.querySelector('.narrator-bar .fill');
      const dot = document.querySelector('.narrator-bar .dot');
      if (fill) fill.style.width = (pct * 100).toFixed(2) + '%';
      if (dot) dot.style.left = (pct * 100).toFixed(2) + '%';
    }

    updatePlayButton() {
      const btn = document.querySelector('.narrator-bar .primary');
      if (!btn) return;
      btn.textContent = this.playing ? '⏸' : '▶';
    }

    updateNowLabel() {
      const el = document.querySelector('.narrator-bar .now');
      if (!el) return;
      if (this.idx < 0) { el.textContent = ''; return; }
      const b = this.blocks[this.idx];
      const prefix = b.type === 'piyo' ? '🐤 ' : '';
      el.textContent = prefix + b.text.slice(0, 40) + (b.text.length > 40 ? '…' : '');
    }
  }

  // ===== ヘルパー =====
  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ===== UI 構築 =====
  function buildUI(narr) {
    const fab = document.createElement('button');
    fab.className = 'narrator-fab';
    fab.textContent = '音声ガイドを再生';
    fab.setAttribute('aria-label', '音声ガイドを再生');
    document.body.appendChild(fab);

    const bar = document.createElement('div');
    bar.className = 'narrator-bar hidden';
    bar.innerHTML = `
      <button class="nav-btn" data-act="prevCh" aria-label="前の章" title="前の章">⏮</button>
      <button class="nav-btn" data-act="prev" aria-label="前のブロック" title="前へ (←)">◀</button>
      <button class="primary" data-act="toggle" aria-label="再生/一時停止" title="再生/一時停止 (Space)">▶</button>
      <button class="nav-btn" data-act="next" aria-label="次のブロック" title="次へ (→)">▶</button>
      <button class="nav-btn" data-act="nextCh" aria-label="次の章" title="次の章">⏭</button>
      <div class="seek" role="slider" aria-label="再生位置">
        <div class="fill"></div>
        <div class="dot"></div>
      </div>
      <div class="time">0:00 / 0:00</div>
      <button class="rate" data-act="rate" aria-label="再生速度" title="速度切替">1x</button>
      <button class="nav-btn cc active" data-act="cc" aria-label="字幕の表示切替" title="字幕 (C)">CC</button>
      <button class="nav-btn" data-act="close" aria-label="プレイヤーを閉じる" title="閉じる">×</button>
      <div class="now"></div>
    `;
    document.body.appendChild(bar);

    // エンディング再生用フローティング ボタン（再生バーから独立）
    const endingFab = document.createElement('button');
    endingFab.className = 'ending-fab hidden';
    endingFab.setAttribute('aria-label', 'エンディングを見る');
    endingFab.setAttribute('title', 'エンディングロールを再生');
    endingFab.innerHTML = `<span class="ef-label">Ending</span>`;
    endingFab.addEventListener('click', () => {
      narr.cancelNextTimer();
      narr.audio.pause();
      narr.playing = false;
      narr.updatePlayButton();
      if (narr.captionEl) narr.captionEl.classList.add('hidden');
      narr.enterTheater();
      narr.playEndingCredits(true);
    });
    document.body.appendChild(endingFab);

    // シネマ字幕オーバーレイ
    const caption = document.createElement('div');
    caption.className = 'narrator-caption hidden';
    caption.innerHTML = `
      <div class="caption-aura"></div>
      <div class="caption-avatar">
        <!-- フクロウ（ナレーター） -->
        <svg class="avatar-narrator" viewBox="0 0 64 64" aria-hidden="true">
          <ellipse cx="32" cy="60" rx="17" ry="2" fill="#1A1A1A" opacity="0.15"/>
          <!-- 耳羽 -->
          <path d="M 17 16 Q 13 4 22 10 Q 23 14 19 17 Z" fill="#A36841"/>
          <path d="M 47 16 Q 51 4 42 10 Q 41 14 45 17 Z" fill="#A36841"/>
          <path d="M 18 15 Q 17 8 20 12 Z" fill="#6F4727"/>
          <path d="M 46 15 Q 47 8 44 12 Z" fill="#6F4727"/>
          <!-- 体 -->
          <ellipse cx="32" cy="34" rx="22" ry="23" fill="#C8875A"/>
          <!-- お腹 -->
          <ellipse cx="32" cy="40" rx="15" ry="15" fill="#F0D5B5"/>
          <!-- 翼 -->
          <ellipse class="wing wing-left" cx="11" cy="36" rx="5" ry="10" fill="#A36841" transform="rotate(-8 11 36)"/>
          <ellipse class="wing wing-right" cx="53" cy="36" rx="5" ry="10" fill="#A36841" transform="rotate(8 53 36)"/>
          <!-- 顔盤 -->
          <path d="M 14 25 Q 14 20 18 20 Q 24 18 32 18 Q 40 18 46 20 Q 50 20 50 25 Q 51 35 42 39 Q 32 43 22 39 Q 13 35 14 25 Z" fill="#FFFBF4"/>
          <!-- チーク -->
          <circle cx="13" cy="33" r="2.6" fill="#F98080" opacity="0.55"/>
          <circle cx="51" cy="33" r="2.6" fill="#F98080" opacity="0.55"/>
          <!-- 目の外輪 -->
          <circle cx="23" cy="27" r="6.5" fill="#FFFBF4" stroke="#C8875A" stroke-width="1.5"/>
          <circle cx="41" cy="27" r="6.5" fill="#FFFBF4" stroke="#C8875A" stroke-width="1.5"/>
          <!-- キラキラ目 -->
          <g class="eye eye-left">
            <circle cx="23" cy="27" r="3.5" fill="#1A1A1A"/>
            <circle cx="24.3" cy="25.7" r="1.2" fill="#fff"/>
            <circle cx="21.8" cy="28.8" r="0.55" fill="#fff" opacity="0.75"/>
          </g>
          <g class="eye eye-right">
            <circle cx="41" cy="27" r="3.5" fill="#1A1A1A"/>
            <circle cx="42.3" cy="25.7" r="1.2" fill="#fff"/>
            <circle cx="39.8" cy="28.8" r="0.55" fill="#fff" opacity="0.75"/>
          </g>
          <!-- くちばし（閉じ/開き） -->
          <path class="mouth-smile" d="M 30 35 L 34 35 L 32 39 Z" fill="#E67E22"/>
          <path class="mouth-open" d="M 29 35 L 35 35 L 32 42 Z" fill="#A0500F"/>
          <!-- 脚 -->
          <path d="M 26 56 L 26 60 M 23 60 L 29 60" fill="none" stroke="#BF5F1A" stroke-width="1.8" stroke-linecap="round"/>
          <path d="M 38 56 L 38 60 M 35 60 L 41 60" fill="none" stroke="#BF5F1A" stroke-width="1.8" stroke-linecap="round"/>
        </svg>

        <!-- ヒヨコ（Piyofeed、よりchibi＆ぷるぷる） -->
        <svg class="avatar-piyo" viewBox="0 0 64 64" aria-hidden="true">
          <ellipse cx="32" cy="60" rx="15" ry="2.2" fill="#1A1A1A" opacity="0.15"/>
          <!-- 頭の羽（アンテナ） -->
          <path d="M 30 9 Q 32 2 34 9" fill="none" stroke="#E0B020" stroke-width="2.2" stroke-linecap="round"/>
          <circle cx="32" cy="4" r="1.3" fill="#E0B020"/>
          <!-- 胴体（単一egg shape） -->
          <ellipse cx="32" cy="34" rx="22" ry="24" fill="#F8D448"/>
          <!-- ハイライト -->
          <ellipse cx="23" cy="22" rx="8" ry="6" fill="#FCE88A" opacity="0.85"/>
          <!-- 尾羽 -->
          <path d="M 52 36 Q 60 33 57 40 Q 55 43 52 40 Z" fill="#E0B020"/>
          <!-- 翼 -->
          <ellipse class="wing wing-left" cx="12" cy="38" rx="4.5" ry="8" fill="#EFB828"/>
          <ellipse class="wing wing-right" cx="52" cy="40" rx="3.5" ry="6.5" fill="#EFB828" opacity="0.8"/>
          <!-- 濃いめの大きなチーク -->
          <ellipse cx="14" cy="35" rx="4" ry="2.8" fill="#F98080" opacity="0.8"/>
          <ellipse cx="50" cy="35" rx="4" ry="2.8" fill="#F98080" opacity="0.8"/>
          <!-- 大きなキラキラ瞳 -->
          <g class="eye eye-left">
            <ellipse cx="24" cy="28" rx="3.5" ry="4.6" fill="#1A1A1A"/>
            <circle cx="25.5" cy="26" r="1.6" fill="#fff"/>
            <circle cx="23" cy="30" r="0.7" fill="#fff" opacity="0.75"/>
          </g>
          <g class="eye eye-right">
            <ellipse cx="40" cy="28" rx="3.5" ry="4.6" fill="#1A1A1A"/>
            <circle cx="41.5" cy="26" r="1.6" fill="#fff"/>
            <circle cx="39" cy="30" r="0.7" fill="#fff" opacity="0.75"/>
          </g>
          <!-- 小さな三角くちばし -->
          <g class="beak">
            <path class="beak-top" d="M 29.5 34 L 34.5 34 L 32 37 Z" fill="#E67E22"/>
            <path class="beak-bottom" d="M 29.5 37 L 34.5 37 L 32 40 Z" fill="#BF5F1A"/>
          </g>
          <!-- 脚 -->
          <path d="M 26 57 L 26 60 M 23 60 L 29 60" fill="none" stroke="#D86F10" stroke-width="1.8" stroke-linecap="round"/>
          <path d="M 38 57 L 38 60 M 35 60 L 41 60" fill="none" stroke="#D86F10" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
      </div>
      <div class="caption-content">
        <div class="caption-meta"></div>
        <div class="caption-body"></div>
      </div>
      <button class="caption-close" aria-label="字幕を閉じる" title="字幕を閉じる">×</button>
    `;
    document.body.appendChild(caption);
    narr.captionEl = caption;

    // 字幕の × ボタン：音声も停止してプレイヤーごと閉じる（FAB を再表示）
    caption.querySelector('.caption-close').addEventListener('click', (e) => {
      e.stopPropagation();
      narr.cancelNextTimer();
      narr.audio.pause();
      narr.playing = false;
      caption.classList.add('hidden');
      bar.classList.add('hidden');
      endingFab.classList.add('hidden');
      fab.classList.remove('hidden');
      narr.exitTheater();
      narr.updatePlayButton();
    });

    // 音声の再生/停止を監視してアバターのトークアニメを切替
    narr.audio.addEventListener('play', () => caption.classList.add('is-speaking'));
    narr.audio.addEventListener('pause', () => caption.classList.remove('is-speaking'));
    narr.audio.addEventListener('ended', () => caption.classList.remove('is-speaking'));

    fab.addEventListener('click', () => {
      fab.classList.add('hidden');
      bar.classList.remove('hidden');
      endingFab.classList.remove('hidden');
      if (narr.idx < 0) narr.playBlock(0);
    });

    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const act = btn.getAttribute('data-act');
      switch (act) {
        case 'toggle': narr.toggle(); break;
        case 'prev': narr.prev(); break;
        case 'next': narr.next(); break;
        case 'prevCh': narr.prevChapter(); break;
        case 'nextCh': narr.nextChapter(); break;
        case 'rate': narr.cycleRate(); break;
        case 'cc': narr.toggleCaption(); break;
        case 'close':
          narr.audio.pause();
          narr.playing = false;
          bar.classList.add('hidden');
          endingFab.classList.add('hidden');
          fab.classList.remove('hidden');
          narr.exitTheater();
          narr.updatePlayButton();
          break;
      }
    });

    const seek = bar.querySelector('.seek');
    seek.addEventListener('click', (e) => {
      const rect = seek.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      narr.seekPct(pct);
    });

    // キーボードショートカット
    document.addEventListener('keydown', (e) => {
      if (bar.classList.contains('hidden')) return;
      // IME中・入力中は無視
      if (e.target && ['INPUT','TEXTAREA'].includes(e.target.tagName)) return;
      if (e.key === ' ') { e.preventDefault(); narr.toggle(); }
      else if (e.key === 'ArrowLeft' && !e.shiftKey) { narr.prev(); }
      else if (e.key === 'ArrowRight' && !e.shiftKey) { narr.next(); }
      else if (e.key === 'ArrowLeft' && e.shiftKey) { narr.prevChapter(); }
      else if (e.key === 'ArrowRight' && e.shiftKey) { narr.nextChapter(); }
      else if (e.key === 'c' || e.key === 'C') { narr.toggleCaption(); }
    });
  }

  // ===== 起動 =====
  async function init() {
    const narr = new Narrator();
    try {
      await narr.load();
    } catch (err) {
      console.error('Narrator 初期化失敗:', err);
      return;
    }
    buildUI(narr);
    narr.initLivingBg();
    window.__narrator = narr; // デバッグ用
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
