/**
 * VoiceForge — waveform.js
 */

export class WaveformVisualizer {
    constructor(canvasWaveform, canvasRuler, canvasOverview, viewport, onSeek, onSelectRange, onSelectAll) {
        this.canvas = canvasWaveform;
        this.rulerCanvas = canvasRuler;
        this.overviewCanvas = canvasOverview;
        this.viewport = viewport;
        this.onSeek = onSeek;
        this.onSelectRange = onSelectRange;
        this.onSelectAll = onSelectAll;

        this.ctx = this.canvas.getContext('2d');
        this.rulerCtx = this.rulerCanvas.getContext('2d');
        this.overviewCtx = this.overviewCanvas.getContext('2d');

        this.buffer = null;
        this.peaks = null;
        this.overviewPeaks = null;
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
        this.overviewWidth = 0;
        this.overviewHeight = 48;
        this.isLiveRecording = false;
        this.isRecordingPaused = false;
        this.liveHeadTime = 0;
        this.liveWindowSec = 30;

        this.liveSampleRate = 48000;
        this.liveBaseData = null;
        this.liveChunks = [];

        this.overviewDragging = false;
        this.isRecordingPaused = false;

        this._waveformCache = null;
        this._waveformCacheKey = '';
        this._drawRaf = null;
        this._pendingFull = false;

        this.isPointerDown = false;
        this.didDrag = false;
        this.pointerDownX = 0;
        this.pointerDownTime = 0;
        this.dragThresholdPx = 4;

        this._onWindowMove = (e) => this.handleWindowMove(e);
        this._onWindowUp = () => this.handleWindowUp();

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
        this.rulerCanvas.height = Math.floor(40 * this.dpr);
        this.rulerCanvas.style.width = `${rulerRect.width}px`;
        this.rulerCanvas.style.height = '40px';

        const ovRect = this.overviewCanvas.parentElement.getBoundingClientRect();
        this.overviewWidth = ovRect.width;
        this.overviewCanvas.width = Math.floor(ovRect.width * this.dpr);
        this.overviewCanvas.height = Math.floor(this.overviewHeight * this.dpr);
        this.overviewCanvas.style.width = `${ovRect.width}px`;
        this.overviewCanvas.style.height = `${this.overviewHeight}px`;

        this.scheduleDraw(false);
    }

    startLiveRecording(sampleRate = 48000) {
        this.isLiveRecording = true;
        this.isRecordingPaused = false;
        this.liveSampleRate = sampleRate;
        this.liveBaseData = null;
        this.liveChunks = [];
        this.buffer = null;
        this.peaks = null;
        this.overviewPeaks = null;
        this.duration = 0;
        this.liveHeadTime = 0;
        this.cursorTime = 0;
        this.selectionStart = 0;
        this.selectionEnd = 0;
        this.zoom = 1;
        this.scrollRatio = 0;
        this.invalidateCache();
        this.scheduleDraw(false);
    }

    setLiveSampleRate(sampleRate) {
        if (sampleRate > 0) this.liveSampleRate = sampleRate;
        this._syncLiveDuration();
    }

    _syncLiveDuration() {
        const samples = this.getLiveTotalSamples();
        this.duration = samples / this.liveSampleRate;
        this.liveHeadTime = this.duration;
    }

    setLiveBaseData(float32Array, sampleRate) {
        if (sampleRate > 0) this.liveSampleRate = sampleRate;
        this.liveBaseData = float32Array;
        this.liveChunks = [];
        this._syncLiveDuration();
        this.cursorTime = this.duration;
        this.overviewPeaks = this.buildOverviewPeaks(float32Array);
        this.scheduleDraw(false);
    }

    appendLiveChunk(samples, sampleRate) {
        if (!this.isLiveRecording || !samples?.length) return;
        if (sampleRate > 0) this.liveSampleRate = sampleRate;
        this.liveChunks.push(samples);
        this._syncLiveDuration();
        this.cursorTime = this.duration;
        const merged = this.getLiveMergedData();
        if (merged) this.overviewPeaks = this.buildOverviewPeaks(merged);
        this.scheduleDraw(false);
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
        this.isRecordingPaused = false;
        this.scheduleDraw(false);
    }

    setRecordingPaused(paused) {
        this.isRecordingPaused = paused;
        this.scheduleDraw(false);
    }

    setBuffer(audioBuffer, options = {}) {
        const resetView = options.resetView !== false;
        this.isLiveRecording = false;
        this.isRecordingPaused = false;
        this.liveBaseData = null;
        this.liveChunks = [];
        this.buffer = audioBuffer;
        this.duration = audioBuffer ? audioBuffer.duration : 0;
        if (audioBuffer) {
            this.peaks = this.buildPeakPyramid(audioBuffer.getChannelData(0));
            this.overviewPeaks = this.buildOverviewPeaks(audioBuffer.getChannelData(0));
        } else {
            this.peaks = null;
            this.overviewPeaks = null;
        }
        if (resetView) {
            this.selectionStart = 0;
            this.selectionEnd = 0;
            this.cursorTime = 0;
            this.scrollRatio = 0;
        }
        this.liveHeadTime = this.duration;
        this.scheduleDraw(false);
    }

    setDuration(duration) {
        this.duration = duration;
        this.scheduleDraw(false);
    }

    buildOverviewPeaks(data) {
        const buckets = Math.max(200, Math.min(2000, Math.floor(data.length / 512)));
        const step = Math.max(1, Math.floor(data.length / buckets));
        const peaks = [];
        for (let i = 0; i < data.length; i += step) {
            let max = 0;
            let min = 0;
            const end = Math.min(i + step, data.length);
            for (let j = i; j < end; j++) {
                const v = data[j];
                if (v > max) max = v;
                if (v < min) min = v;
            }
            peaks.push({ max, min });
        }
        return peaks;
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
        this.scheduleDraw(false);
    }

    zoomBy(factor) {
        if (this.isLiveRecording) return;
        this.setZoom(this.zoom * factor);
    }

    setScrollRatio(ratio) {
        if (this.isLiveRecording) return;
        this.scrollRatio = Math.max(0, Math.min(1, ratio));
        this.scheduleDraw(false);
    }

    invalidateCache() {
        this._waveformCacheKey = '';
        this._pendingFull = true;
    }

    _waveformCacheKeyFor() {
        const { start, end } = this.getVisibleRange();
        const bufLen = this.buffer?.length ?? this.getLiveTotalSamples();
        return [
            bufLen,
            this.duration,
            this.zoom,
            this.scrollRatio,
            start,
            end,
            this.canvasWidth,
            this.canvasHeight,
            this.isLiveRecording
        ].join('|');
    }

    scheduleDraw(overlayOnly = false) {
        if (!overlayOnly) this._pendingFull = true;
        if (this._drawRaf !== null) return;
        this._drawRaf = requestAnimationFrame(() => {
            this._drawRaf = null;
            const overlay = !this._pendingFull && !!this._waveformCacheKey;
            this._pendingFull = false;
            this.draw(overlay);
        });
    }

    setCursorTime(time, options = {}) {
        this.cursorTime = time;
        const overlayOnly = options.overlayOnly !== false;
        this.scheduleDraw(overlayOnly);
    }

    getSelection() {
        const a = Math.min(this.selectionStart, this.selectionEnd);
        const b = Math.max(this.selectionStart, this.selectionEnd);
        return { start: a, end: b, duration: b - a };
    }

    getVisibleRange() {
        if (!this.duration && !this.isLiveRecording) return { start: 0, end: 0 };

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

    overviewPixelToScrollRatio(x) {
        const { start, end } = this.getVisibleRange();
        const visible = end - start;
        const maxStart = Math.max(0, this.duration - visible);
        if (maxStart <= 0) return 0;
        const center = (x / this.overviewWidth) * this.duration;
        const newStart = Math.max(0, Math.min(maxStart, center - visible / 2));
        return newStart / maxStart;
    }

    timeToPixel(time) {
        const { start, end } = this.getVisibleRange();
        const span = end - start || 1;
        return ((time - start) / span) * this.canvasWidth;
    }

    bindEvents() {
        this.canvas.addEventListener('mousedown', (e) => this.handleMouseDown(e));
        this.canvas.addEventListener('dblclick', (e) => this.handleDoubleClick(e));
        this.canvas.addEventListener('wheel', (e) => this.handleWheel(e), { passive: false });

        this.rulerCanvas.addEventListener('mousedown', (e) => this.handleRulerDown(e));
        this.rulerCanvas.addEventListener('dblclick', (e) => this.handleDoubleClick(e));

        this.overviewCanvas.addEventListener('mousedown', (e) => this.handleOverviewDown(e));
        this.overviewCanvas.addEventListener('dblclick', (e) => this.handleOverviewDoubleClick(e));
    }

    _bindWindowDrag() {
        window.addEventListener('mousemove', this._onWindowMove, { passive: true });
        window.addEventListener('mouseup', this._onWindowUp);
    }

    _unbindWindowDrag() {
        window.removeEventListener('mousemove', this._onWindowMove);
        window.removeEventListener('mouseup', this._onWindowUp);
    }

    handleWindowMove(e) {
        if (this.isPointerDown) this.handlePointerMove(e);
        if (this.overviewDragging) this.handleOverviewMove(e);
    }

    handleWindowUp() {
        if (this.isPointerDown) this.handlePointerUp();
        this.overviewDragging = false;
    }

    _clientXToTime(clientX, element) {
        const rect = element.getBoundingClientRect();
        const x = clientX - rect.left;
        const width = rect.width || this.canvasWidth;
        const { start, end } = this.getVisibleRange();
        const ratio = Math.min(1, Math.max(0, x / width));
        return start + ratio * (end - start);
    }

    handleDoubleClick(e) {
        if (!this.duration) return;
        e.preventDefault();
        this.selectAllAndSeekStart();
    }

    handleOverviewDoubleClick(e) {
        if (!this.duration || this.isLiveRecording) return;
        e.preventDefault();
        this.selectAllAndSeekStart();
    }

    selectAllAndSeekStart() {
        this.selectionStart = 0;
        this.selectionEnd = this.duration;
        this.cursorTime = 0;
        this.scrollRatio = 0;
        if (this.onSeek) this.onSeek(0);
        if (this.onSelectRange) this.onSelectRange(0, this.duration);
        if (this.onSelectAll) this.onSelectAll();
        this.scheduleDraw(false);
    }

    handleRulerDown(e) {
        if (!this.duration) return;
        const t = this._clientXToTime(e.clientX, this.rulerCanvas);
        this.cursorTime = t;
        if (this.onSeek) this.onSeek(t);
        this.scheduleDraw(true);
    }

    handleMouseDown(e) {
        if (!this.duration) return;
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const t = this.pixelToTime(x);
        this.isPointerDown = true;
        this.didDrag = false;
        this.pointerDownX = x;
        this.pointerDownTime = t;
        this.isSelecting = true;
        this.selectionStart = t;
        this.selectionEnd = t;
        this._bindWindowDrag();
        this.scheduleDraw(true);
    }

    handlePointerMove(e) {
        if (!this.isPointerDown || !this.duration) return;
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        if (!this.didDrag && Math.abs(x - this.pointerDownX) > this.dragThresholdPx) {
            this.didDrag = true;
        }
        this.selectionEnd = this.pixelToTime(x);
        if (this.onSelectRange) {
            this.onSelectRange(
                Math.min(this.selectionStart, this.selectionEnd),
                Math.max(this.selectionStart, this.selectionEnd)
            );
        }
        this.scheduleDraw(true);
    }

    handlePointerUp() {
        if (!this.isPointerDown) return;
        this.isPointerDown = false;
        this.isSelecting = false;
        this._unbindWindowDrag();

        if (!this.didDrag) {
            this.cursorTime = this.pointerDownTime;
            if (this.onSeek) this.onSeek(this.pointerDownTime);
        }
        this.scheduleDraw(true);
    }

    handleOverviewDown(e) {
        if (!this.duration || this.isLiveRecording) return;
        this.overviewDragging = true;
        this._bindWindowDrag();
        const rect = this.overviewCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        this.setScrollRatio(this.overviewPixelToScrollRatio(x));
        const t = (x / this.overviewWidth) * this.duration;
        this.cursorTime = t;
        if (this.onSeek) this.onSeek(t);
    }

    handleOverviewMove(e) {
        if (!this.overviewDragging) return;
        const rect = this.overviewCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        this.setScrollRatio(this.overviewPixelToScrollRatio(x));
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

    draw(overlayOnly = false) {
        const w = this.canvasWidth;
        const h = this.canvasHeight;
        this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        this.rulerCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

        const playheadTime = this.isLiveRecording ? this.liveHeadTime : this.cursorTime;
        const playheadColor = this.isLiveRecording ? '#ef4444' : '#10b981';

        if (overlayOnly && this._waveformCacheKey && this._waveformCache) {
            this.ctx.clearRect(0, 0, w, h);
            this.ctx.drawImage(this._waveformCache, 0, 0, w, h);
            this.drawSelection(w, h);
            this.drawPlayhead(w, h, playheadTime, playheadColor, this.isLiveRecording);
            this.rulerCtx.clearRect(0, 0, w, 40);
            this.drawRuler(w, playheadTime, playheadColor);
            return;
        }

        this.ctx.clearRect(0, 0, w, h);
        this.rulerCtx.clearRect(0, 0, w, 40);

        this.drawRuler(w, playheadTime, playheadColor);

        if (this.isLiveRecording) {
            this._drawLiveContent(w, h, playheadTime);
            this.drawOverview();
            return;
        }

        if (!this.buffer || !this.duration) {
            if (this.getLiveTotalSamples() > 0) {
                this._drawLiveContent(w, h, this.liveHeadTime);
                this.drawOverview();
                return;
            }
            this.ctx.fillStyle = '#7a8499';
            this.ctx.font = '14px Inter, sans-serif';
            this.ctx.textAlign = 'center';
            this.ctx.fillText('Importa o graba audio para comenzar', w / 2, h / 2);
            this.drawOverview();
            this._waveformCacheKey = '';
            return;
        }

        this._rebuildWaveformCache(w, h);
        if (this._waveformCache) {
            this.ctx.drawImage(this._waveformCache, 0, 0, w, h);
        }
        this.drawSelection(w, h);
        this.drawPlayhead(w, h, this.cursorTime, '#10b981', false);
        this.drawOverview();
    }

    _drawLiveContent(w, h, playheadTime) {
        this.ctx.fillStyle = 'rgba(239, 68, 68, 0.06)';
        this.ctx.fillRect(0, 0, w, h);
        if (this.isLiveRecording) {
            this.ctx.fillStyle = '#ef4444';
            this.ctx.font = 'bold 11px Inter, sans-serif';
            this.ctx.textAlign = 'left';
            this.ctx.fillText(
                `● GRABANDO — ventana ${this.liveWindowSec}s · Espacio: detener y reproducir · ⏹ detener`,
                10,
                18
            );
        }
        if (this.getLiveTotalSamples() > 0) {
            if (this.duration > 0) this.drawTimeGrid(w, h);
            this.drawLiveWaveform(w, h);
            this.drawSelection(w, h);
            this.drawPlayhead(w, h, playheadTime, this.isLiveRecording ? '#ef4444' : '#06b6d4', this.isLiveRecording);
        } else if (this.isLiveRecording) {
            this.ctx.fillStyle = '#7a8499';
            this.ctx.font = '13px Inter, sans-serif';
            this.ctx.textAlign = 'center';
            this.ctx.fillText('Habla al micrófono — la onda aparecerá aquí en vivo', w / 2, h / 2);
        }
    }

    _rebuildWaveformCache(w, h) {
        const key = this._waveformCacheKeyFor();
        if (key === this._waveformCacheKey && this._waveformCache) return;

        if (!this._waveformCache) {
            this._waveformCache = document.createElement('canvas');
        }
        this._waveformCache.width = Math.floor(w * this.dpr);
        this._waveformCache.height = Math.floor(h * this.dpr);
        const cctx = this._waveformCache.getContext('2d');
        cctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        cctx.clearRect(0, 0, w, h);

        if (this.duration > 0) this.drawTimeGridTo(cctx, w, h);
        this.drawWaveformTo(cctx, w, h);
        this._waveformCacheKey = key;
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

    getRulerTickStep(span) {
        if (span <= 5) return { major: 1, minor: 0.2 };
        if (span <= 15) return { major: 2, minor: 0.5 };
        if (span <= 60) return { major: 5, minor: 1 };
        if (span <= 180) return { major: 15, minor: 5 };
        if (span <= 600) return { major: 30, minor: 10 };
        return { major: 60, minor: 15 };
    }

    drawTimeGrid(w, h) {
        this.drawTimeGridTo(this.ctx, w, h);
    }

    drawTimeGridTo(ctx, w, h) {
        const { start, end } = this.getVisibleRange();
        const span = end - start || 1;
        const { minor } = this.getRulerTickStep(span);
        if (minor <= 0) return;

        const first = Math.ceil(start / minor) * minor;
        ctx.strokeStyle = 'rgba(6, 182, 212, 0.07)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let t = first; t <= end; t += minor) {
            const x = ((t - start) / span) * w;
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
        }
        ctx.stroke();
    }

    drawRuler(w, playheadTime, playheadColor = '#10b981') {
        const { start, end } = this.getVisibleRange();
        const span = end - start || 1;
        const rulerH = 40;
        this.rulerCtx.fillStyle = '#0a0f18';
        this.rulerCtx.fillRect(0, 0, w, rulerH);

        const { major, minor } = this.getRulerTickStep(span);
        const firstMinor = Math.ceil(start / minor) * minor;
        const firstMajor = Math.ceil(start / major) * major;

        const majorTicks = new Path2D();
        const minorTicks = new Path2D();
        for (let t = firstMinor; t <= end; t += minor) {
            const x = ((t - start) / span) * w;
            const isMajor = Math.abs(t / major - Math.round(t / major)) < 0.001;
            const path = isMajor ? majorTicks : minorTicks;
            path.moveTo(x, isMajor ? 22 : 28);
            path.lineTo(x, rulerH);
        }
        this.rulerCtx.lineWidth = 1;
        this.rulerCtx.strokeStyle = 'rgba(6, 182, 212, 0.2)';
        this.rulerCtx.stroke(minorTicks);
        this.rulerCtx.strokeStyle = 'rgba(6, 182, 212, 0.45)';
        this.rulerCtx.stroke(majorTicks);

        this.rulerCtx.fillStyle = '#9aa3b5';
        this.rulerCtx.font = '10px JetBrains Mono, monospace';
        for (let t = firstMajor; t <= end; t += major) {
            const x = ((t - start) / span) * w;
            this.rulerCtx.fillText(this.formatRulerTime(t), x + 3, 14);
        }

        this.rulerCtx.strokeStyle = 'rgba(6, 182, 212, 0.25)';
        this.rulerCtx.beginPath();
        this.rulerCtx.moveTo(0, rulerH - 0.5);
        this.rulerCtx.lineTo(w, rulerH - 0.5);
        this.rulerCtx.stroke();

        if (this.duration > 0) {
            const px = ((playheadTime - start) / span) * w;
            if (px >= 0 && px <= w) {
                this.rulerCtx.strokeStyle = playheadColor;
                this.rulerCtx.lineWidth = 2;
                this.rulerCtx.beginPath();
                this.rulerCtx.moveTo(px, 0);
                this.rulerCtx.lineTo(px, rulerH);
                this.rulerCtx.stroke();

                const label = this.formatPlayheadTime(playheadTime);
                const tw = this.rulerCtx.measureText(label).width + 12;
                const pillX = Math.min(w - tw - 2, Math.max(2, px - tw / 2));
                this.rulerCtx.fillStyle = playheadColor;
                this.rulerCtx.fillRect(pillX, 16, tw, 18);
                this.rulerCtx.fillStyle = '#041510';
                this.rulerCtx.font = 'bold 10px JetBrains Mono, monospace';
                this.rulerCtx.fillText(label, pillX + 6, 29);
            }
        }
    }

    drawOverview() {
        const w = this.overviewWidth;
        const h = this.overviewHeight;
        this.overviewCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        this.overviewCtx.clearRect(0, 0, w, h);
        this.overviewCtx.fillStyle = '#0a0e16';
        this.overviewCtx.fillRect(0, 0, w, h);

        if (!this.duration || !this.overviewPeaks?.length) return;

        const amp = h / 2;
        const peaks = this.overviewPeaks;
        const step = w / peaks.length;

        this.overviewCtx.strokeStyle = 'rgba(6, 182, 212, 0.55)';
        this.overviewCtx.lineWidth = 1;
        this.overviewCtx.beginPath();
        for (let i = 0; i < peaks.length; i++) {
            const x = i * step;
            const { min, max } = peaks[i];
            this.overviewCtx.moveTo(x, amp + min * amp * 0.9);
            this.overviewCtx.lineTo(x, amp + max * amp * 0.9);
        }
        this.overviewCtx.stroke();

        if (!this.isLiveRecording && this.duration > 0) {
            const { start, end } = this.getVisibleRange();
            const x0 = (start / this.duration) * w;
            const x1 = (end / this.duration) * w;
            this.overviewCtx.strokeStyle = '#8b5cf6';
            this.overviewCtx.lineWidth = 2;
            this.overviewCtx.strokeRect(x0, 2, Math.max(4, x1 - x0), h - 4);
            this.overviewCtx.fillStyle = 'rgba(139, 92, 246, 0.12)';
            this.overviewCtx.fillRect(x0, 2, Math.max(4, x1 - x0), h - 4);
        }

        const head = this.isLiveRecording ? this.liveHeadTime : this.cursorTime;
        const headColor = this.isLiveRecording ? '#ef4444' : '#10b981';
        const hx = (head / this.duration) * w;
        this.overviewCtx.strokeStyle = headColor;
        this.overviewCtx.lineWidth = 1;
        this.overviewCtx.beginPath();
        this.overviewCtx.moveTo(hx, 0);
        this.overviewCtx.lineTo(hx, h);
        this.overviewCtx.stroke();
    }

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
        this.drawWaveformTo(this.ctx, w, h);
    }

    drawWaveformTo(ctx, w, h) {
        if (!this.buffer) return;
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
        ctx.strokeStyle = '#06b6d4';
        ctx.lineWidth = 1;
        ctx.beginPath();

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

            ctx.moveTo(x, amp + min * amp * 0.95);
            ctx.lineTo(x, amp + max * amp * 0.95);
        }

        ctx.stroke();
    }

    formatRulerTime(sec) {
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        if (m > 0) {
            return `${m}:${String(Math.floor(s)).padStart(2, '0')}`;
        }
        if (s < 10) return `${s.toFixed(1)}s`;
        return `${Math.floor(s)}s`;
    }

    formatPlayheadTime(sec) {
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${m}:${s.toFixed(3).padStart(6, '0')}`;
    }

    formatTime(sec) {
        return this.formatPlayheadTime(sec);
    }
}
