/**
 * VoiceForge AI — app.js (Orquestador)
 */

import { AudioEngine } from './audio-engine.js';
import { EditStack } from './edit-stack.js';
import { WaveformVisualizer } from './waveform.js';
import { AudioFilters } from './audio-filters.js';
import { WavExporter } from './wav-exporter.js';
import { truncateSilences, normalizeBuffer, computeLevels } from './splice-utils.js';

class VoiceForgeApp {
    constructor() {
        this.engine = new AudioEngine();
        this.editStack = new EditStack();
        this.clipboard = null;
        this.previewBuffer = null;
        this.recordChunks = [];
        this.eqPreset = 'flat';
        this.isBusy = false;
        this.liveUpdateScheduled = false;
        this.recordingBaseBuffer = null;
        this.liveMeterRaf = null;

        this.initDOMElements();
        this.visualizer = new WaveformVisualizer(
            this.canvasWaveform,
            this.canvasRuler,
            this.viewportWaveform,
            (time) => this.seekTo(time),
            (start, end) => this.updateSelectionRange(start, end)
        );
        this.bindEvents();
        this.updateUI();
    }

    initDOMElements() {
        this.canvasWaveform = document.getElementById('waveform-canvas');
        this.canvasRuler = document.getElementById('ruler-canvas');
        this.viewportWaveform = document.getElementById('waveform-viewport');
        this.dropZone = document.getElementById('drop-zone');
        this.fileInput = document.getElementById('file-input');

        this.btnRecord = document.getElementById('btn-record');
        this.btnPlay = document.getElementById('btn-play');
        this.btnPause = document.getElementById('btn-pause');
        this.btnStop = document.getElementById('btn-stop');
        this.btnUndo = document.getElementById('btn-undo');
        this.btnRedo = document.getElementById('btn-redo');
        this.btnCut = document.getElementById('btn-cut');
        this.btnCopy = document.getElementById('btn-copy');
        this.btnPaste = document.getElementById('btn-paste');
        this.btnMute = document.getElementById('btn-mute');
        this.btnExport = document.getElementById('btn-export');
        this.exportFormat = document.getElementById('export-format');

        this.zoomSlider = document.getElementById('zoom-slider');
        this.btnZoomIn = document.getElementById('btn-zoom-in');
        this.btnZoomOut = document.getElementById('btn-zoom-out');

        this.gateToggle = document.getElementById('gate-toggle');
        this.gateParams = document.getElementById('gate-params');
        this.gateThreshold = document.getElementById('gate-threshold');
        this.gateThresholdVal = document.getElementById('gate-threshold-val');
        this.gateRelease = document.getElementById('gate-release');
        this.gateReleaseVal = document.getElementById('gate-release-val');

        this.silenceToggle = document.getElementById('silence-toggle');
        this.silenceParams = document.getElementById('silence-params');
        this.btnNormalize = document.getElementById('btn-normalize');
        this.btnApplyFilters = document.getElementById('btn-apply-filters');

        this.currentTimeDisplay = document.getElementById('current-time');
        this.durationTimeDisplay = document.getElementById('duration-time');
        this.selectionRangeDisplay = document.getElementById('selection-range');
        this.statusText = document.getElementById('status-text');
        this.historyList = document.getElementById('history-list');

        this.meterFill = document.getElementById('meter-fill');
        this.meterPeak = document.getElementById('meter-peak');
        this.peakDbDisplay = document.getElementById('peak-db');
        this.rmsDbDisplay = document.getElementById('rms-db');
    }

    bindEvents() {
        this.btnPlay.addEventListener('click', () => this.play());
        this.btnPause.addEventListener('click', () => this.pause());
        this.btnStop.addEventListener('click', () => this.stop());
        this.btnRecord.addEventListener('click', () => this.toggleRecording());

        this.btnUndo.addEventListener('click', () => this.undo());
        this.btnRedo.addEventListener('click', () => this.redo());
        this.btnCut.addEventListener('click', () => this.cutSelection());
        this.btnCopy.addEventListener('click', () => this.copySelection());
        this.btnPaste.addEventListener('click', () => this.pasteClipboard());
        this.btnMute.addEventListener('click', () => this.muteSelection());
        this.btnExport.addEventListener('click', () => this.exportWav());

        this.zoomSlider.addEventListener('input', (e) => {
            this.visualizer.setZoom(parseFloat(e.target.value));
        });
        this.btnZoomIn.addEventListener('click', () => {
            this.visualizer.zoomBy(1.25);
            this.zoomSlider.value = this.visualizer.zoom;
        });
        this.btnZoomOut.addEventListener('click', () => {
            this.visualizer.zoomBy(0.8);
            this.zoomSlider.value = this.visualizer.zoom;
        });

        window.addEventListener('dragover', (e) => {
            e.preventDefault();
            this.dropZone.classList.add('active');
        });
        this.dropZone.addEventListener('dragleave', () => this.dropZone.classList.remove('active'));
        this.dropZone.addEventListener('drop', (e) => this.handleDrop(e));
        this.fileInput.addEventListener('change', (e) => this.handleFileSelect(e));

        this.gateToggle.addEventListener('change', (e) => {
            this.gateParams.classList.toggle('disabled-overlay', !e.target.checked);
        });
        this.gateThreshold.addEventListener('input', (e) => {
            this.gateThresholdVal.textContent = `${e.target.value} dB`;
        });
        this.gateRelease.addEventListener('input', (e) => {
            this.gateReleaseVal.textContent = `${e.target.value} ms`;
        });
        this.silenceToggle.addEventListener('change', (e) => {
            this.silenceParams.classList.toggle('disabled-overlay', !e.target.checked);
        });

        document.querySelectorAll('.preset-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => this.selectEQPreset(e.currentTarget));
        });

        this.btnNormalize.addEventListener('click', () => this.normalizeAudio());
        this.btnApplyFilters.addEventListener('click', () => this.applyFilters());

        window.addEventListener('keydown', (e) => this.handleKeyDown(e));
    }

    async ensureContext() {
        return this.engine.initContext();
    }

    formatTime(sec) {
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
    }

    setStatus(text) {
        this.statusText.textContent = text;
    }

    async refreshPreview(label) {
        const ctx = await this.ensureContext();
        if (this.editStack.currentEDL.length === 0) {
            this.previewBuffer = null;
            this.visualizer.setBuffer(null);
            this.updateUI();
            return;
        }

        this.setStatus('Procesando vista previa...');
        this.previewBuffer = this.editStack.materialize(ctx);
        this.visualizer.setBuffer(this.previewBuffer);
        this.visualizer.setDuration(this.previewBuffer.duration);
        this.dropZone.classList.toggle('hidden', true);
        this.updateLevels(this.previewBuffer.getChannelData(0));
        this.setStatus(label || 'Listo');
        this.updateUI();
    }

    updateLevels(channelData) {
        const { peakDb, rmsDb, peak } = computeLevels(channelData);
        const peakClamped = Number.isFinite(peakDb) ? peakDb : -60;
        const rmsClamped = Number.isFinite(rmsDb) ? rmsDb : -60;
        const peakPct = Math.max(0, Math.min(100, ((peakClamped + 60) / 60) * 100));
        const rmsPct = Math.max(0, Math.min(100, ((rmsClamped + 60) / 60) * 100));

        this.meterFill.style.width = `${rmsPct}%`;
        this.meterPeak.style.left = `${peakPct}%`;
        this.peakDbDisplay.textContent = Number.isFinite(peakDb) ? peakDb.toFixed(1) : '-inf';
        this.rmsDbDisplay.textContent = Number.isFinite(rmsDb) ? rmsDb.toFixed(1) : '-inf';
    }

    updateUI() {
        const hasAudio = !!this.previewBuffer || this.engine.isRecording;
        const duration = this.engine.isRecording
            ? this.visualizer.duration
            : (hasAudio ? this.previewBuffer.duration : 0);

        this.durationTimeDisplay.textContent = this.formatTime(duration);
        this.btnExport.disabled = !hasAudio;
        this.btnPaste.disabled = !this.clipboard || !hasAudio;
        this.btnUndo.disabled = !this.editStack.canUndo();
        this.btnRedo.disabled = !this.editStack.canRedo();
        this.btnPlay.disabled = this.engine.isRecording;
        this.btnPause.disabled = this.engine.isRecording;

        this.btnRecord.classList.toggle('recording', this.engine.isRecording);

        this.historyList.innerHTML = '';
        const items = this.editStack.historyLog.length
            ? this.editStack.historyLog
            : ['Sin operaciones de edición'];
        items.forEach((item, i) => {
            const el = document.createElement('div');
            el.className = 'history-item' + (i === items.length - 1 ? ' active' : '');
            el.textContent = item;
            this.historyList.appendChild(el);
        });
    }

    updateSelectionRange(start, end) {
        const duration = Math.abs(end - start);
        this.selectionRangeDisplay.textContent =
            `${start.toFixed(3)}s - ${end.toFixed(3)}s (${duration.toFixed(3)}s)`;
        const hasSelection = duration > 0.001;
        const canEdit = hasSelection && (this.previewBuffer || this.engine.isRecording || this.visualizer.duration > 0);
        this.btnCut.disabled = !canEdit;
        this.btnCopy.disabled = !canEdit;
        this.btnMute.disabled = !canEdit;
    }

    async getCombinedBuffer() {
        const ctx = await this.ensureContext();
        const tail = this.engine.consolidateChunks(this.recordChunks);

        if (this.recordingBaseBuffer && tail) {
            const baseData = this.recordingBaseBuffer.getChannelData(0);
            const tailData = tail.getChannelData(0);
            const out = ctx.createBuffer(1, baseData.length + tailData.length, ctx.sampleRate);
            out.getChannelData(0).set(baseData, 0);
            out.getChannelData(0).set(tailData, baseData.length);
            return out;
        }

        if (this.recordingBaseBuffer) return this.recordingBaseBuffer;
        if (tail) return tail;

        if (this.editStack.currentEDL.length === 0) return null;
        return this.editStack.materialize(ctx);
    }

    scheduleLiveWaveformUpdate(samples) {
        this.visualizer.appendLiveChunk(samples);
        const dur = this.visualizer.duration;
        this.durationTimeDisplay.textContent = this.formatTime(dur);
        this.currentTimeDisplay.textContent = this.formatTime(dur);
        this.btnExport.disabled = dur < 0.01;
        this.updateSelectionRange(this.visualizer.selectionStart, this.visualizer.selectionEnd);
    }

    startLiveMeterLoop() {
        const analyser = this.engine.getAnalyser();
        if (!analyser) return;
        const buf = new Float32Array(analyser.fftSize);
        const tick = () => {
            if (!this.engine.isRecording) return;
            analyser.getFloatTimeDomainData(buf);
            this.updateLevels(buf);
            this.liveMeterRaf = requestAnimationFrame(tick);
        };
        this.liveMeterRaf = requestAnimationFrame(tick);
    }

    stopLiveMeterLoop() {
        if (this.liveMeterRaf) cancelAnimationFrame(this.liveMeterRaf);
        this.liveMeterRaf = null;
    }

    async flushRecordingTimeline(label = 'Grabación actualizada') {
        const combined = await this.getCombinedBuffer();
        if (!combined) return false;

        this.editStack.initialize(combined, label);
        this.previewBuffer = combined;

        if (this.engine.isRecording) {
            this.recordingBaseBuffer = combined;
            this.recordChunks = [];
            this.visualizer.setLiveBaseData(combined.getChannelData(0).slice());
        } else {
            this.recordingBaseBuffer = null;
            this.recordChunks = [];
        }
        return true;
    }

    async loadAudioFile(file) {
        try {
            this.setStatus(`Cargando ${file.name}...`);
            await this.ensureContext();
            this.engine.stop();
            const arrayBuf = await file.arrayBuffer();
            const decoded = await this.engine.decodeAudioData(arrayBuf);
            this.editStack.initialize(decoded, `Importar: ${file.name}`);
            await this.refreshPreview('Audio cargado');
            this.dropZone.classList.remove('active');
        } catch (err) {
            console.error(err);
            this.setStatus('Error al cargar audio');
            alert('No se pudo cargar el archivo de audio.');
        }
    }

    handleDrop(e) {
        e.preventDefault();
        this.dropZone.classList.remove('active');
        const file = e.dataTransfer.files[0];
        if (file && file.type.startsWith('audio/')) this.loadAudioFile(file);
    }

    handleFileSelect(e) {
        const file = e.target.files[0];
        if (file) this.loadAudioFile(file);
        e.target.value = '';
    }

    seekTo(time) {
        this.visualizer.setCursorTime(time);
        this.currentTimeDisplay.textContent = this.formatTime(time);
        if (this.engine.isPlaying) {
            this.engine.stop(false);
            this.play(time);
        }
    }

    onTimeUpdate(time) {
        this.visualizer.setCursorTime(time);
        this.currentTimeDisplay.textContent = this.formatTime(time);

        if (this.previewBuffer) {
            const sr = this.previewBuffer.sampleRate;
            const idx = Math.floor(time * sr);
            const win = 2048;
            const start = Math.max(0, idx - win / 2);
            const slice = this.previewBuffer.getChannelData(0).subarray(start, start + win);
            this.updateLevels(slice);
        }
    }

    async play(fromTime = null) {
        if (!this.previewBuffer) return;
        await this.ensureContext();
        this.engine.setEqPreset(this.eqPreset);

        const start = fromTime ?? this.engine.getCurrentTime();
        await this.engine.play(
            this.previewBuffer,
            start,
            (t) => this.onTimeUpdate(t),
            () => {
                this.visualizer.setCursorTime(0);
                this.currentTimeDisplay.textContent = this.formatTime(0);
            }
        );
    }

    pause() {
        this.engine.pause();
    }

    stop() {
        this.engine.stop(true);
        this.visualizer.setCursorTime(0);
        this.currentTimeDisplay.textContent = this.formatTime(0);
    }

    async toggleRecording() {
        if (this.engine.isRecording) {
            await this.stopRecording();
            return;
        }
        await this.startRecording();
    }

    async startRecording() {
        try {
            await this.ensureContext();
            this.engine.stop();
            this.recordChunks = [];
            this.recordingBaseBuffer = null;
            this.previewBuffer = null;
            this.dropZone.classList.add('hidden');
            this.setStatus('● Grabando — onda en vivo');
            this.btnRecord.textContent = '⏹️ Detener';

            this.visualizer.startLiveRecording(48000);
            this.durationTimeDisplay.textContent = '00:00.000';
            this.currentTimeDisplay.textContent = '00:00.000';

            await this.engine.startRecording((samples) => {
                this.recordChunks.push(samples);
                this.scheduleLiveWaveformUpdate(samples);
            });

            this.startLiveMeterLoop();
            this.updateUI();
        } catch (err) {
            console.error(err);
            this.setStatus('Micrófono no disponible');
            alert('No se pudo acceder al micrófono.');
        }
    }

    async stopRecording() {
        this.setStatus('Consolidando grabación...');
        this.stopLiveMeterLoop();
        const fallbackBuffer = await this.engine.stopRecording();
        this.visualizer.stopLiveRecording();
        this.btnRecord.textContent = '🔴 Grabar';

        if (fallbackBuffer && !this.recordChunks.length && !this.recordingBaseBuffer) {
            this.editStack.initialize(fallbackBuffer, 'Grabación de micrófono');
            await this.refreshPreview('Grabación lista');
            this.recordChunks = [];
            this.recordingBaseBuffer = null;
            this.updateUI();
            return;
        }

        await this.flushRecordingTimeline('Grabación de micrófono');
        await this.refreshPreview('Grabación lista');
        this.updateUI();
    }

    getSelectionOrAll() {
        const sel = this.visualizer.getSelection();
        const maxDur = this.engine.isRecording
            ? this.visualizer.duration
            : (this.previewBuffer
                ? this.previewBuffer.duration
                : this.editStack.getDuration());
        if (sel.duration > 0.001) {
            return {
                start: Math.max(0, Math.min(sel.start, maxDur)),
                end: Math.max(0, Math.min(sel.end, maxDur)),
                duration: Math.min(sel.duration, maxDur)
            };
        }
        return { start: 0, end: maxDur, duration: maxDur };
    }

    async cutSelection() {
        const { start, end } = this.getSelectionOrAll();
        if (end <= start) return;
        this.engine.stop();

        if (this.engine.isRecording) {
            await this.flushRecordingTimeline('Editar grabación');
        }

        this.editStack.cut(start, end);

        if (this.engine.isRecording) {
            const ctx = await this.ensureContext();
            const mat = this.editStack.materialize(ctx);
            this.recordingBaseBuffer = mat;
            this.recordChunks = [];
            this.previewBuffer = mat;
            this.visualizer.setLiveBaseData(mat.getChannelData(0).slice());
            this.setStatus('● Grabando — corte aplicado');
        } else {
            await this.refreshPreview('Corte aplicado');
        }
    }

    async copySelection() {
        const ctx = await this.ensureContext();
        const { start, end } = this.getSelectionOrAll();
        if (end <= start) return;

        if (this.engine.isRecording) {
            await this.flushRecordingTimeline('Editar grabación');
        }

        this.clipboard = this.editStack.extractRange(start, end, ctx);
        this.btnPaste.disabled = !this.clipboard;
        this.setStatus('Selección copiada');
    }

    async pasteClipboard() {
        if (!this.clipboard) return;
        const ctx = await this.ensureContext();
        const at = this.visualizer.cursorTime;
        this.engine.stop();
        this.editStack.paste(this.clipboard, at, ctx);
        await this.refreshPreview('Pegado aplicado');
    }

    async muteSelection() {
        const ctx = await this.ensureContext();
        const { start, end } = this.getSelectionOrAll();
        if (end <= start) return;
        this.engine.stop();

        if (this.engine.isRecording) {
            await this.flushRecordingTimeline('Editar grabación');
        }

        this.editStack.mute(start, end, ctx);

        if (this.engine.isRecording) {
            const ctx = await this.ensureContext();
            const mat = this.editStack.materialize(ctx);
            this.recordingBaseBuffer = mat;
            this.recordChunks = [];
            this.previewBuffer = mat;
            this.visualizer.setLiveBaseData(mat.getChannelData(0).slice());
            this.setStatus('● Grabando — silencio aplicado');
        } else {
            await this.refreshPreview('Silencio aplicado');
        }
    }

    async undo() {
        if (!this.editStack.undo()) return;
        this.engine.stop();
        await this.refreshPreview('Deshacer');
    }

    async redo() {
        if (!this.editStack.redo()) return;
        this.engine.stop();
        await this.refreshPreview('Rehacer');
    }

    selectEQPreset(button) {
        document.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('active'));
        button.classList.add('active');
        this.eqPreset = button.dataset.preset;
        this.engine.setEqPreset(this.eqPreset);
        this.setStatus(`Preset EQ: ${this.eqPreset}`);
    }

    async normalizeAudio() {
        if (!this.previewBuffer || this.isBusy) return;
        this.isBusy = true;
        this.setStatus('Normalizando...');
        const ctx = await this.ensureContext();
        const normalized = normalizeBuffer(ctx, this.previewBuffer, -1);
        this.editStack.replaceWithBuffer(ctx, normalized, 'Normalizar (-1 dBFS)');
        await this.refreshPreview('Normalizado');
        this.isBusy = false;
    }

    async applyFilters() {
        if (!this.previewBuffer || this.isBusy) return;
        this.isBusy = true;
        this.btnApplyFilters.disabled = true;
        this.setStatus('Aplicando filtros...');

        try {
            const ctx = await this.ensureContext();
            let buffer = this.editStack.materialize(ctx);

            if (this.eqPreset !== 'flat') {
                buffer = await AudioFilters.processOfflineEQ(buffer, this.eqPreset);
            }

            if (this.gateToggle.checked) {
                const threshold = parseFloat(this.gateThreshold.value);
                const release = parseFloat(this.gateRelease.value);
                buffer = await AudioFilters.applyNoiseGateMain(buffer, threshold, release);
            }

            if (this.silenceToggle.checked) {
                buffer = truncateSilences(ctx, buffer, -45, 0.4, 0.15);
            }

            buffer = normalizeBuffer(ctx, buffer, -1);
            this.editStack.replaceWithBuffer(ctx, buffer, 'Aplicar filtros');
            await this.refreshPreview('Filtros consolidados');
        } catch (err) {
            console.error(err);
            this.setStatus('Error en filtros');
        }

        this.isBusy = false;
        this.btnApplyFilters.disabled = false;
    }

    async exportWav() {
        if (!this.previewBuffer) return;
        this.setStatus('Exportando WAV...');
        const ctx = await this.ensureContext();
        const finalBuffer = this.editStack.materialize(ctx);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const format = this.exportFormat.value;
        const suffix = format.startsWith('stereo') ? 'stereo' : 'mono';
        WavExporter.download(finalBuffer, `voiceforge_${suffix}_${stamp}.wav`, format);
        this.setStatus('Exportación completada');
    }

    handleKeyDown(e) {
        if (e.target.matches('input, textarea')) return;

        if (e.code === 'Space') {
            e.preventDefault();
            if (this.engine.isPlaying) this.pause();
            else this.play();
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            this.cutSelection();
        } else if (e.key.toLowerCase() === 'm' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            this.muteSelection();
        } else if (e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
            e.preventDefault();
            this.undo();
        } else if ((e.key.toLowerCase() === 'y' && (e.ctrlKey || e.metaKey)) ||
            (e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey) && e.shiftKey)) {
            e.preventDefault();
            this.redo();
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.voiceForge = new VoiceForgeApp();
});
