'use strict';
/**
 * audio.js —— 纯合成音效（零音频资源文件，不用解码、不占内存）
 *   · 落地/碰撞：短促的皮革闷响，音高随撞击强度变化
 *   · 进球：两音上行 + 一段滤波噪声「刷网」
 * 全部做节流，避免 20 个球同时乱撞时声音糊成一片。
 */
(function () {
  const PB = (window.PB = window.PB || {});

  class Sfx {
    constructor(enabled) {
      this.enabled = !!enabled;
      this.ctx = null;
      this.lastBounce = 0;
      this.master = null;
    }

    ensure() {
      if (this.ctx) return true;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AC({ latencyHint: 'interactive' });
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.55;
        this.master.connect(this.ctx.destination);
      } catch (e) {
        this.ctx = null;
      }
      return !!this.ctx;
    }

    setEnabled(on) {
      this.enabled = !!on;
      if (this.enabled) this.ensure();
    }

    noiseBuffer(sec) {
      const n = Math.max(1, Math.floor(this.ctx.sampleRate * sec));
      const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      return buf;
    }

    bounce(strength) {
      if (!this.enabled || !this.ensure()) return;
      const now = performance.now();
      if (now - this.lastBounce < 48) return;
      this.lastBounce = now;
      const t = this.ctx.currentTime;
      const s = Math.max(0.05, Math.min(1, strength));

      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      const f0 = 150 + s * 130;
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.exponentialRampToValueAtTime(f0 * 0.55, t + 0.09);
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.05 + s * 0.16, t + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
      osc.connect(gain); gain.connect(this.master);
      osc.start(t); osc.stop(t + 0.15);

      // 皮革质感
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer(0.06);
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 900 + s * 1200;
      bp.Q.value = 1.1;
      const ng = this.ctx.createGain();
      ng.gain.setValueAtTime(0.02 + s * 0.07, t);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
      src.connect(bp); bp.connect(ng); ng.connect(this.master);
      src.start(t); src.stop(t + 0.07);
    }

    /**
     * 进球音效。
     * @param {number} combo 连击数（≥1）—— 每级把音高抬 6%，连击越久越"高亢"
     * @param {boolean} swish 空心球 —— 再抬一点、并且刷网更长
     */
    score(combo, swish) {
      if (!this.enabled || !this.ensure()) return;
      const t = this.ctx.currentTime;
      const c = Math.max(0, Math.min(11, (combo || 1) - 1));
      const mul = Math.pow(1.06, c) * (swish ? 1.12 : 1);
      const notes = [880 * mul, 1318.5 * mul];
      for (let i = 0; i < notes.length; i++) {
        const osc = this.ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = notes[i];
        const gain = this.ctx.createGain();
        const st = t + i * 0.075;
        gain.gain.setValueAtTime(0.0001, st);
        gain.gain.exponentialRampToValueAtTime(0.16, st + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, st + 0.42);
        osc.connect(gain); gain.connect(this.master);
        osc.start(st); osc.stop(st + 0.45);
      }
      // 刷网（空心球刷得更久更亮）
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer(swish ? 0.42 : 0.3);
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = swish ? 3200 : 2600;
      const ng = this.ctx.createGain();
      ng.gain.setValueAtTime(0.0001, t);
      ng.gain.exponentialRampToValueAtTime(swish ? 0.12 : 0.09, t + 0.02);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + (swish ? 0.38 : 0.28));
      src.connect(hp); hp.connect(ng); ng.connect(this.master);
      src.start(t); src.stop(t + (swish ? 0.42 : 0.3));
    }

    /** 破纪录号角：四音上行 + 尾音延长，短促但明确 */
    record() {
      if (!this.enabled || !this.ensure()) return;
      const t = this.ctx.currentTime;
      const seq = [523.25, 659.25, 783.99, 1046.5];
      for (let i = 0; i < seq.length; i++) {
        const last = i === seq.length - 1;
        const osc = this.ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.value = seq[i];
        const gain = this.ctx.createGain();
        const st = t + i * 0.10;
        const dur = last ? 0.5 : 0.20;
        gain.gain.setValueAtTime(0.0001, st);
        gain.gain.exponentialRampToValueAtTime(last ? 0.13 : 0.09, st + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, st + dur);
        osc.connect(gain); gain.connect(this.master);
        osc.start(st); osc.stop(st + dur + 0.02);
      }
    }

    /**
     * 成就解锁：明亮的钟声琶音（三角波 + 五度叠音）。
     * 与 record() 的音程刻意错开，听感上能区分"破纪录"和"解锁成就"。
     */
    achievement() {
      if (!this.enabled || !this.ensure()) return;
      const t = this.ctx.currentTime;
      const seq = [783.99, 987.77, 1174.66, 1567.98];
      for (let i = 0; i < seq.length; i++) {
        for (const mul of [1, 1.5]) {
          const osc = this.ctx.createOscillator();
          osc.type = 'triangle';
          osc.frequency.value = seq[i] * mul;
          const gain = this.ctx.createGain();
          const st = t + i * 0.085;
          gain.gain.setValueAtTime(0.0001, st);
          gain.gain.exponentialRampToValueAtTime(mul > 1 ? 0.05 : 0.12, st + 0.012);
          gain.gain.exponentialRampToValueAtTime(0.0001, st + 0.70);
          osc.connect(gain); gain.connect(this.master);
          osc.start(st); osc.stop(st + 0.72);
        }
      }
      // 一层高频闪烁噪声，让"解锁"听起来有点金属光泽
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer(0.5);
      const hp = this.ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 5200;
      const ng = this.ctx.createGain();
      ng.gain.setValueAtTime(0.0001, t);
      ng.gain.exponentialRampToValueAtTime(0.045, t + 0.03);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      src.connect(hp); hp.connect(ng); ng.connect(this.master);
      src.start(t); src.stop(t + 0.5);
    }

    /** 金球入网：一串快速上行的清脆高音（"金币"感） */
    gold() {
      if (!this.enabled || !this.ensure()) return;
      const t = this.ctx.currentTime;
      const base = 1046.5;
      for (let i = 0; i < 5; i++) {
        const osc = this.ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = base * Math.pow(1.2, i);
        const gain = this.ctx.createGain();
        const st = t + i * 0.055;
        gain.gain.setValueAtTime(0.0001, st);
        gain.gain.exponentialRampToValueAtTime(0.13, st + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, st + 0.30);
        osc.connect(gain); gain.connect(this.master);
        osc.start(st); osc.stop(st + 0.32);
      }
    }
  }

  PB.Sfx = Sfx;
})();
