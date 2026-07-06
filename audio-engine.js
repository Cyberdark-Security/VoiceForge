/**
 * VoiceForge AI — audio-engine.js
 */

import { AudioFilters } from './audio-filters.js';

export class AudioEngine {
    constructor() {
        this.ctx = null;
        this.masterGain = null;
        this.sourceNode = null;
        this.filterTail = null;
        this.analyser = null;
        this.isPlaying = false;
        this.isPaused = false;
        this.playbackStartCtxTime = 0;
        this.playbackOffset = 0;
        this.playbackDuration = 0;
        this.onTimeUpdate = null;
        this.onEnded = null;
        this.rafId = null;
        this.eqPreset = 'flat';

        this.mediaStream = null;
        this.workletNode = null;
        this.mediaRecorder = null;
        this.recordedChunks = [];
        this.recordedBlobs = [];
        this.isRecording = false;
        this.useWorklet = true;

        this.SAMPLE_RATE = 48000;
    }

    async initContext() {
        if (!this.ctx) {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: this.SAMPLE_RATE,
                latencyHint: 'interactive'
            });

            this.masterGain = this.ctx.createGain();
            this.masterGain.gain.value = 0;
            this.analyser = this.ctx.createAnalyser();
            this.analyser.fftSize = 2048;
            this.masterGain.connect(this.analyser);
            this.analyser.connect(this.ctx.destination);
        }

        if (this.ctx.state === 'suspended') await this.ctx.resume();
        return this.ctx;
    }

    setEqPreset(preset) {
        this.eqPreset = preset;
    }

    _fadeIn() {
        const t = this.ctx.currentTime;
        this.masterGain.gain.cancelScheduledValues(t);
        this.masterGain.gain.setValueAtTime(0, t);
        this.masterGain.gain.linearRampToValueAtTime(1, t + 0.012);
    }

    _fadeOutAnd(callback) {
        const t = this.ctx.currentTime;
        this.masterGain.gain.cancelScheduledValues(t);
        this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, t);
        this.masterGain.gain.linearRampToValueAtTime(0, t + 0.012);
        setTimeout(callback, 14);
    }

    _disconnectSource() {
        if (this.sourceNode) {
            try { this.sourceNode.stop(); } catch (_) { /* noop */ }
            try { this.sourceNode.disconnect(); } catch (_) { /* noop */ }
            this.sourceNode = null;
        }
        this.filterTail = null;
    }

    _startTimeLoop() {
        const tick = () => {
            if (!this.isPlaying || !this.ctx) return;
            const elapsed = this.ctx.currentTime - this.playbackStartCtxTime;
            const t = Math.min(this.playbackOffset + elapsed, this.playbackDuration);
            if (this.onTimeUpdate) this.onTimeUpdate(t);
            if (t >= this.playbackDuration - 0.001) {
                this.isPlaying = false;
                this.isPaused = false;
                if (this.onEnded) this.onEnded();
                return;
            }
            this.rafId = requestAnimationFrame(tick);
        };
        this.rafId = requestAnimationFrame(tick);
    }

    _stopTimeLoop() {
        if (this.rafId) cancelAnimationFrame(this.rafId);
        this.rafId = null;
    }

    getCurrentTime() {
        if (!this.isPlaying || !this.ctx) return this.playbackOffset;
        const elapsed = this.ctx.currentTime - this.playbackStartCtxTime;
        return Math.min(this.playbackOffset + elapsed, this.playbackDuration);
    }

    async play(audioBuffer, startTime = 0, onTimeUpdate = null, onEnded = null) {
        await this.initContext();
        this.stop(false);

        if (!audioBuffer) return;

        this.onTimeUpdate = onTimeUpdate;
        this.onEnded = onEnded;
        this.playbackOffset = startTime;
        this.playbackDuration = audioBuffer.duration;
        this.isPaused = false;

        this.sourceNode = this.ctx.createBufferSource();
        this.sourceNode.buffer = audioBuffer;
        this.filterTail = AudioFilters.createLiveFilterChain(this.ctx, this.sourceNode, this.eqPreset);
        this.filterTail.connect(this.masterGain);

        this.sourceNode.onended = () => {
            if (!this.isPlaying) return;
            this.isPlaying = false;
            this._stopTimeLoop();
            if (this.onEnded) this.onEnded();
        };

        this._fadeIn();
        this.playbackStartCtxTime = this.ctx.currentTime;
        this.sourceNode.start(0, startTime);
        this.isPlaying = true;
        this._startTimeLoop();
    }

    pause() {
        if (!this.isPlaying) return;
        this.playbackOffset = this.getCurrentTime();
        this._fadeOutAnd(() => {
            this._disconnectSource();
            this.isPlaying = false;
            this.isPaused = true;
            this._stopTimeLoop();
        });
    }

    stop(resetPosition = true) {
        this._stopTimeLoop();
        if (this.isPlaying) {
            this._fadeOutAnd(() => {
                this._disconnectSource();
                this.isPlaying = false;
                this.isPaused = false;
                if (resetPosition) this.playbackOffset = 0;
            });
        } else {
            this._disconnectSource();
            this.isPlaying = false;
            this.isPaused = false;
            if (resetPosition) this.playbackOffset = 0;
        }
    }

    async resume(audioBuffer, onTimeUpdate, onEnded) {
        if (!this.isPaused) return this.play(audioBuffer, 0, onTimeUpdate, onEnded);
        return this.play(audioBuffer, this.playbackOffset, onTimeUpdate, onEnded);
    }

    getAnalyser() {
        return this.analyser;
    }

    async startRecording(onChunkReceived) {
        await this.initContext();
        this.recordedChunks = [];
        this.recordedBlobs = [];

        this.mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                channelCount: 1,
                sampleRate: this.SAMPLE_RATE
            }
        });

        if (this.useWorklet && this.ctx.audioWorklet) {
            try {
                await this.ctx.audioWorklet.addModule('audio-recorder-processor.js');
                const source = this.ctx.createMediaStreamSource(this.mediaStream);
                this.workletNode = new AudioWorkletNode(this.ctx, 'audio-recorder-processor');
                this.workletNode.port.onmessage = (e) => {
                    if (e.data.type === 'samples' && onChunkReceived) {
                        onChunkReceived(e.data.samples);
                    }
                };
                source.connect(this.workletNode);

                // Medidor en vivo (sin reproducir micrófono en altavoces)
                source.connect(this.analyser);
                const silentOut = this.ctx.createGain();
                silentOut.gain.value = 0;
                this.analyser.connect(silentOut);
                silentOut.connect(this.ctx.destination);

                this.isRecording = true;
                return;
            } catch (err) {
                console.warn('AudioWorklet no disponible, usando MediaRecorder:', err);
            }
        }

        await this.startRecordingFallback();
    }

    async startRecordingFallback() {
        this.mediaRecorder = new MediaRecorder(this.mediaStream, {
            mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                ? 'audio/webm;codecs=opus'
                : 'audio/webm'
        });
        this.mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) this.recordedBlobs.push(e.data);
        };
        this.mediaRecorder.start(250);
        this.isRecording = true;
    }

    async stopRecording() {
        if (!this.isRecording) return null;
        this.isRecording = false;

        if (this.workletNode) {
            this.workletNode.port.postMessage({ type: 'flush' });
            await new Promise((r) => setTimeout(r, 50));
            this.workletNode.disconnect();
            this.workletNode = null;
        }

        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            await new Promise((resolve) => {
                this.mediaRecorder.onstop = resolve;
                this.mediaRecorder.stop();
            });
            const blob = new Blob(this.recordedBlobs, { type: this.mediaRecorder.mimeType });
            const arrayBuf = await blob.arrayBuffer();
            const decoded = await this.decodeAudioData(arrayBuf);
            this._stopMediaStream();
            return decoded;
        }

        this._stopMediaStream();
        return null;
    }

    _stopMediaStream() {
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach((t) => t.stop());
            this.mediaStream = null;
        }
    }

    consolidateChunks(chunks) {
        if (!chunks.length) return null;
        let total = 0;
        for (const c of chunks) total += c.length;
        const merged = new Float32Array(total);
        let off = 0;
        for (const c of chunks) {
            merged.set(c, off);
            off += c.length;
        }
        const buf = this.ctx.createBuffer(1, merged.length, this.SAMPLE_RATE);
        buf.getChannelData(0).set(merged);
        return buf;
    }

    async decodeAudioData(arrayBuffer) {
        await this.initContext();
        const decoded = await this.ctx.decodeAudioData(arrayBuffer.slice(0));

        if (decoded.sampleRate === this.SAMPLE_RATE && decoded.numberOfChannels === 1) {
            return decoded;
        }

        const frames = Math.ceil(decoded.duration * this.SAMPLE_RATE);
        const offline = new OfflineAudioContext(1, frames, this.SAMPLE_RATE);
        const src = offline.createBufferSource();
        src.buffer = decoded;
        src.connect(offline.destination);
        src.start();
        return offline.startRendering();
    }
}
