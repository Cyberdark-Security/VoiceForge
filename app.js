/**
 * VoiceForge — app.js (Orquestador v2)
 */

import { AudioEngine } from './audio-engine.js';
import { EditStack } from './edit-stack.js';
import { WaveformVisualizer } from './waveform.js';
import { AudioFilters } from './audio-filters.js';
import { WavExporter } from './wav-exporter.js';
import { truncateSilences, normalizeBuffer, extractBufferRange, spliceProcessedRange } from './splice-utils.js';

class VoiceForgeApp {
    constructor() {
        this.engine = new AudioEngine();
        this.editStack = new EditStack();
        this.clipboard = null;
        this.previewBuffer = null;
        this.recordChunks = [];
        this.eqPreset = 'flat';
        this.isBusy = false;
        this.recordingBaseBuffer = null;
        this.liveMeterRaf = null;
        this.activeTool = 'select';
        this.isStoppingRecording = false;
        this.isStartingRecording = false;
        this.acceptRecordingChunks = false;

        this.initDOMElements();
        this.visualizer = new WaveformVisualizer(
            this.canvasWaveform,
            this.canvasRuler,
            this.canvasOverview,
            this.viewportWaveform,
            (time) => this.seekTo(time),
            (start, end) => this.updateSelectionRange(start, end),
            () => this.onSelectAll()
        );
        this.bindEvents();
        this.updateUI();
        this.updateFxLabels();
        this.startMeterLoop();
    }

    initDOMElements() {
        this.canvasWaveform = document.getElementById('waveform-canvas');
        this.canvasRuler = document.getElementById('ruler-canvas');
        this.canvasOverview = document.getElementById('overview-canvas');
        this.viewportWaveform = document.getElementById('waveform-viewport');
        this.dropZone = document.getElementById('drop-zone');
        this.fileInput = document.getElementById('file-input');

        this.btnRecord = document.getElementById('btn-record');
        this.btnPlay = document.getElementById('btn-play');
        this.btnStop = document.getElementById('btn-stop');
        this.btnSkipStart = document.getElementById('btn-skip-start');
        this.btnPrev = document.getElementById('btn-prev');

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

        this.masterGain = document.getElementById('master-gain');
        this.masterGainVal = document.getElementById('master-gain-val');
        this.meterLLevel = document.getElementById('meter-l-level');
        this.meterRLevel = document.getElementById('meter-r-level');

        this.fxNoise = document.getElementById('fx-noise');
        this.fxReverb = document.getElementById('fx-reverb');
        this.fxEq = document.getElementById('fx-eq');
        this.fxLimiter = document.getElementById('fx-limiter');
        this.btnApplySelection = document.getElementById('btn-apply-selection');

        this.gateToggle = document.getElementById('gate-toggle');
        this.gateParams = document.getElementById('gate-params');
        this.gateThreshold = document.getElementById('gate-threshold');
        this.gateThresholdVal = document.getElementById('gate-threshold-val');
        this.gateRelease = document.getElementById('gate-release');
        this.gateReleaseVal = document.getElementById('gate-release-val');

        this.silenceToggle = document.getElementById('silence-toggle');
        this.btnNormalize = document.getElementById('btn-normalize');
        this.btnApplyFilters = document.getElementById('btn-apply-filters');

        this.currentTimeDisplay = document.getElementById('current-time');
        this.durationTimeDisplay = document.getElementById('duration-time');
        this.audioSpecs = document.getElementById('audio-specs');
        this.selectionRangeDisplay = document.getElementById('selection-range');
        this.statusText = document.getElementById('status-text');
        this.historyList = document.getElementById('history-list');

        this.settingsDialog = document.getElementById('settings-dialog');
        this.btnSettings = document.getElementById('btn-settings');
        this.btnCloseSettings = document.getElementById('btn-close-settings');
        this.panelEqPresets = document.getElementById('panel-eq-presets');

        this.navBtns = document.querySelectorAll('.nav-btn');
        this.toolBtns = document.querySelectorAll('.tool-btn');
        this.presetChips = document.querySelectorAll('.preset-chip');
    }

    bindEvents() {
        this.btnPlay.addEventListener('click', () => this.requestPlay());
        this.btnStop.addEventListener('click', () => this.requestStop());
        this.btnRecord.addEventListener('click', () => this.toggleRecording());
        this.btnSkipStart.addEventListener('click', () => this.seekTo(0));
        this.btnPrev.addEventListener('click', () => {
            const t = Math.max(0, this.visualizer.cursorTime - 5);
            this.seekTo(t);
        });

        this.btnUndo.addEventListener('click', () => this.undo());
        this.btnRedo.addEventListener('click', () => this.redo());
        this.btnCut.addEventListener('click', () => this.cutSelection());
        this.btnCopy.addEventListener('click', () => this.copySelection());
        this.btnPaste.addEventListener('click', () => this.pasteClipboard());
        this.btnMute.addEventListener('click', () => this.muteSelection());
        this.btnExport.addEventListener('click', () => this.exportWav());

        this.btnZoomIn.addEventListener('click', () => {
            this.visualizer.zoomBy(1.25);
            this.zoomSlider.value = this.visualizer.zoom;
        });
        this.btnZoomOut.addEventListener('click', () => {
            this.visualizer.zoomBy(0.8);
            this.zoomSlider.value = this.visualizer.zoom;
        });
        this.zoomSlider.addEventListener('input', (e) => {
            this.visualizer.setZoom(parseFloat(e.target.value));
        });

        this.masterGain.addEventListener('input', (e) => {
            const db = parseFloat(e.target.value);
            this.engine.setMasterGainDb(db);
            this.masterGainVal.textContent = `${db.toFixed(1)} dB`;
        });

        [this.fxNoise, this.fxReverb, this.fxEq, this.fxLimiter].forEach((btn) => {
            btn.addEventListener('click', () => this.toggleFx(btn));
        });
        this.btnApplySelection?.addEventListener('click', () => this.applyFilters());

        this.navBtns.forEach((btn) => {
            btn.addEventListener('click', () => this.switchView(btn.dataset.view));
        });

        this.toolBtns.forEach((btn) => {
            btn.addEventListener('click', () => this.selectTool(btn.dataset.tool));
        });

        this.presetChips.forEach((chip) => {
            chip.addEventListener('click', () => this.selectEQPreset(chip));
        });

        this.btnSettings.addEventListener('click', () => this.settingsDialog.showModal());
        this.btnCloseSettings.addEventListener('click', () => this.settingsDialog.close());

        window.addEventListener('dragover', (e) => {
            e.preventDefault();
            this.dropZone.classList.add('active');
        });
        window.addEventListener('dragleave', (e) => {
            if (!e.relatedTarget || !document.body.contains(e.relatedTarget)) {
                this.dropZone.classList.remove('active');
            }
        });
        window.addEventListener('drop', (e) => this.handleDrop(e));
        this.fileInput.addEventListener('change', (e) => this.handleFileSelect(e));

        this.gateToggle.addEventListener('change', (e) => {
            this.gateParams.classList.toggle('disabled-overlay', !e.target.checked);
            this.fxNoise.setAttribute('aria-pressed', e.target.checked ? 'true' : 'false');
            this.engine.setEffects({ noiseReduction: e.target.checked });
            this.updateFxLabels();
        });
        this.gateThreshold.addEventListener('input', (e) => {
            this.gateThresholdVal.textContent = `${e.target.value} dB`;
        });
        this.gateRelease.addEventListener('input', (e) => {
            this.gateReleaseVal.textContent = `${e.target.value} ms`;
        });

        this.btnNormalize.addEventListener('click', () => this.normalizeAudio());
        this.btnApplyFilters.addEventListener('click', () => this.applyFilters());

        window.addEventListener('keydown', (e) => this.handleKeyDown(e));
    }

    syncEffectsFromUI() {
        this.engine.setEffects({
            noiseReduction: this.fxNoise.getAttribute('aria-pressed') === 'true',
            reverb: this.fxReverb.getAttribute('aria-pressed') === 'true',
            eq: this.fxEq.getAttribute('aria-pressed') === 'true',
            limiter: this.fxLimiter.getAttribute('aria-pressed') === 'true'
        });
        this.engine.setEqPreset(this.eqPreset);
    }

    updateFxLabels() {
        [this.fxNoise, this.fxReverb, this.fxEq, this.fxLimiter].forEach((btn) => {
            const on = btn.getAttribute('aria-pressed') === 'true';
            const state = btn.closest('.fx-item')?.querySelector('.fx-state');
            if (state) {
                state.textContent = on ? 'ON' : 'OFF';
                state.classList.toggle('on', on);
            }
        });
    }

    isInRecordingSession() {
        return this.engine.isRecording || this.isStartingRecording;
    }

    updatePlayButton() {
        const playing = this.engine.isPlaying;
        const paused = this.engine.isPaused;
        this.btnPlay.classList.toggle('playing', playing);
        this.btnPlay.classList.toggle('rec-pause', paused && !playing);
        this.btnPlay.title = playing
            ? 'Reproducir de nuevo'
            : 'Reproducir (Espacio) · Shift+Espacio pausa';
    }

    /** AudioMass: RequestStop */
    async requestStop() {
        if (this.isStoppingRecording) return;
        if (this.isInRecordingSession() || this.isStartingRecording) {
            await this.stopRecording();
            return;
        }
        this.stopPlayback();
    }

    stopPlayback() {
        this.engine.stop(true);
        this.visualizer.setCursorTime(0);
        this.currentTimeDisplay.textContent = this.formatTime(0);
        this.updatePlayButton();
        this.setStatus('Detenido');
    }

    /** AudioMass: RequestPlay */
    async requestPlay() {
        if (this.isStoppingRecording) return;

        if (this.isInRecordingSession()) {
            await this.stopRecording();
            if (!this.previewBuffer) return;
            this.visualizer.setCursorTime(0);
            this.currentTimeDisplay.textContent = this.formatTime(0);
            await this.play(0);
            return;
        }

        if (this.engine.isPlaying) {
            const at = this.engine.getCurrentTime();
            this.engine.stop(false);
            await this.play(at);
            return;
        }

        await this.play();
    }

    /**
     * AudioMass KeySpace → RequestTransportToggle('stop')
     * Grabando: detener y reproducir · Reproduciendo: stop · Parado: play
     */
    async transportToggleStop() {
        if (this.isStoppingRecording) return;

        if (this.isInRecordingSession()) {
            await this.stopRecording();
            if (this.previewBuffer) {
                this.visualizer.setCursorTime(0);
                this.currentTimeDisplay.textContent = this.formatTime(0);
                await this.play(0);
            }
            return;
        }

        if (this.engine.isPlaying) {
            this.stopPlayback();
            return;
        }

        await this.play();
    }

    /** AudioMass Shift+Space → RequestTransportToggle('pause') */
    async transportTogglePause() {
        if (this.isStoppingRecording || this.isInRecordingSession()) return;

        if (this.engine.isPlaying) {
            this.engine.pause();
            this.updatePlayButton();
            this.setStatus('Pausa');
            return;
        }

        await this.play();
    }

    async toggleFx(btn) {
        const on = btn.getAttribute('aria-pressed') !== 'true';
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');

        const map = {
            'fx-noise': 'noiseReduction',
            'fx-reverb': 'reverb',
            'fx-eq': 'eq',
            'fx-limiter': 'limiter'
        };
        const key = map[btn.id];
        if (key) {
            this.engine.setEffects({ [key]: on });
            if (key === 'eq' && on && this.eqPreset === 'flat') {
                this.eqPreset = 'podcast';
                this.syncPresetChips();
                this.engine.setEqPreset('podcast');
            }
            const name = btn.closest('.fx-item').querySelector('.fx-name').textContent;
            this.setStatus(`${name}: ${on ? 'ON' : 'OFF'}`);
            if (key === 'noiseReduction') this.gateToggle.checked = on;
            this.updateFxLabels();
        }

        if (this.previewBuffer && (this.engine.isPlaying || this.engine.isPaused)) {
            const t = this.engine.getCurrentTime();
            this.engine.stop(false);
            await this.play(t);
        }
    }

    switchView(view) {
        this.navBtns.forEach((b) => b.classList.toggle('active', b.dataset.view === view));

        if (view === 'import') {
            this.fileInput.click();
            return;
        }
        if (view === 'eq') {
            this.panelEqPresets.classList.remove('hidden');
            return;
        }
        if (view === 'spatial') {
            this.setStatus('Audio espacial — próximamente');
            return;
        }
        this.panelEqPresets.classList.toggle('hidden', view !== 'eq');
    }

    selectTool(tool) {
        this.activeTool = tool;
        this.toolBtns.forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    }

    syncPresetChips() {
        this.presetChips.forEach((c) => {
            c.classList.toggle('active', c.dataset.preset === this.eqPreset);
        });
    }

    async ensureContext() {
        return this.engine.initContext();
    }

    formatTime(sec) {
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${m}:${s.toFixed(3).padStart(6, '0')}`;
    }

    setStatus(text) {
        this.statusText.textContent = text;
        this.statusText.classList.remove('status-recording', 'status-busy', 'status-error');
        if (text.includes('Grabando') || text.includes('GRABANDO')) {
            this.statusText.classList.add('status-recording');
        } else if (text.includes('Consolidando') || text.includes('Procesando') || text.includes('Exportando')) {
            this.statusText.classList.add('status-busy');
        } else if (text.includes('Error')) {
            this.statusText.classList.add('status-error');
        }
    }

    startMeterLoop() {
        const bufL = new Float32Array(2048);
        const bufR = new Float32Array(2048);
        const tick = () => {
            const analysers = this.engine.isCaptureActive()
                ? this.engine.getRecordAnalysers()
                : this.engine.getAnalysers();
            if (analysers.left && analysers.right) {
                analysers.left.getFloatTimeDomainData(bufL);
                analysers.right.getFloatTimeDomainData(bufR);
                this.updateStereoMeters(bufL, bufR);
            }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }

    updateStereoMeters(bufL, bufR) {
        const levelFrom = (buf) => {
            let peak = 0;
            for (let i = 0; i < buf.length; i++) {
                const a = Math.abs(buf[i]);
                if (a > peak) peak = a;
            }
            const db = peak > 0 ? 20 * Math.log10(peak) : -60;
            return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
        };
        const l = levelFrom(bufL);
        const r = levelFrom(bufR);
        this.meterLLevel.style.height = `${l}%`;
        this.meterRLevel.style.height = `${r}%`;
    }

    async refreshPreview(label) {
        const ctx = await this.ensureContext();
        if (this.editStack.currentEDL.length === 0) {
            this.previewBuffer = null;
            this.visualizer.setBuffer(null);
            this.dropZone.classList.remove('hidden');
            this.updateUI();
            return;
        }

        this.setStatus('Procesando vista previa...');
        this.previewBuffer = this.editStack.materialize(ctx);
        this.visualizer.setBuffer(this.previewBuffer);
        this.visualizer.setDuration(this.previewBuffer.duration);
        this.dropZone.classList.add('hidden');
        this.updateUI();
        this.setStatus(label || 'Listo');
    }

    updateUI() {
        const hasAudio = !!this.previewBuffer || this.engine.isRecording;
        const duration = this.engine.isRecording
            ? this.getRecordingDurationSec()
            : (hasAudio ? this.previewBuffer.duration : 0);
        const sr = this.engine.getSampleRate();

        this.durationTimeDisplay.textContent = this.formatTime(duration);
        this.audioSpecs.textContent = hasAudio
            ? `${sr} Hz · 32-bit · Mono`
            : `${sr} Hz · 32-bit · Mono`;

        this.btnExport.disabled = !this.previewBuffer;
        this.btnPaste.disabled = !this.clipboard || !this.previewBuffer;
        this.btnUndo.disabled = !this.editStack.canUndo();
        this.btnRedo.disabled = !this.editStack.canRedo();
        this.btnPlay.disabled = this.isStoppingRecording
            || (!this.previewBuffer && !this.isInRecordingSession());
        this.btnRecord.disabled = this.isStoppingRecording || this.isStartingRecording;
        this.btnRecord.classList.toggle('recording',
            this.engine.isRecording && !this.isStoppingRecording);

        this.updatePlayButton();
        this.updateFxLabels();

        this.historyList.innerHTML = '';
        const items = this.editStack.historyLog.length
            ? this.editStack.historyLog
            : ['Sin operaciones'];
        items.forEach((item, i) => {
            const el = document.createElement('div');
            el.className = 'history-item' + (i === items.length - 1 ? ' active' : '');
            el.textContent = item;
            this.historyList.appendChild(el);
        });
    }

    updateSelectionRange(start, end) {
        const duration = Math.abs(end - start);
        const label = duration > 0.001
            ? `${start.toFixed(3)}s – ${end.toFixed(3)}s (${duration.toFixed(3)}s)`
            : 'Sin selección';
        if (this._lastSelectionLabel !== label) {
            this._lastSelectionLabel = label;
            this.selectionRangeDisplay.textContent = label;
        }
        const hasSelection = duration > 0.001;
        const canEdit = hasSelection && (this.previewBuffer || this.engine.isRecording || this.visualizer.duration > 0);
        this.btnCut.disabled = !canEdit;
        this.btnCopy.disabled = !canEdit;
        this.btnMute.disabled = !canEdit;
    }

    onSelectAll() {
        if (!this.previewBuffer && !this.visualizer.duration) return;
        this.updateSelectionRange(0, this.visualizer.duration);
        this.setStatus('Todo seleccionado — reproducción desde el inicio');
    }

    countRecordedSamples() {
        let n = this.recordingBaseBuffer?.length || 0;
        for (const c of this.recordChunks) n += c.length;
        return n;
    }

    /** Duración en vivo = misma fórmula que el buffer final (muestras / Hz del contexto) */
    getRecordingDurationSec() {
        const sr = this.engine.getSampleRate();
        if (!sr) return 0;
        return this.countRecordedSamples() / sr;
    }

    syncRecordingTimeDisplays() {
        const dur = this.getRecordingDurationSec();
        this.visualizer.setLiveSampleRate(this.engine.getSampleRate());
        this.visualizer._syncLiveDuration();
        this.durationTimeDisplay.textContent = this.formatTime(dur);
        this.currentTimeDisplay.textContent = this.formatTime(dur);
    }

    async finalizeRecordingBuffer(liveBackup, fallbackBuffer) {
        const ctx = await this.ensureContext();
        const sr = this.engine.getSampleRate();
        const chunkSamples = this.countRecordedSamples();

        if (fallbackBuffer && chunkSamples === 0) {
            this.editStack.initialize(fallbackBuffer, 'Grabación de micrófono');
            this.previewBuffer = fallbackBuffer;
            this.recordingBaseBuffer = null;
            this.recordChunks = [];
            return true;
        }

        const liveSamples = liveBackup?.length || 0;
        if (liveSamples > chunkSamples + 256 && liveBackup) {
            const buf = ctx.createBuffer(1, liveSamples, sr);
            buf.getChannelData(0).set(liveBackup);
            this.recordingBaseBuffer = null;
            this.recordChunks = [];
            this.editStack.initialize(buf, 'Grabación de micrófono');
            this.previewBuffer = buf;
            return true;
        }

        if (chunkSamples > liveSamples + 256) {
            return false;
        }

        return false;
    }

    async getCombinedBuffer() {
        const ctx = await this.ensureContext();
        const sr = ctx.sampleRate;
        let base = this.recordingBaseBuffer;
        if (base && base.sampleRate !== sr) {
            base = await this.engine.resampleBuffer(base, sr);
            this.recordingBaseBuffer = base;
        }

        const tail = this.engine.consolidateChunks(this.recordChunks);

        if (base && tail) {
            const baseData = base.getChannelData(0);
            const tailData = tail.getChannelData(0);
            const out = ctx.createBuffer(1, baseData.length + tailData.length, sr);
            out.getChannelData(0).set(baseData, 0);
            out.getChannelData(0).set(tailData, baseData.length);
            return out;
        }

        if (base) return base;
        if (tail) return tail;

        if (this.editStack.currentEDL.length === 0) return null;
        return this.editStack.materialize(ctx);
    }

    scheduleLiveWaveformUpdate(samples) {
        if (!this.acceptRecordingChunks || this.isStoppingRecording) return;
        const sr = this.engine.getSampleRate();
        this.visualizer.appendLiveChunk(samples, sr);
        this.syncRecordingTimeDisplays();
        this.updateSelectionRange(this.visualizer.selectionStart, this.visualizer.selectionEnd);
    }

    async flushRecordingTimeline(label = 'Grabación actualizada') {
        const combined = await this.getCombinedBuffer();
        if (!combined) return false;

        this.editStack.initialize(combined, label);
        this.previewBuffer = combined;

        if (this.engine.isRecording) {
            this.recordingBaseBuffer = combined;
            this.recordChunks = [];
            this.visualizer.setLiveBaseData(
                combined.getChannelData(0).slice(),
                combined.sampleRate
            );
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

    async seekTo(time, scrubPlayback = true) {
        this.visualizer.setCursorTime(time, { overlayOnly: true });
        this.currentTimeDisplay.textContent = this.formatTime(time);
        if (scrubPlayback && this.engine.isPlaying) {
            await this.play(time);
        }
    }

    onTimeUpdate(time) {
        this.visualizer.setCursorTime(time);
        this.currentTimeDisplay.textContent = this.formatTime(time);
    }

    async play(fromTime = null) {
        const ctx = await this.ensureContext();

        if (this.editStack.currentEDL.length > 0) {
            this.previewBuffer = this.editStack.materialize(ctx);
            this.visualizer.setBuffer(this.previewBuffer, { resetView: false });
            this.dropZone.classList.add('hidden');
        }

        if (!this.previewBuffer) return;

        this.syncEffectsFromUI();

        const start = fromTime ?? (
            this.engine.isPaused ? this.engine.getCurrentTime() : this.visualizer.cursorTime
        );

        const sel = this.getSelectionRequired();
        const effectRegion = sel && this.hasActiveEffects()
            ? { start: sel.start, end: sel.end }
            : null;

        await this.engine.play(
            this.previewBuffer,
            start,
            (t) => this.onTimeUpdate(t),
            () => {
                const end = this.previewBuffer?.duration ?? 0;
                this.visualizer.setCursorTime(end);
                this.currentTimeDisplay.textContent = this.formatTime(end);
                this.updatePlayButton();
                this.setStatus('Listo');
            },
            effectRegion
        );
        this.updatePlayButton();
        this.setStatus('Reproduciendo');
    }

    stop() {
        this.requestStop();
    }

    async toggleRecording() {
        if (this.isStoppingRecording || this.isStartingRecording) return;
        if (this.isInRecordingSession()) await this.stopRecording();
        else await this.startRecording();
    }

    async startRecording() {
        if (this.isStartingRecording || this.isStoppingRecording) return;
        this.isStartingRecording = true;
        this.acceptRecordingChunks = true;
        this.btnRecord.disabled = true;
        try {
            await this.ensureContext();
            this.engine.stop();
            this.recordChunks = [];
            this.recordingBaseBuffer = null;
            this.previewBuffer = null;
            this.dropZone.classList.add('hidden');
            this.setStatus('● Grabando');

            const sr = this.engine.getSampleRate();
            this.visualizer.startLiveRecording(sr);
            this.durationTimeDisplay.textContent = this.formatTime(0);
            this.currentTimeDisplay.textContent = this.formatTime(0);

            await this.engine.startRecording((samples) => {
                if (!this.acceptRecordingChunks) return;
                this.recordChunks.push(samples);
                this.scheduleLiveWaveformUpdate(samples);
            });

            this.updateUI();
        } catch (err) {
            console.error(err);
            this.acceptRecordingChunks = false;
            this.setStatus('Error: micrófono no disponible');
            alert('No se pudo acceder al micrófono.');
        } finally {
            this.isStartingRecording = false;
            this.updateUI();
        }
    }

    async stopRecording() {
        if (this.isStoppingRecording) return;
        if (!this.isInRecordingSession() && !this.engine.isRecording) return;

        this.isStoppingRecording = true;
        this.btnRecord.disabled = true;
        this.btnRecord.classList.remove('recording');
        this.setStatus('Consolidando grabación...');
        this.updateUI();

        const liveBackup = this.visualizer.getLiveMergedData();

        try {
            const fallbackBuffer = await this.engine.stopRecording();
            this.acceptRecordingChunks = false;

            const finalized = await this.finalizeRecordingBuffer(liveBackup, fallbackBuffer);
            if (!finalized) {
                await this.flushRecordingTimeline('Grabación de micrófono');
            }

            this.visualizer.stopLiveRecording();
            await this.refreshPreview(
                `Grabación lista — ${this.formatTime(this.previewBuffer?.duration ?? 0)}`
            );
            this.visualizer.setCursorTime(0);
            this.currentTimeDisplay.textContent = this.formatTime(0);
        } catch (err) {
            console.error(err);
            this.visualizer.stopLiveRecording();
            this.engine._stopMediaStream?.();
            this.setStatus('Error al detener grabación');
        } finally {
            this.isStoppingRecording = false;
            this.recordChunks = this.recordChunks.length ? this.recordChunks : [];
            this.updateUI();
        }
    }

    hasActiveEffects() {
        const eqOn = this.fxEq.getAttribute('aria-pressed') === 'true' && this.eqPreset !== 'flat';
        return eqOn ||
            this.fxNoise.getAttribute('aria-pressed') === 'true' ||
            this.fxReverb.getAttribute('aria-pressed') === 'true' ||
            this.fxLimiter.getAttribute('aria-pressed') === 'true';
    }

    getSelectionRequired() {
        const sel = this.visualizer.getSelection();
        const maxDur = this.engine.isRecording
            ? this.visualizer.duration
            : (this.previewBuffer
                ? this.previewBuffer.duration
                : this.editStack.getDuration());
        if (sel.duration <= 0.001) return null;
        return {
            start: Math.max(0, Math.min(sel.start, maxDur)),
            end: Math.max(0, Math.min(sel.end, maxDur))
        };
    }

    getEffectOptions() {
        return {
            eqPreset: this.eqPreset,
            eqEnabled: this.fxEq.getAttribute('aria-pressed') === 'true',
            noiseReduction: this.fxNoise.getAttribute('aria-pressed') === 'true' || this.gateToggle.checked,
            reverb: this.fxReverb.getAttribute('aria-pressed') === 'true',
            limiter: this.fxLimiter.getAttribute('aria-pressed') === 'true',
            gateThreshold: parseFloat(this.gateThreshold.value),
            gateRelease: parseFloat(this.gateRelease.value)
        };
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
        if (this.engine.isRecording) await this.flushRecordingTimeline('Editar grabación');

        this.editStack.cut(start, end);

        if (this.engine.isRecording) {
            const ctx = await this.ensureContext();
            const mat = this.editStack.materialize(ctx);
            this.recordingBaseBuffer = mat;
            this.recordChunks = [];
            this.previewBuffer = mat;
            this.visualizer.setLiveBaseData(mat.getChannelData(0).slice(), mat.sampleRate);
            this.syncRecordingTimeDisplays();
            this.setStatus('● Grabando — corte aplicado');
        } else {
            await this.refreshPreview('Corte aplicado');
        }
    }

    async copySelection() {
        const ctx = await this.ensureContext();
        const { start, end } = this.getSelectionOrAll();
        if (end <= start) return;

        if (this.engine.isRecording) await this.flushRecordingTimeline('Editar grabación');

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
        if (this.engine.isRecording) await this.flushRecordingTimeline('Editar grabación');

        this.editStack.mute(start, end, ctx);

        if (this.engine.isRecording) {
            const mat = this.editStack.materialize(ctx);
            this.recordingBaseBuffer = mat;
            this.recordChunks = [];
            this.previewBuffer = mat;
            this.visualizer.setLiveBaseData(mat.getChannelData(0).slice(), mat.sampleRate);
            this.syncRecordingTimeDisplays();
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

    selectEQPreset(chip) {
        this.presetChips.forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        this.eqPreset = chip.dataset.preset;
        this.engine.setEqPreset(this.eqPreset);
        if (this.eqPreset !== 'flat') {
            this.fxEq.setAttribute('aria-pressed', 'true');
            this.engine.setEffects({ eq: true });
        }
        this.updateFxLabels();
        this.setStatus(`Preset EQ: ${this.eqPreset}`);
    }

    async normalizeAudio() {
        if (!this.previewBuffer || this.isBusy) return;
        const sel = this.getSelectionRequired();
        this.isBusy = true;
        this.setStatus(sel ? 'Normalizando selección...' : 'Normalizando...');
        const ctx = await this.ensureContext();
        let buffer = this.editStack.materialize(ctx);

        if (sel) {
            const slice = extractBufferRange(ctx, buffer, sel.start, sel.end);
            const normalized = normalizeBuffer(ctx, slice, -1);
            buffer = spliceProcessedRange(ctx, buffer, sel.start, sel.end, normalized);
            this.editStack.replaceWithBuffer(ctx, buffer, 'Normalizar selección');
        } else {
            buffer = normalizeBuffer(ctx, buffer, -1);
            this.editStack.replaceWithBuffer(ctx, buffer, 'Normalizar (-1 dBFS)');
        }

        await this.refreshPreview(sel ? 'Selección normalizada' : 'Normalizado');
        this.isBusy = false;
    }

    async applyFilters() {
        if (!this.previewBuffer || this.isBusy) return;

        const sel = this.getSelectionRequired();
        if (!sel) {
            this.setStatus('Selecciona un rango en la onda para aplicar el efecto');
            return;
        }

        if (!this.hasActiveEffects() && !this.gateToggle.checked && !this.silenceToggle.checked) {
            this.setStatus('Activa al menos un efecto en PROCESSING');
            return;
        }

        this.isBusy = true;
        this.btnApplyFilters.disabled = true;
        this.btnApplySelection?.setAttribute('disabled', '');
        this.setStatus('Aplicando efectos a la selección...');

        try {
            const ctx = await this.ensureContext();
            const fullBuffer = this.editStack.materialize(ctx);
            const { start, end } = sel;
            const options = this.getEffectOptions();

            let processed = extractBufferRange(ctx, fullBuffer, start, end);
            processed = await AudioFilters.processOfflineEffects(processed, options);

            if (this.silenceToggle.checked) {
                processed = truncateSilences(ctx, processed, -45, 0.4, 0.15);
            }

            processed = normalizeBuffer(ctx, processed, -1);
            const buffer = spliceProcessedRange(ctx, fullBuffer, start, end, processed);

            this.editStack.replaceWithBuffer(ctx, buffer, 'Efectos en selección');
            await this.refreshPreview('Efectos aplicados a la selección');
        } catch (err) {
            console.error(err);
            this.setStatus('Error en filtros');
        }

        this.isBusy = false;
        this.btnApplyFilters.disabled = false;
        this.btnApplySelection?.removeAttribute('disabled');
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
        if (e.target.matches('input, textarea, select, dialog')) return;

        if (e.code === 'Space' && e.shiftKey) {
            e.preventDefault();
            this.transportTogglePause();
            return;
        }

        if (e.code === 'Space') {
            e.preventDefault();
            this.transportToggleStop();
            return;
        }

        if (e.code === 'Escape' && this.isInRecordingSession()) {
            e.preventDefault();
            this.stopRecording();
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
