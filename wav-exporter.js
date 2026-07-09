/**
 * VoiceForge — wav-exporter.js
 */

export class WavExporter {
    static toWav32Float(audioBuffer) {
        const sampleRate = audioBuffer.sampleRate;
        const channelData = audioBuffer.getChannelData(0);
        const numSamples = channelData.length;
        const buffer = new ArrayBuffer(44 + numSamples * 4);
        const view = new DataView(buffer);

        this.writeString(view, 0, 'RIFF');
        view.setUint32(4, 36 + numSamples * 4, true);
        this.writeString(view, 8, 'WAVE');
        this.writeString(view, 12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 3, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 4, true);
        view.setUint16(32, 4, true);
        view.setUint16(34, 32, true);
        this.writeString(view, 36, 'data');
        view.setUint32(40, numSamples * 4, true);

        let offset = 44;
        for (let i = 0; i < numSamples; i++) {
            view.setFloat32(offset, channelData[i], true);
            offset += 4;
        }

        return new Blob([buffer], { type: 'audio/wav' });
    }

    static toWav16PCM(audioBuffer) {
        const sampleRate = audioBuffer.sampleRate;
        const channelData = audioBuffer.getChannelData(0);
        const numSamples = channelData.length;
        const buffer = new ArrayBuffer(44 + numSamples * 2);
        const view = new DataView(buffer);

        this.writeString(view, 0, 'RIFF');
        view.setUint32(4, 36 + numSamples * 2, true);
        this.writeString(view, 8, 'WAVE');
        this.writeString(view, 12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        this.writeString(view, 36, 'data');
        view.setUint32(40, numSamples * 2, true);

        let offset = 44;
        for (let i = 0; i < numSamples; i++) {
            const dithered = this.applyDither(channelData[i]);
            const sample16 = Math.max(-32768, Math.min(32767, Math.round(dithered * 32767)));
            view.setInt16(offset, sample16, true);
            offset += 2;
        }

        return new Blob([buffer], { type: 'audio/wav' });
    }

    static toWav16PCMStereoDualMono(audioBuffer) {
        const sampleRate = audioBuffer.sampleRate;
        const mono = audioBuffer.getChannelData(0);
        const numSamples = mono.length;
        const dataBytes = numSamples * 4;
        const buffer = new ArrayBuffer(44 + dataBytes);
        const view = new DataView(buffer);

        this.writeString(view, 0, 'RIFF');
        view.setUint32(4, 36 + dataBytes, true);
        this.writeString(view, 8, 'WAVE');
        this.writeString(view, 12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 2, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 4, true);
        view.setUint16(32, 4, true);
        view.setUint16(34, 16, true);
        this.writeString(view, 36, 'data');
        view.setUint32(40, dataBytes, true);

        let offset = 44;
        for (let i = 0; i < numSamples; i++) {
            const dithered = this.applyDither(mono[i]);
            const sample16 = Math.max(-32768, Math.min(32767, Math.round(dithered * 32767)));
            view.setInt16(offset, sample16, true);
            view.setInt16(offset + 2, sample16, true);
            offset += 4;
        }

        return new Blob([buffer], { type: 'audio/wav' });
    }

    static toWav32FloatStereoDualMono(audioBuffer) {
        const sampleRate = audioBuffer.sampleRate;
        const mono = audioBuffer.getChannelData(0);
        const numSamples = mono.length;
        const dataBytes = numSamples * 8;
        const buffer = new ArrayBuffer(44 + dataBytes);
        const view = new DataView(buffer);

        this.writeString(view, 0, 'RIFF');
        view.setUint32(4, 36 + dataBytes, true);
        this.writeString(view, 8, 'WAVE');
        this.writeString(view, 12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 3, true);
        view.setUint16(22, 2, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 8, true);
        view.setUint16(32, 8, true);
        view.setUint16(34, 32, true);
        this.writeString(view, 36, 'data');
        view.setUint32(40, dataBytes, true);

        let offset = 44;
        for (let i = 0; i < numSamples; i++) {
            view.setFloat32(offset, mono[i], true);
            view.setFloat32(offset + 4, mono[i], true);
            offset += 8;
        }

        return new Blob([buffer], { type: 'audio/wav' });
    }

    static download(audioBuffer, filename = 'voiceforge_export.wav', format = 'stereo-video') {
        let blob;
        switch (format) {
            case 'mono-float32':
                blob = this.toWav32Float(audioBuffer);
                break;
            case 'stereo-float32':
                blob = this.toWav32FloatStereoDualMono(audioBuffer);
                break;
            case 'mono-pcm16':
                blob = this.toWav16PCM(audioBuffer);
                break;
            case 'stereo-video':
            default:
                blob = this.toWav16PCMStereoDualMono(audioBuffer);
                break;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    static writeString(view, offset, string) {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    }

    static applyDither(sample) {
        const r1 = Math.random() - 0.5;
        const r2 = Math.random() - 0.5;
        return sample + (r1 + r2) / 32768;
    }
}
