/**
 * VoiceForge AI — waveform.js
 */

export class WaveformVisualizer {
    constructor(canvasWaveform, canvasRuler, viewport, onSeek, onSelectRange) {
        this.canvas = canvasWaveform;
        this.rulerCanvas = canvasRuler;
        this.viewport = viewport;
        this.onSeek = onSeek;
        this.onSelectRange = onSelectRange;

        this.ctx = this.canvas.getContext('2d');
        this.rulerCtx = this.rulerCanvas.getContext('2d');

        this.buffer = null;
        this.peaks = null;
        this.duration = 0;
        this.zoom = 1;
        this.scrollRatio = 0;
        this.selectionStart = 0;
        this.selectionEnd = 0;
        this.isSelecting = false;
        this.cursorTime = 0;
        this.dpr = 1;
        this.canvasWidth = 0;
        this.canvasHeight = 0;
        this.isLiveRecording = false;
        this.liveHeadTime = 0;
        this.liveWindowSec = 30; // ventana fija visible al grabar (como editores pro)

        // Datos en vivo (sin esperar al final de la grabación)
        this.liveSampleRate = 48000;
        this.liveBaseData = null;
        this.liveChunks = [];

        this.resize();
        window.addEventListener('resize', () => this.resize());
        this.bindEvents();
    }

    resize() {
        this.dpr = window.devicePixelRatio || 1;
        const rect = this.viewport.getBoundingClientRect();
        this.canvasWidth = rect.width;
        this.canvasHeight = rect.height;

        this.canvas.width = Math.floor(rect.width * this.dpr);
        this.canvas.height = Math.floor(rect.height * this.dpr);
        this.canvas.style.width = `${rect.width}px`;
        this.canvas.style.height = `${rect.height}px`;

        const rulerRect = this.rulerCanvas.parentElement.getBoundingClientRect();
        this.rulerCanvas.width = Math.floor(rulerRect.width * this.dpr);
        this.rulerCanvas.height = Math.floor(28 * this.dpr);
        this.rulerCanvas.style.width = `${rulerRect.width}px`;
        this.rulerCanvas.style.height = '28px';

        this.draw();
    }

    startLiveRecording(sampleRate = 48000) {
        this.isLiveRecording = true;
        this.liveSampleRate = sampleRate;
        this.liveBaseData = null;
        this.liveChunks = [];
        this.buffer = null;
        this.peaks = null;
        this.duration = 0;
        this.liveHeadTime = 0;
        this.cursorTime = 0;
        this.selectionStart = 0;
        this.selectionEnd = 0;
        this.zoom = 1;
        this.scrollRatio = 0;
        this.draw();
    }

    setLiveBaseData(float32Array) {
        this.liveBaseData = float32Array;
        this.liveChunks = [];
        this.duration = (this.liveBaseData?.length || 0) / this.liveSampleRate;
        this.liveHeadTime = this.duration;
        this.draw();
    }

    appendLiveChunk(samples) {
        if (!this.isLiveRecording || !samples?.length) return;
        this.liveChunks.push(samples);
        this.duration = this.getLiveTotalSamples() / this.liveSampleRate;
        this.liveHeadTime = this.duration;
        this.cursorTime = this.duration;
        this.draw();
    }

    getLiveTotalSamples() {
        let n = this.liveBaseData?.length || 0;
        for (const c of this.liveChunks) n += c.length;
        return n;
    }

    getLiveMergedData() {
        const total = this.getLiveTotalSamples();
        if (total === 0) return null;
        const merged = new Float32Array(total);
        let off = 0;
        if (this.liveBaseData) {
            merged.set(this.liveBaseData, off);
            off += this.liveBaseData.length;
        }
        for (const c of this.liveChunks) {
            merged.set(c, off);
            off += c.length;
        }
        return merged;
    }

    stopLiveRecording() {
        this.isLiveRecording = false;
    }

    setBuffer(audioBuffer, options = {}) {
        const resetView = options.resetView !== false;
        this.isLiveRecording = false;
        this.liveBaseData = null;
        this.liveChunks = [];
        this.buffer = audioBuffer;
        this.duration = audioBuffer ? audioBuffer.duration : 0;
        this.peaks = audioBuffer ? this.buildPeakPyramid(audioBuffer.getChannelData(0)) : null;
        if (resetView) {
            this.selectionStart = 0;
            this.selectionEnd = 0;
            this.cursorTime = 0;
            this.scrollRatio = 0;
        }
        this.liveHeadTime = this.duration;
        this.draw();
    }

    setDuration(duration) {
        this.duration = duration;
        this.draw();
    }

    buildPeakPyramid(data) {
        const bucketSizes = [64, 256, 1024, 4096];
        return bucketSizes.map((bucketSize) => {
            const peaks = [];
            for (let i = 0; i < data.length; i += bucketSize) {
                let max = 0;
                let min = 0;
                const end = Math.min(i + bucketSize, data.length);
                for (let j = i; j < end; j++) {
                    const v = data[j];
                    if (v > max) max = v;
                    if (v < min) min = v;
                }
                peaks.push({ max, min });
            }
            return { bucketSize, peaks };
        });
    }

    setZoom(value) {
        if (this.isLiveRecording) return;
        this.zoom = Math.max(1, Math.min(100, value));
        this.draw();
    }

    zoomBy(factor) {
        if (this.isLiveRecording) return;
        this.setZoom(this.zoom * factor);
    }

    setScrollRatio(ratio) {
        if (this.isLiveRecording) return;
        this.scrollRatio = Math.max(0, Math.min(1, ratio));
        this.draw();
    }

    setCursorTime(time) {
        this.cursorTime = time;
        this.draw();
    }

    getSelection() {
        const a = Math.min(this.selectionStart, this.selectionEnd);
        const b = Math.max(this.selectionStart, this.selectionEnd);
        return { start: a, end: b, duration: b - a };
    }

    getVisibleRange() {
        if (!this.duration && !this.isLiveRecording) return { start: 0, end: 0 };

        // Grabación: escala de tiempo FIJA (30 s en pantalla), la onda crece a la derecha
        if (this.isLiveRecording) {
            const window = this.liveWindowSec;
            const end = Math.max(window, this.duration);
            const start = Math.max(0, end - window);
            return { start, end };
        }

        if (!this.duration) return { start: 0, end: 0 };
        const visible = this.duration / this.zoom;
        const maxStart = Math.max(0, this.duration - visible);
        const start = maxStart * this.scrollRatio;
        return { start, end: Math.min(this.duration, start + visible) };
    }

    pixelToTime(x) {
        const { start, end } = this.getVisibleRange();
        const ratio = Math.min(1, Math.max(0, x / this.canvasWidth));
        return start + ratio * (end - start);
    }

    timeToPixel(time) {
        const { start, end } = this.getVisibleRange();
        const span = end - start || 1;
        return ((time - start) / span) * this.canvasWidth;
    }

    bindEvents() {
        this.canvas.addEventListener('mousedown', (e) => this.handleMouseDown(e));
        this.canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        window.addEventListener('mouseup', () => this.handleMouseUp());
        this.canvas.addEventListener('wheel', (e) => this.handleWheel(e), { passive: false });
    }

    handleMouseDown(e) {
        if (!this.duration) return;
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const t = this.pixelToTime(x);
        this.isSelecting = true;
        this.selectionStart = t;
        this.selectionEnd = t;
        this.cursorTime = t;
        if (this.onSeek) this.onSeek(t);
        this.draw();
    }

    handleMouseMove(e) {
        if (!this.isSelecting || !this.duration) return;
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        this.selectionEnd = this.pixelToTime(x);
        if (this.onSelectRange) {
            this.onSelectRange(
                Math.min(this.selectionStart, this.selectionEnd),
                Math.max(this.selectionStart, this.selectionEnd)
            );
        }
        this.draw();
    }

    handleMouseUp() {
        this.isSelecting = false;
    }

    handleWheel(e) {
        if (!this.duration || this.isLiveRecording) return;
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
            this.zoomBy(e.deltaY < 0 ? 1.15 : 0.87);
        } else {
            this.setScrollRatio(this.scrollRatio + (e.deltaY > 0 ? 0.05 : -0.05));
        }
    }

    draw() {
        const w = this.canvasWidth;
        const h = this.canvasHeight;
        this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        this.rulerCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        this.ctx.clearRect(0, 0, w, h);
        this.rulerCtx.clearRect(0, 0, w, 28);

        this.drawRuler(w);

        if (this.isLiveRecording) {
            this.ctx.fillStyle = 'rgba(239, 68, 68, 0.06)';
            this.ctx.fillRect(0, 0, w, h);
            this.ctx.fillStyle = '#ef4444';
            this.ctx.font = 'bold 11px Inter, sans-serif';
            this.ctx.textAlign = 'left';
            this.ctx.fillText(`● GRABANDO — ventana ${this.liveWindowSec}s`, 10, 18);

            if (this.getLiveTotalSamples() > 0) {
                this.drawLiveWaveform(w, h);
                this.drawSelection(w, h);
                this.drawPlayhead(w, h, this.liveHeadTime, '#ef4444', true);
            } else {
                this.ctx.fillStyle = '#9aa3b2';
                this.ctx.font = '13px Inter, sans-serif';
                this.ctx.textAlign = 'center';
                this.ctx.fillText('Habla al micrófono — la onda aparecerá aquí en vivo', w / 2, h / 2);
            }
            return;
        }

        if (!this.buffer || !this.duration) {
            this.ctx.fillStyle = '#9aa3b2';
            this.ctx.font = '14px Inter, sans-serif';
            this.ctx.textAlign = 'center';
            this.ctx.fillText('Importa o graba audio para comenzar', w / 2, h / 2);
            return;
        }

        this.drawSelection(w, h);
        this.drawWaveform(w, h);
        this.drawPlayhead(w, h, this.cursorTime, '#10b981', false);
    }

    drawSelection(w, h) {
        const sel = this.getSelection();
        if (sel.duration <= 0.001) return;
        const x0 = this.timeToPixel(sel.start);
        const x1 = this.timeToPixel(sel.end);
        this.ctx.fillStyle = 'rgba(139, 92, 246, 0.25)';
        this.ctx.fillRect(x0, 0, x1 - x0, h);
    }

    drawPlayhead(w, h, time, color, dashed) {
        const x = this.timeToPixel(time);
        this.ctx.strokeStyle = color;
        this.ctx.lineWidth = 2;
        if (dashed) this.ctx.setLineDash([5, 4]);
        this.ctx.beginPath();
        this.ctx.moveTo(x, 0);
        this.ctx.lineTo(x, h);
        this.ctx.stroke();
        this.ctx.setLineDash([]);
    }

    drawRuler(w) {
        const { start, end } = this.getVisibleRange();
        const span = end - start || 1;
        this.rulerCtx.fillStyle = '#1a2030';
        this.rulerCtx.fillRect(0, 0, w, 28);
        this.rulerCtx.strokeStyle = 'rgba(6, 182, 212, 0.35)';
        this.rulerCtx.fillStyle = '#8b95a8';
        this.rulerCtx.font = '10px JetBrains Mono, monospace';

        const tickCount = Math.max(4, Math.floor(w / 80));
        for (let i = 0; i <= tickCount; i++) {
            const t = start + (span * i) / tickCount;
            const x = (i / tickCount) * w;
            this.rulerCtx.beginPath();
            this.rulerCtx.moveTo(x, 18);
            this.rulerCtx.lineTo(x, 28);
            this.rulerCtx.stroke();
            this.rulerCtx.fillText(this.formatTime(t), x + 4, 14);
        }
    }

  /** Dibuja la onda en vivo (escala fija, crece hacia la derecha) */
    drawLiveWaveform(w, h) {
        const total = this.getLiveTotalSamples();
        if (total < 1) return;

        const { start, end } = this.getVisibleRange();
        const sr = this.liveSampleRate;
        const s0vis = Math.floor(start * sr);
        const s1vis = Math.ceil(end * sr);
        const visibleSamples = Math.max(1, s1vis - s0vis);

        const amp = h / 2;
        this.ctx.strokeStyle = '#06b6d4';
        this.ctx.lineWidth = 1.2;
        this.ctx.beginPath();

        for (let x = 0; x < w; x++) {
            const sampleStart = s0vis + Math.floor((x / w) * visibleSamples);
            const sampleEnd = s0vis + Math.floor(((x + 1) / w) * visibleSamples);
            if (sampleEnd <= sampleStart) continue;

            let min = 0;
            let max = 0;
            this.forEachLiveSample(sampleStart, sampleEnd, (v) => {
                if (v > max) max = v;
                if (v < min) min = v;
            });

            this.ctx.moveTo(x, amp + min * amp * 0.92);
            this.ctx.lineTo(x, amp + max * amp * 0.92);
        }

        this.ctx.stroke();

        this.ctx.strokeStyle = 'rgba(139, 92, 246, 0.4)';
        this.ctx.beginPath();
        this.ctx.moveTo(0, amp);
        this.ctx.lineTo(w, amp);
        this.ctx.stroke();
    }

    forEachLiveSample(sampleStart, sampleEnd, fn) {
        const baseLen = this.liveBaseData?.length || 0;
        let abs = 0;

        if (this.liveBaseData) {
            const end = Math.min(sampleEnd, baseLen);
            if (sampleStart < end) {
                const from = Math.max(0, sampleStart);
                for (let i = from; i < end; i++) fn(this.liveBaseData[i]);
            }
        }

        abs = baseLen;
        for (const chunk of this.liveChunks) {
            const chunkEnd = abs + chunk.length;
            if (chunkEnd <= sampleStart) {
                abs = chunkEnd;
                continue;
            }
            if (abs >= sampleEnd) break;
            const from = Math.max(0, sampleStart - abs);
            const to = Math.min(chunk.length, sampleEnd - abs);
            for (let i = from; i < to; i++) fn(chunk[i]);
            abs = chunkEnd;
        }
    }

    drawWaveform(w, h) {
        const data = this.buffer.getChannelData(0);
        const { start, end } = this.getVisibleRange();
        const sr = this.buffer.sampleRate;
        const s0 = Math.floor(start * sr);
        const s1 = Math.ceil(end * sr);
        const visibleSamples = Math.max(1, s1 - s0);
        const samplesPerPixel = visibleSamples / w;

        let level = this.peaks[this.peaks.length - 1];
        for (const p of this.peaks) {
            if (p.bucketSize <= samplesPerPixel * 2) {
                level = p;
                break;
            }
        }

        const amp = h / 2;
        this.ctx.strokeStyle = '#06b6d4';
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();

        for (let x = 0; x < w; x++) {
            const sampleStart = s0 + Math.floor(x * samplesPerPixel);
            const sampleEnd = Math.min(s1, sampleStart + Math.ceil(samplesPerPixel));
            let min = 0;
            let max = 0;

            if (level && samplesPerPixel >= level.bucketSize * 0.5) {
                const i0 = Math.floor(sampleStart / level.bucketSize);
                const i1 = Math.ceil(sampleEnd / level.bucketSize);
                for (let i = i0; i < i1 && i < level.peaks.length; i++) {
                    if (level.peaks[i].max > max) max = level.peaks[i].max;
                    if (level.peaks[i].min < min) min = level.peaks[i].min;
                }
            } else {
                for (let i = sampleStart; i < sampleEnd; i++) {
                    const v = data[i] || 0;
                    if (v > max) max = v;
                    if (v < min) min = v;
                }
            }

            this.ctx.moveTo(x, amp + min * amp * 0.95);
            this.ctx.lineTo(x, amp + max * amp * 0.95);
        }

        this.ctx.stroke();

        this.ctx.strokeStyle = 'rgba(139, 92, 246, 0.5)';
        this.ctx.beginPath();
        this.ctx.moveTo(0, amp);
        this.ctx.lineTo(w, amp);
        this.ctx.stroke();
    }

    formatTime(sec) {
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
    }
}
