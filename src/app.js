/**
 * Audio Controller
 * Manages AudioContext, AnalyserNode, zero-allocation buffers, and PCM capture.
 */
class AudioController {
    constructor() {
        this.audioCtx = null;
        this.analyser = null;
        this.source = null;
        this.stream = null;
        this.dataArray = null;
        this.floatFreqArray = null;
        this.timeDomainArray = null;
        this._emptyBytes = new Uint8Array(0);
        this._emptyFloats = new Float32Array(0);
        this.isInitialized = false;
        this._initPromise = null;
    }

    async init() {
        if (this.isInitialized) {
            if (this.audioCtx && this.audioCtx.state === 'suspended') {
                await this.audioCtx.resume();
            }
            return true;
        }
        if (this._initPromise) return this._initPromise;

        this._initPromise = (async () => {
            try {
                const AudioCtx = window.AudioContext || window.webkitAudioContext;
                this.audioCtx = new AudioCtx();
                if (this.audioCtx.state === 'suspended') {
                    await this.audioCtx.resume();
                }

                this.analyser = this.audioCtx.createAnalyser();
                this.analyser.fftSize = 4096;
                this.analyser.smoothingTimeConstant = 0.8;

                let stream;
                try {
                    stream = await navigator.mediaDevices.getUserMedia({
                        audio: {
                            echoCancellation: false,
                            noiseSuppression: false,
                            autoGainControl: false
                        }
                    });
                } catch {
                    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                }

                this.stream = stream;
                this.source = this.audioCtx.createMediaStreamSource(stream);
                this.source.connect(this.analyser);

                this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
                this.floatFreqArray = new Float32Array(this.analyser.frequencyBinCount);
                this.timeDomainArray = new Float32Array(this.analyser.fftSize);
                this.isInitialized = true;
                return true;
            } catch (err) {
                console.warn(`Audio initialization failed: ${err.message}`);
                return false;
            } finally {
                this._initPromise = null;
            }
        })();

        return this._initPromise;
    }

    getSampleRate() {
        return this.audioCtx ? this.audioCtx.sampleRate : 44100;
    }

    getFftSize() {
        return this.analyser ? this.analyser.fftSize : 4096;
    }

    getFrequencyData() {
        if (!this.analyser || !this.dataArray) return this._emptyBytes;
        this.analyser.getByteFrequencyData(this.dataArray);
        return this.dataArray;
    }

    getFloatFrequencyData() {
        if (!this.analyser || !this.floatFreqArray) return this._emptyFloats;
        this.analyser.getFloatFrequencyData(this.floatFreqArray);
        return this.floatFreqArray;
    }

    getTimeDomainData() {
        if (!this.analyser || !this.timeDomainArray) return this._emptyFloats;
        this.analyser.getFloatTimeDomainData(this.timeDomainArray);
        return this.timeDomainArray;
    }

    getAverageVolume(data = this.dataArray) {
        if (!data || data.length === 0) return 0;
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
            sum += data[i];
        }
        return sum / data.length;
    }

    /**
     * Captures live mono PCM from the active microphone stream and resamples
     * to 16 kHz Float32Array directly in the browser (no server ffmpeg needed).
     */
    async capturePCM(durationMs = 7000, targetSampleRate = 16000) {
        if (!this.audioCtx || !this.source) {
            throw new Error('Microphone stream not initialized.');
        }
        if (this.audioCtx.state === 'suspended') {
            await this.audioCtx.resume();
        }

        const sourceRate = this.audioCtx.sampleRate;
        const chunks = [];
        let totalSamples = 0;

        const processor = this.audioCtx.createScriptProcessor(4096, 1, 1);
        const silentGain = this.audioCtx.createGain();
        silentGain.gain.value = 0;

        processor.onaudioprocess = (event) => {
            const input = event.inputBuffer.getChannelData(0);
            const copy = new Float32Array(input.length);
            copy.set(input);
            chunks.push(copy);
            totalSamples += copy.length;
        };

        this.source.connect(processor);
        processor.connect(silentGain);
        silentGain.connect(this.audioCtx.destination);

        try {
            await new Promise((resolve) => setTimeout(resolve, durationMs));
        } finally {
            try {
                this.source.disconnect(processor);
            } catch {
                // Ignore if already disconnected
            }
            processor.disconnect();
            silentGain.disconnect();
            processor.onaudioprocess = null;
        }

        if (totalSamples === 0) {
            throw new Error('No audio captured from microphone.');
        }

        const merged = new Float32Array(totalSamples);
        let offset = 0;
        for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.length;
        }

        if (sourceRate === targetSampleRate) {
            return { samples: merged, sampleRate: targetSampleRate };
        }

        const ratio = sourceRate / targetSampleRate;
        const outLength = Math.floor(merged.length / ratio);
        const resampled = new Float32Array(outLength);

        for (let i = 0; i < outLength; i++) {
            const srcPos = i * ratio;
            const idx = Math.floor(srcPos);
            const frac = srcPos - idx;
            const s0 = merged[idx];
            const s1 = idx + 1 < merged.length ? merged[idx + 1] : s0;
            resampled[i] = s0 + (s1 - s0) * frac;
        }

        return { samples: resampled, sampleRate: targetSampleRate };
    }
}

/**
 * Harmony Analyzer
 * Free browser-based Chromagram + Krumhansl-Schmuckler Key & Chord Detector.
 */
class HarmonyAnalyzer {
    constructor(audioController) {
        this.audio = audioController;
        this.noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

        // Krumhansl-Schmuckler tonal key profiles
        this.majorProfile = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
        this.minorProfile = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

        // Precompute 36 chord templates (Major, Minor, Dominant 7th)
        this.chordTemplates = [];
        for (let root = 0; root < 12; root++) {
            this.chordTemplates.push({
                label: this.noteNames[root],
                vector: this.buildChordVector([root, (root + 4) % 12, (root + 7) % 12], [1, 0.85, 0.9])
            });
            this.chordTemplates.push({
                label: `${this.noteNames[root]}m`,
                vector: this.buildChordVector([root, (root + 3) % 12, (root + 7) % 12], [1, 0.85, 0.9])
            });
            this.chordTemplates.push({
                label: `${this.noteNames[root]}7`,
                vector: this.buildChordVector([root, (root + 4) % 12, (root + 7) % 12, (root + 10) % 12], [1, 0.8, 0.85, 0.7])
            });
        }

        this.chroma = new Float32Array(12);
        this.smoothChroma = new Float32Array(12);
        this.keyHistogram = new Float32Array(12);

        this.binPitchClasses = null;
        this.cachedSampleRate = 0;
        this.cachedFftSize = 0;

        this.liveChord = '--';
        this.liveKey = '--';
        this.sessionChords = [];
        this.sessionKeyHistogram = new Float32Array(12);
    }

    buildChordVector(indices, weights) {
        const vec = new Float32Array(12);
        let norm = 0;
        for (let i = 0; i < indices.length; i++) {
            vec[indices[i]] = weights[i];
            norm += weights[i] * weights[i];
        }
        norm = Math.sqrt(norm) || 1;
        for (let i = 0; i < 12; i++) vec[i] /= norm;
        return vec;
    }

    ensureBinLookup(binCount, sampleRate, fftSize) {
        if (this.binPitchClasses && this.cachedSampleRate === sampleRate && this.cachedFftSize === fftSize) {
            return;
        }
        this.cachedSampleRate = sampleRate;
        this.cachedFftSize = fftSize;
        this.binPitchClasses = new Int8Array(binCount);
        this.binPitchClasses.fill(-1);

        for (let bin = 1; bin < binCount; bin++) {
            const freq = (bin * sampleRate) / fftSize;
            if (freq < 65 || freq > 1400) continue; // C2 to F6 musical fundamentals/harmonics
            const midi = Math.round(12 * Math.log2(freq / 440) + 69);
            this.binPitchClasses[bin] = ((midi % 12) + 12) % 12;
        }
    }

    resetSession() {
        this.sessionChords = [];
        this.sessionKeyHistogram.fill(0);
    }

    update(recordSession = false) {
        if (!this.audio.isInitialized) return;
        const dbData = this.audio.getFloatFrequencyData();
        if (!dbData || dbData.length === 0) return;

        this.ensureBinLookup(dbData.length, this.audio.getSampleRate(), this.audio.getFftSize());
        this.chroma.fill(0);

        let totalEnergy = 0;
        for (let bin = 1; bin < dbData.length; bin++) {
            const pc = this.binPitchClasses[bin];
            if (pc === -1) continue;
            const db = dbData[bin];
            if (db < -72) continue;
            const mag = Math.pow(10, (db + 72) / 25);
            this.chroma[pc] += mag;
            totalEnergy += mag;
        }

        if (totalEnergy < 0.8) {
            // Too quiet — decay smooth chroma slowly and keep existing key
            for (let i = 0; i < 12; i++) this.smoothChroma[i] *= 0.85;
            this.liveChord = '--';
            return;
        }

        let norm = 0;
        for (let i = 0; i < 12; i++) {
            this.smoothChroma[i] = this.smoothChroma[i] * 0.65 + this.chroma[i] * 0.35;
            norm += this.smoothChroma[i] * this.smoothChroma[i];
            this.keyHistogram[i] = this.keyHistogram[i] * 0.985 + (this.chroma[i] / totalEnergy);
            if (recordSession) {
                this.sessionKeyHistogram[i] += this.chroma[i] / totalEnergy;
            }
        }

        norm = Math.sqrt(norm);
        if (norm > 0) {
            let bestChord = '--';
            let bestScore = 0.76;
            for (const tmpl of this.chordTemplates) {
                let dot = 0;
                for (let i = 0; i < 12; i++) {
                    dot += (this.smoothChroma[i] / norm) * tmpl.vector[i];
                }
                if (dot > bestScore) {
                    bestScore = dot;
                    bestChord = tmpl.label;
                }
            }
            this.liveChord = bestChord;
            if (recordSession && bestChord !== '--') {
                const last = this.sessionChords[this.sessionChords.length - 1];
                if (last !== bestChord) {
                    this.sessionChords.push(bestChord);
                }
            }
        }

        this.liveKey = this.estimateKeyFromHistogram(this.keyHistogram);
    }

    estimateKeyFromHistogram(hist) {
        let sum = 0;
        for (let i = 0; i < 12; i++) sum += hist[i];
        if (sum < 0.5) return '--';

        const meanH = sum / 12;
        let bestKey = '--';
        let bestCorr = -Infinity;

        const correlate = (profile, root, mode) => {
            let meanP = 0;
            for (let i = 0; i < 12; i++) meanP += profile[i];
            meanP /= 12;

            let num = 0;
            let denH = 0;
            let denP = 0;
            for (let i = 0; i < 12; i++) {
                const dh = hist[(root + i) % 12] - meanH;
                const dp = profile[i] - meanP;
                num += dh * dp;
                denH += dh * dh;
                denP += dp * dp;
            }
            const corr = denH > 0 && denP > 0 ? num / Math.sqrt(denH * denP) : -1;
            if (corr > bestCorr) {
                bestCorr = corr;
                bestKey = `${this.noteNames[root]} ${mode}`;
            }
        };

        for (let root = 0; root < 12; root++) {
            correlate(this.majorProfile, root, 'Major');
            correlate(this.minorProfile, root, 'Minor');
        }

        return bestCorr > 0.35 ? bestKey : '--';
    }

    getSessionSummary() {
        const key = this.estimateKeyFromHistogram(this.sessionKeyHistogram);
        const uniqueChords = [];
        for (const chord of this.sessionChords) {
            if (!uniqueChords.includes(chord)) {
                uniqueChords.push(chord);
                if (uniqueChords.length >= 4) break;
            }
        }
        return {
            key: key !== '--' ? key : (this.liveKey !== '--' ? this.liveKey : 'Undetermined'),
            chords: uniqueChords.length > 0 ? uniqueChords.join(' - ') : (this.liveChord !== '--' ? this.liveChord : 'Undetermined')
        };
    }
}

/**
 * Visualizer
 * Renders 60fps audio-reactive modes (circular, bars, particles, wave) with precomputed LUTs.
 */
const VIZ_SETTINGS_KEY = 'neon_protostar_viz_settings';

class Visualizer {
    constructor(canvasId, audioController) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d', { alpha: false });
        this.audio = audioController;
        this.isRunning = false;
        this.rafId = null;

        const saved = this.loadSettings();
        this.style = saved.style || 'circular';
        this.palette = saved.palette || 'cyan';
        this.sensitivity = typeof saved.sensitivity === 'number' ? saved.sensitivity : 1.0;

        this.bars = 180;
        this.cosTable = new Float32Array(this.bars);
        this.sinTable = new Float32Array(this.bars);
        const step = (Math.PI * 2) / this.bars;
        for (let i = 0; i < this.bars; i++) {
            const angle = i * step;
            this.cosTable[i] = Math.cos(angle);
            this.sinTable[i] = Math.sin(angle);
        }

        // Precompute 256-entry color LUTs per palette
        this.palettes = {
            cyan: this.buildPaletteLUT((t) => `hsl(${Math.round(180 + t * 60)}, 100%, 50%)`, '0, 243, 255'),
            pulse: this.buildPaletteLUT((t) => `hsl(${Math.round(310 + t * 45)}, 100%, 56%)`, '255, 0, 128'),
            spectrum: this.buildPaletteLUT((t) => `hsl(${Math.round(t * 320)}, 100%, 54%)`, '120, 220, 255'),
            emerald: this.buildPaletteLUT((t) => `hsl(${Math.round(135 + t * 55)}, 95%, 48%)`, '0, 255, 136')
        };

        // Pre-allocate 64 EQ bar peak holders for "bars" mode
        this.eqBarCount = 64;
        this.barPeaks = new Float32Array(this.eqBarCount);

        // Pre-allocate 140 particles for "particles" mode
        this.particleCount = 140;
        this.pAngle = new Float32Array(this.particleCount);
        this.pRadius = new Float32Array(this.particleCount);
        this.pSpeed = new Float32Array(this.particleCount);
        this.pSize = new Float32Array(this.particleCount);
        for (let i = 0; i < this.particleCount; i++) {
            this.pAngle[i] = Math.random() * Math.PI * 2;
            this.pRadius[i] = 20 + Math.random() * 320;
            this.pSpeed[i] = 0.4 + Math.random() * 1.4;
            this.pSize[i] = 1.4 + Math.random() * 2.6;
        }

        this.width = 0;
        this.height = 0;
        this.centerX = 0;
        this.centerY = 0;

        this._onResize = () => this.resize();
        this._onVisibilityChange = () => {
            if (!this.isRunning) return;
            if (document.hidden) {
                if (this.rafId !== null) {
                    cancelAnimationFrame(this.rafId);
                    this.rafId = null;
                }
            } else if (this.rafId === null) {
                this.rafId = requestAnimationFrame(() => this.animate());
            }
        };

        this.resize();
        window.addEventListener('resize', this._onResize);
        document.addEventListener('visibilitychange', this._onVisibilityChange);
    }

    buildPaletteLUT(hueFn, accentRgb) {
        const colors = new Array(256);
        for (let v = 0; v < 256; v++) {
            colors[v] = hueFn(v / 255);
        }
        return { colors, accentRgb };
    }

    loadSettings() {
        try {
            const raw = localStorage.getItem(VIZ_SETTINGS_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch {
            return {};
        }
    }

    saveSettings() {
        try {
            localStorage.setItem(
                VIZ_SETTINGS_KEY,
                JSON.stringify({
                    style: this.style,
                    palette: this.palette,
                    sensitivity: this.sensitivity
                })
            );
        } catch {
            // Ignore storage restrictions
        }
    }

    setStyle(style) {
        if (['circular', 'bars', 'particles', 'wave'].includes(style)) {
            this.style = style;
            this.saveSettings();
        }
    }

    setPalette(palette) {
        if (this.palettes[palette]) {
            this.palette = palette;
            this.saveSettings();
        }
    }

    setSensitivity(value) {
        const num = Number(value);
        if (Number.isFinite(num) && num >= 0.5 && num <= 2.5) {
            this.sensitivity = num;
            this.saveSettings();
        }
    }

    resize() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.width = window.innerWidth;
        this.height = window.innerHeight;
        this.canvas.width = Math.floor(this.width * dpr);
        this.canvas.height = Math.floor(this.height * dpr);
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.centerX = this.width / 2;
        this.centerY = this.height / 2;
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        if (!document.hidden) {
            this.rafId = requestAnimationFrame(() => this.animate());
        }
    }

    stop() {
        this.isRunning = false;
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }

    animate() {
        if (!this.isRunning || document.hidden) {
            this.rafId = null;
            return;
        }

        const ctx = this.ctx;
        ctx.fillStyle = this.style === 'particles' ? 'rgba(5, 5, 5, 0.16)' : 'rgba(5, 5, 5, 0.24)';
        ctx.fillRect(0, 0, this.width, this.height);

        const data = this.audio.getFrequencyData();
        const avgVolume = Math.min(255, this.audio.getAverageVolume(data) * this.sensitivity);
        const paletteObj = this.palettes[this.palette] || this.palettes.cyan;

        if (this.style === 'bars') {
            this.drawBars(ctx, data, avgVolume, paletteObj);
        } else if (this.style === 'particles') {
            this.drawParticles(ctx, data, avgVolume, paletteObj);
        } else if (this.style === 'wave') {
            this.drawWave(ctx, avgVolume, paletteObj);
        } else {
            this.drawCircular(ctx, data, avgVolume, paletteObj);
        }

        this.rafId = requestAnimationFrame(() => this.animate());
    }

    drawCircular(ctx, data, avgVolume, paletteObj) {
        const baseRadius = Math.min(150, Math.min(this.width, this.height) * 0.22);
        const radius = baseRadius + avgVolume * 0.48;
        const innerRadius = radius + 5;

        ctx.beginPath();
        ctx.arc(this.centerX, this.centerY, radius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${paletteObj.accentRgb}, ${Math.min(0.18 + avgVolume / 55, 0.85)})`;
        ctx.lineWidth = 2;
        ctx.stroke();

        const usableBins = Math.floor(data.length * 0.5);
        const dataStep = Math.max(1, Math.floor(usableBins / this.bars));

        ctx.lineWidth = 2;
        for (let i = 0; i < this.bars; i++) {
            const raw = data[i * dataStep] || 0;
            const value = Math.min(255, Math.round(raw * this.sensitivity));
            const barHeight = (value / 255) * 195;
            const cos = this.cosTable[i];
            const sin = this.sinTable[i];

            ctx.strokeStyle = paletteObj.colors[value];
            ctx.beginPath();
            ctx.moveTo(this.centerX + cos * innerRadius, this.centerY + sin * innerRadius);
            ctx.lineTo(this.centerX + cos * (innerRadius + barHeight), this.centerY + sin * (innerRadius + barHeight));
            ctx.stroke();
        }
    }

    drawBars(ctx, data, avgVolume, paletteObj) {
        const count = this.eqBarCount;
        const usableBins = Math.floor(data.length * 0.45);
        const step = Math.max(1, Math.floor(usableBins / count));
        const totalWidth = Math.min(this.width * 0.86, 980);
        const startX = (this.width - totalWidth) * 0.5;
        const slotWidth = totalWidth / count;
        const barWidth = Math.max(3, slotWidth * 0.66);
        const maxBarHeight = this.height * 0.42;
        const baselineY = this.height * 0.68;

        for (let i = 0; i < count; i++) {
            const raw = data[i * step] || 0;
            const scaled = Math.min(255, Math.round(raw * this.sensitivity));
            const h = (scaled / 255) * maxBarHeight;
            const x = startX + i * slotWidth;

            if (h > this.barPeaks[i]) {
                this.barPeaks[i] = h;
            } else {
                this.barPeaks[i] = Math.max(0, this.barPeaks[i] - 2.2);
            }

            ctx.fillStyle = paletteObj.colors[scaled];
            ctx.fillRect(x, baselineY - h, barWidth, Math.max(2, h));

            // Mirrored soft reflection below baseline
            ctx.fillStyle = `rgba(${paletteObj.accentRgb}, ${0.14 + (scaled / 255) * 0.2})`;
            ctx.fillRect(x, baselineY + 4, barWidth, h * 0.28);

            // Peak cap
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(x, baselineY - this.barPeaks[i] - 4, barWidth, 2);
        }

        // Subtle horizon glow line
        ctx.fillStyle = `rgba(${paletteObj.accentRgb}, ${Math.min(0.2 + avgVolume / 180, 0.7)})`;
        ctx.fillRect(startX, baselineY + 1, totalWidth, 1.5);
    }

    drawParticles(ctx, data, avgVolume, paletteObj) {
        const maxRadius = Math.max(this.width, this.height) * 0.65;
        const bassRaw = data.length > 8 ? (data[2] + data[4] + data[6]) / 3 : 0;
        const bassBoost = Math.min(1.8, (bassRaw / 255) * this.sensitivity * 1.4);

        // Pulsing core ring
        const coreRadius = 38 + avgVolume * 0.45;
        ctx.beginPath();
        ctx.arc(this.centerX, this.centerY, coreRadius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${paletteObj.accentRgb}, ${0.25 + bassBoost * 0.35})`;
        ctx.lineWidth = 2;
        ctx.stroke();

        const usableBins = Math.floor(data.length * 0.45);
        for (let i = 0; i < this.particleCount; i++) {
            const bin = Math.min(usableBins - 1, Math.floor((i / this.particleCount) * usableBins));
            const val = Math.min(255, Math.round((data[bin] || 0) * this.sensitivity));

            this.pRadius[i] += this.pSpeed[i] * (0.65 + bassBoost * 2.4 + (val / 255) * 1.6);
            this.pAngle[i] += 0.002 + (val / 255) * 0.006;

            if (this.pRadius[i] > maxRadius) {
                this.pRadius[i] = 18 + Math.random() * 35;
                this.pAngle[i] = Math.random() * Math.PI * 2;
            }

            const x = this.centerX + Math.cos(this.pAngle[i]) * this.pRadius[i];
            const y = this.centerY + Math.sin(this.pAngle[i]) * this.pRadius[i];
            const size = this.pSize[i] + (val / 255) * 3.2;

            ctx.fillStyle = paletteObj.colors[val];
            ctx.beginPath();
            ctx.arc(x, y, size, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    drawWave(ctx, avgVolume, paletteObj) {
        const timeData = this.audio.getTimeDomainData();
        const len = timeData.length;
        const amplitude = Math.min(this.height * 0.34, 180) * this.sensitivity;

        if (!len) {
            ctx.beginPath();
            ctx.moveTo(0, this.centerY);
            ctx.lineTo(this.width, this.centerY);
            ctx.strokeStyle = `rgba(${paletteObj.accentRgb}, 0.4)`;
            ctx.lineWidth = 2;
            ctx.stroke();
            return;
        }

        const sliceCount = 240;
        const step = Math.max(1, Math.floor(len / sliceCount));
        const dx = this.width / (sliceCount - 1);

        // Outer glow wave
        ctx.beginPath();
        for (let i = 0; i < sliceCount; i++) {
            const sample = timeData[i * step] || 0;
            const x = i * dx;
            const y = this.centerY + sample * amplitude;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = `rgba(${paletteObj.accentRgb}, ${Math.min(0.3 + avgVolume / 120, 0.65)})`;
        ctx.lineWidth = 6;
        ctx.stroke();

        // Crisp neon core wave
        ctx.beginPath();
        for (let i = 0; i < sliceCount; i++) {
            const sample = timeData[i * step] || 0;
            const x = i * dx;
            const y = this.centerY + sample * amplitude;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        const colorIdx = Math.min(255, Math.round(100 + avgVolume));
        ctx.strokeStyle = paletteObj.colors[colorIdx];
        ctx.lineWidth = 2.2;
        ctx.stroke();
    }
}

/**
 * Recognition Service (Open-source shazamio-core backend route — zero API keys)
 */
class RecognitionService {
    constructor(audioController, harmonyAnalyzer) {
        this.audio = audioController;
        this.harmony = harmonyAnalyzer;
    }

    async identify(onStatusUpdate) {
        if (!this.audio.stream) {
            return { error: true, message: "Microphone stream not available." };
        }

        this.harmony.resetSession();
        if (onStatusUpdate) onStatusUpdate("LISTENING (7s)...");

        let captured;
        try {
            captured = await this.audio.capturePCM(7000, 16000);
        } catch (err) {
            return { error: true, message: `Recording failed: ${err.message}` };
        }

        const harmonySummary = this.harmony.getSessionSummary();
        if (onStatusUpdate) onStatusUpdate("FINGERPRINTING...");

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000);

        try {
            const response = await fetch(`/api/identify?sampleRate=${captured.sampleRate}`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/octet-stream",
                    "x-sample-rate": String(captured.sampleRate)
                },
                body: captured.samples.buffer,
                signal: controller.signal
            });

            const payload = await response.json();
            if (!response.ok) {
                return { error: true, message: payload.error || "Recognition service error." };
            }

            if (!payload.matched || !payload.song) {
                return {
                    error: true,
                    message: payload.message || "No matching song detected.",
                    key: harmonySummary.key,
                    chords: harmonySummary.chords
                };
            }

            return {
                ...payload.song,
                key: harmonySummary.key,
                chords: harmonySummary.chords
            };
        } catch (err) {
            console.warn("Identification request failed:", err.message);
            return { error: true, message: "Network error or timeout during recognition." };
        } finally {
            clearTimeout(timeoutId);
        }
    }
}

/**
 * Tuner
 * High-precision YIN pitch detector with median filtering and Intended Chord targeting.
 */
const TUNER_CHORD_KEY = 'neon_protostar_tuner_chord';

const CHORD_QUALITIES = {
    maj: { suffix: '', label: 'Major', intervals: [0, 4, 7] },
    m: { suffix: 'm', label: 'Minor', intervals: [0, 3, 7] },
    7: { suffix: '7', label: 'Dom 7', intervals: [0, 4, 7, 10] },
    maj7: { suffix: 'maj7', label: 'Maj 7', intervals: [0, 4, 7, 11] },
    m7: { suffix: 'm7', label: 'Min 7', intervals: [0, 3, 7, 10] },
    sus4: { suffix: 'sus4', label: 'Sus 4', intervals: [0, 5, 7] },
    5: { suffix: '5', label: 'Power 5', intervals: [0, 7] }
};

const INSTRUMENT_TUNINGS = {
    guitar: {
        label: 'Guitar',
        short: 'E A D G B E',
        strings: [
            { name: 'E2', midi: 40 },
            { name: 'A2', midi: 45 },
            { name: 'D3', midi: 50 },
            { name: 'G3', midi: 55 },
            { name: 'B3', midi: 59 },
            { name: 'E4', midi: 64 }
        ]
    },
    ukulele: {
        label: 'Ukulele',
        short: 'G C E A',
        strings: [
            { name: 'G4', midi: 67 },
            { name: 'C4', midi: 60 },
            { name: 'E4', midi: 64 },
            { name: 'A4', midi: 69 }
        ]
    }
};

class Tuner {
    constructor(audioController) {
        this.audio = audioController;
        this.isTunerActive = false;
        this.animationId = null;
        this.smoothedFrequency = 0;
        this.freqHistory = [];
        this.lastDetectionTime = 0;
        this.steadyInTuneFrames = 0;
        this.lastSteadyKey = null;

        this.noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

        // Pre-allocated DSP buffers for zero-GC 60fps YIN pitch detection
        this.centeredBuffer = new Float32Array(4096);
        this.yinBuffer = new Float32Array(2048);

        this.instrument = 'guitar'; // 'chromatic' | 'guitar' | 'ukulele'
        this.intendedRoot = 'chromatic';
        this.intendedQuality = 'maj';
        this.lockedPitchClass = null;
        this.lockedMidi = null;
        this.tunedKeys = new Set();
        this.isChordMatched = false;

        this.chordVoicingCache = new Map();
        this.currentVoicings = [];
        this.voicingIndex = 0;

        this.tunerInterface = document.getElementById('tuner-interface');
        this.tunerStatus = document.getElementById('tuner-status');
        this.noteDisplay = document.getElementById('note-display');
        this.frequencyDisplay = document.getElementById('frequency-display');
        this.centsDisplay = document.getElementById('cents-display');
        this.clarityDisplay = document.getElementById('clarity-display');
        this.needle = document.getElementById('needle');
        this.noteName = document.getElementById('note-name');
        this.instructionText = document.getElementById('tuner-instruction-text');
        this.tunerMainBtn = document.getElementById('tuner-main-btn');

        this.instrumentButtons = document.querySelectorAll('[data-tuner-instrument]');
        this.chordRootSelect = document.getElementById('chord-root-select');
        this.chordQualitySelect = document.getElementById('chord-quality-select');
        this.chordTonePills = document.getElementById('chord-tone-pills');
        this.chordMatchBadge = document.getElementById('chord-match-badge');

        this.chordDiagramBox = document.getElementById('chord-diagram-box');
        this.chordDiagramTitle = document.getElementById('chord-diagram-title');
        this.chordDiagramSvg = document.getElementById('chord-diagram-svg');
        this.voicingPrevBtn = document.getElementById('voicing-prev-btn');
        this.voicingNextBtn = document.getElementById('voicing-next-btn');
        this.voicingCounter = document.getElementById('voicing-counter');

        this.loadChordPreference();
        this.bindChordControls();
        this.syncChordUI();

        if (this.tunerMainBtn) {
            this.tunerMainBtn.addEventListener('click', () => this.deactivate());
        }
    }

    loadChordPreference() {
        try {
            const raw = localStorage.getItem(TUNER_CHORD_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (['chromatic', 'guitar', 'ukulele'].includes(parsed.instrument)) {
                this.instrument = parsed.instrument;
            }
            if (parsed.root === 'chromatic' || this.noteNames.includes(parsed.root)) {
                this.intendedRoot = parsed.root;
            }
            if (parsed.quality && CHORD_QUALITIES[parsed.quality]) {
                this.intendedQuality = parsed.quality;
            }
        } catch {
            // Ignore storage restrictions
        }
    }

    saveChordPreference() {
        try {
            localStorage.setItem(
                TUNER_CHORD_KEY,
                JSON.stringify({
                    instrument: this.instrument,
                    root: this.intendedRoot,
                    quality: this.intendedQuality
                })
            );
        } catch {
            // Ignore storage restrictions
        }
    }

    bindChordControls() {
        this.instrumentButtons.forEach((btn) => {
            btn.addEventListener('click', () => {
                const nextInstrument = btn.dataset.tunerInstrument;
                if (!['chromatic', 'guitar', 'ukulele'].includes(nextInstrument)) return;
                this.instrument = nextInstrument;
                this.lockedPitchClass = null;
                this.lockedMidi = null;
                this.tunedKeys.clear();
                this.steadyInTuneFrames = 0;
                this.voicingIndex = 0;
                this.saveChordPreference();
                this.syncChordUI();
            });
        });

        if (this.chordRootSelect) {
            this.chordRootSelect.addEventListener('change', () => {
                this.intendedRoot = this.chordRootSelect.value;
                this.lockedPitchClass = null;
                this.lockedMidi = null;
                this.tunedKeys.clear();
                this.steadyInTuneFrames = 0;
                this.voicingIndex = 0;
                this.saveChordPreference();
                this.syncChordUI();
            });
        }
        if (this.chordQualitySelect) {
            this.chordQualitySelect.addEventListener('change', () => {
                this.intendedQuality = this.chordQualitySelect.value;
                this.lockedPitchClass = null;
                this.lockedMidi = null;
                this.tunedKeys.clear();
                this.steadyInTuneFrames = 0;
                this.voicingIndex = 0;
                this.saveChordPreference();
                this.syncChordUI();
            });
        }
        if (this.voicingPrevBtn) {
            this.voicingPrevBtn.addEventListener('click', () => {
                if (this.voicingIndex > 0) {
                    this.voicingIndex--;
                    this.renderChordDiagram();
                }
            });
        }
        if (this.voicingNextBtn) {
            this.voicingNextBtn.addEventListener('click', () => {
                if (this.voicingIndex + 1 < this.currentVoicings.length) {
                    this.voicingIndex++;
                    this.renderChordDiagram();
                }
            });
        }
    }

    getIntendedChordSpec() {
        if (this.intendedRoot === 'chromatic') return null;
        const rootPc = this.noteNames.indexOf(this.intendedRoot);
        const qualitySpec = CHORD_QUALITIES[this.intendedQuality] || CHORD_QUALITIES.maj;
        if (rootPc === -1) return null;

        const pitchClasses = qualitySpec.intervals.map((iv) => (rootPc + iv) % 12);
        return {
            label: `${this.intendedRoot}${qualitySpec.suffix}`,
            fullName: `${this.intendedRoot} ${qualitySpec.label}`,
            pitchClasses,
            tones: pitchClasses.map((pc) => ({ pc, name: this.noteNames[pc] }))
        };
    }

    syncChordUI() {
        const spec = this.getIntendedChordSpec();
        const instSpec = INSTRUMENT_TUNINGS[this.instrument] || null;

        this.instrumentButtons.forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.tunerInstrument === this.instrument);
        });

        if (this.chordRootSelect) {
            const firstOpt = this.chordRootSelect.options[0];
            if (firstOpt) {
                firstOpt.textContent = instSpec
                    ? `Open Strings (${instSpec.short})`
                    : 'Chromatic (Any Note)';
            }
            this.chordRootSelect.value = this.intendedRoot;
        }
        if (this.chordQualitySelect) {
            this.chordQualitySelect.value = this.intendedQuality;
            this.chordQualitySelect.classList.toggle('hidden', !spec);
        }

        if (!spec && !instSpec) {
            if (this.chordTonePills) {
                this.chordTonePills.classList.add('hidden');
                this.chordTonePills.textContent = '';
            }
            if (this.chordDiagramBox) {
                this.chordDiagramBox.classList.add('hidden');
            }
            if (this.chordMatchBadge) {
                this.chordMatchBadge.textContent = 'CHROMATIC';
                this.chordMatchBadge.classList.remove('is-matched');
            }
            if (this.instructionText) {
                this.instructionText.textContent = 'Play any note near the microphone to tune';
            }
            return;
        }

        // Render target pills: either Open Strings (when Guitar/Ukulele + no chord) or Chord Tones
        if (this.chordTonePills) {
            this.chordTonePills.classList.remove('hidden');
            this.chordTonePills.textContent = '';

            if (!spec && instSpec) {
                const autoBtn = document.createElement('button');
                autoBtn.type = 'button';
                autoBtn.className = `chord-tone-pill${this.lockedMidi === null ? ' active' : ''}`;
                autoBtn.textContent = 'Auto String';
                autoBtn.addEventListener('click', () => {
                    this.lockedMidi = null;
                    this.syncChordUI();
                });
                this.chordTonePills.appendChild(autoBtn);

                for (const s of instSpec.strings) {
                    const key = `m:${s.midi}`;
                    const isTuned = this.tunedKeys.has(key);
                    const isLocked = this.lockedMidi === s.midi;
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = `chord-tone-pill${isLocked ? ' active' : ''}${isTuned ? ' is-tuned' : ''}`;
                    btn.textContent = isTuned ? `${s.name} \u2713` : s.name;
                    btn.addEventListener('click', () => {
                        this.lockedMidi = this.lockedMidi === s.midi ? null : s.midi;
                        this.syncChordUI();
                    });
                    this.chordTonePills.appendChild(btn);
                }
            } else if (spec) {
                const autoBtn = document.createElement('button');
                autoBtn.type = 'button';
                autoBtn.className = `chord-tone-pill${this.lockedPitchClass === null ? ' active' : ''}`;
                autoBtn.textContent = 'Auto Tone';
                autoBtn.addEventListener('click', () => {
                    this.lockedPitchClass = null;
                    this.syncChordUI();
                });
                this.chordTonePills.appendChild(autoBtn);

                for (const tone of spec.tones) {
                    const key = `p:${tone.pc}`;
                    const isTuned = this.tunedKeys.has(key);
                    const isLocked = this.lockedPitchClass === tone.pc;
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = `chord-tone-pill${isLocked ? ' active' : ''}${isTuned ? ' is-tuned' : ''}`;
                    btn.textContent = isTuned ? `${tone.name} \u2713` : tone.name;
                    btn.addEventListener('click', () => {
                        this.lockedPitchClass = this.lockedPitchClass === tone.pc ? null : tone.pc;
                        this.syncChordUI();
                    });
                    this.chordTonePills.appendChild(btn);
                }
            }
        }

        if (this.instructionText) {
            if (!spec && instSpec) {
                if (this.lockedMidi !== null) {
                    const target = instSpec.strings.find((s) => s.midi === this.lockedMidi);
                    this.instructionText.textContent = `Tuning ${instSpec.label} string ${target ? target.name : ''}`;
                } else {
                    this.instructionText.textContent = `${instSpec.label} Standard (${instSpec.short})`;
                }
            } else if (spec) {
                if (this.lockedPitchClass !== null) {
                    this.instructionText.textContent = `Locked to ${this.noteNames[this.lockedPitchClass]} in ${spec.fullName}`;
                } else {
                    const noteList = spec.tones.map((t) => t.name).join(' \u00b7 ');
                    this.instructionText.textContent = `Tuning ${spec.fullName} (${noteList})`;
                }
            }
        }

        if (spec && instSpec) {
            this.loadInstrumentChordDiagram(instSpec, spec);
        } else if (this.chordDiagramBox) {
            this.chordDiagramBox.classList.add('hidden');
        }

        this.updateMatchBadge();
    }

    async loadInstrumentChordDiagram(instSpec, chordSpec) {
        if (!this.chordDiagramBox) return;
        this.chordDiagramBox.classList.remove('hidden');
        if (this.chordDiagramTitle) {
            this.chordDiagramTitle.textContent = `${instSpec.label}: ${chordSpec.fullName}`;
        }

        const cacheKey = `${this.instrument}:${this.intendedRoot}:${this.intendedQuality}`;
        if (this.chordVoicingCache.has(cacheKey)) {
            this.currentVoicings = this.chordVoicingCache.get(cacheKey);
            if (this.voicingIndex >= this.currentVoicings.length) this.voicingIndex = 0;
            this.renderChordDiagram();
            return;
        }

        if (this.chordDiagramSvg) {
            this.chordDiagramSvg.textContent = 'Loading fingering...';
        }

        try {
            const params = new URLSearchParams({
                instrument: this.instrument,
                root: this.intendedRoot,
                quality: this.intendedQuality
            });
            const response = await fetch(`/api/chords?${params.toString()}`);
            if (!response.ok) throw new Error('Chord lookup failed');
            const data = await response.json();
            const positions = Array.isArray(data.positions) ? data.positions : [];
            this.chordVoicingCache.set(cacheKey, positions);
            this.currentVoicings = positions;
            this.voicingIndex = 0;
            this.renderChordDiagram();
        } catch {
            this.currentVoicings = [];
            this.renderChordDiagram();
        }
    }

    renderChordDiagram() {
        if (!this.chordDiagramSvg) return;
        this.chordDiagramSvg.textContent = '';

        const total = this.currentVoicings.length;
        if (this.voicingCounter) {
            this.voicingCounter.textContent = total > 0 ? `${this.voicingIndex + 1}/${total}` : '0/0';
        }
        if (this.voicingPrevBtn) {
            this.voicingPrevBtn.disabled = this.voicingIndex <= 0;
        }
        if (this.voicingNextBtn) {
            this.voicingNextBtn.disabled = this.voicingIndex + 1 >= total;
        }

        const pos = this.currentVoicings[this.voicingIndex];
        if (!pos || !Array.isArray(pos.frets)) {
            this.chordDiagramSvg.textContent = 'No diagram available for this voicing.';
            return;
        }

        const instSpec = INSTRUMENT_TUNINGS[this.instrument] || INSTRUMENT_TUNINGS.guitar;
        const stringCount = pos.frets.length;
        const fretCount = 4;
        const svgNS = 'http://www.w3.org/2000/svg';

        const leftPad = 32;
        const rightPad = 18;
        const topPad = 24;
        const bottomPad = 22;
        const stringGap = stringCount === 6 ? 26 : 38;
        const fretGap = 24;
        const boardWidth = (stringCount - 1) * stringGap;
        const boardHeight = fretCount * fretGap;
        const width = leftPad + boardWidth + rightPad;
        const height = topPad + boardHeight + bottomPad;

        const svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', `${instSpec.label} chord fingering diagram`);

        const baseFret = pos.baseFret || 1;

        // Nut or baseFret indicator
        if (baseFret <= 1) {
            const nut = document.createElementNS(svgNS, 'rect');
            nut.setAttribute('x', String(leftPad));
            nut.setAttribute('y', String(topPad - 3));
            nut.setAttribute('width', String(boardWidth));
            nut.setAttribute('height', '4');
            nut.setAttribute('rx', '1');
            nut.setAttribute('fill', '#00f3ff');
            svg.appendChild(nut);
        } else {
            const fretLabel = document.createElementNS(svgNS, 'text');
            fretLabel.setAttribute('x', String(leftPad - 8));
            fretLabel.setAttribute('y', String(topPad + fretGap * 0.65));
            fretLabel.setAttribute('text-anchor', 'end');
            fretLabel.setAttribute('fill', '#00f3ff');
            fretLabel.setAttribute('font-size', '10');
            fretLabel.setAttribute('font-weight', '700');
            fretLabel.textContent = `${baseFret}fr`;
            svg.appendChild(fretLabel);
        }

        // Horizontal fret wires
        for (let f = 0; f <= fretCount; f++) {
            const y = topPad + f * fretGap;
            const line = document.createElementNS(svgNS, 'line');
            line.setAttribute('x1', String(leftPad));
            line.setAttribute('x2', String(leftPad + boardWidth));
            line.setAttribute('y1', String(y));
            line.setAttribute('y2', String(y));
            line.setAttribute('stroke', 'rgba(148, 163, 184, 0.45)');
            line.setAttribute('stroke-width', '1');
            svg.appendChild(line);
        }

        // Vertical strings
        for (let s = 0; s < stringCount; s++) {
            const x = leftPad + s * stringGap;
            const line = document.createElementNS(svgNS, 'line');
            line.setAttribute('x1', String(x));
            line.setAttribute('x2', String(x));
            line.setAttribute('y1', String(topPad));
            line.setAttribute('y2', String(topPad + boardHeight));
            line.setAttribute('stroke', 'rgba(226, 232, 240, 0.5)');
            line.setAttribute('stroke-width', String(1.5 - s * 0.1));
            svg.appendChild(line);

            const sLabel = document.createElementNS(svgNS, 'text');
            sLabel.setAttribute('x', String(x));
            sLabel.setAttribute('y', String(topPad + boardHeight + 15));
            sLabel.setAttribute('text-anchor', 'middle');
            sLabel.setAttribute('fill', '#94a3b8');
            sLabel.setAttribute('font-size', '9.5');
            sLabel.setAttribute('font-weight', '600');
            const openName = instSpec.strings[s]?.name?.replace(/\d+$/, '') || '';
            sLabel.textContent = openName;
            svg.appendChild(sLabel);
        }

        // Barre indicators
        if (Array.isArray(pos.barres)) {
            for (const barreFret of pos.barres) {
                if (barreFret < 1 || barreFret > fretCount) continue;
                let firstIdx = -1;
                let lastIdx = -1;
                for (let s = 0; s < stringCount; s++) {
                    if (pos.frets[s] === barreFret) {
                        if (firstIdx === -1) firstIdx = s;
                        lastIdx = s;
                    }
                }
                if (firstIdx !== -1 && lastIdx > firstIdx) {
                    const bx1 = leftPad + firstIdx * stringGap;
                    const bx2 = leftPad + lastIdx * stringGap;
                    const by = topPad + (barreFret - 0.5) * fretGap;
                    const bar = document.createElementNS(svgNS, 'rect');
                    bar.setAttribute('x', String(bx1 - 7));
                    bar.setAttribute('y', String(by - 6));
                    bar.setAttribute('width', String(bx2 - bx1 + 14));
                    bar.setAttribute('height', '12');
                    bar.setAttribute('rx', '6');
                    bar.setAttribute('fill', 'rgba(0, 243, 255, 0.85)');
                    svg.appendChild(bar);
                }
            }
        }

        // Open, muted, and fretted note markers
        for (let s = 0; s < stringCount; s++) {
            const x = leftPad + s * stringGap;
            const fret = pos.frets[s];
            const finger = Array.isArray(pos.fingers) ? pos.fingers[s] : 0;

            if (fret === -1) {
                const mute = document.createElementNS(svgNS, 'text');
                mute.setAttribute('x', String(x));
                mute.setAttribute('y', String(topPad - 8));
                mute.setAttribute('text-anchor', 'middle');
                mute.setAttribute('fill', '#ff0055');
                mute.setAttribute('font-size', '12');
                mute.setAttribute('font-weight', '700');
                mute.textContent = '\u00d7';
                svg.appendChild(mute);
            } else if (fret === 0) {
                const open = document.createElementNS(svgNS, 'circle');
                open.setAttribute('cx', String(x));
                open.setAttribute('cy', String(topPad - 12));
                open.setAttribute('r', '4.2');
                open.setAttribute('fill', 'none');
                open.setAttribute('stroke', '#00ff88');
                open.setAttribute('stroke-width', '1.6');
                svg.appendChild(open);
            } else if (fret >= 1 && fret <= fretCount) {
                const y = topPad + (fret - 0.5) * fretGap;
                const dot = document.createElementNS(svgNS, 'circle');
                dot.setAttribute('cx', String(x));
                dot.setAttribute('cy', String(y));
                dot.setAttribute('r', '7.5');
                dot.setAttribute('fill', '#00f3ff');
                svg.appendChild(dot);

                if (finger > 0) {
                    const num = document.createElementNS(svgNS, 'text');
                    num.setAttribute('x', String(x));
                    num.setAttribute('y', String(y + 3.2));
                    num.setAttribute('text-anchor', 'middle');
                    num.setAttribute('fill', '#020617');
                    num.setAttribute('font-size', '9.5');
                    num.setAttribute('font-weight', '700');
                    num.textContent = String(finger);
                    svg.appendChild(num);
                }
            }
        }

        this.chordDiagramSvg.appendChild(svg);
    }

    updateMatchBadge() {
        if (!this.chordMatchBadge) return;
        const spec = this.getIntendedChordSpec();
        const instSpec = INSTRUMENT_TUNINGS[this.instrument] || null;

        if (!spec && !instSpec) {
            this.chordMatchBadge.textContent = 'CHROMATIC';
            this.chordMatchBadge.classList.remove('is-matched');
            return;
        }

        if (!spec && instSpec) {
            const tunedCount = instSpec.strings.filter((s) => this.tunedKeys.has(`m:${s.midi}`)).length;
            if (tunedCount === instSpec.strings.length) {
                this.chordMatchBadge.textContent = `${instSpec.label} IN TUNE \u2713`;
                this.chordMatchBadge.classList.add('is-matched');
            } else {
                this.chordMatchBadge.textContent = tunedCount > 0
                    ? `${instSpec.label} (${tunedCount}/${instSpec.strings.length})`
                    : instSpec.short;
                this.chordMatchBadge.classList.remove('is-matched');
            }
            return;
        }

        if (this.isChordMatched) {
            this.chordMatchBadge.textContent = `${spec.label} MATCHED \u2713`;
            this.chordMatchBadge.classList.add('is-matched');
        } else {
            const tunedCount = spec.pitchClasses.filter((pc) => this.tunedKeys.has(`p:${pc}`)).length;
            this.chordMatchBadge.textContent = tunedCount > 0
                ? `${spec.label} (${tunedCount}/${spec.pitchClasses.length})`
                : `TARGET: ${spec.label}`;
            this.chordMatchBadge.classList.remove('is-matched');
        }
    }

    updateLiveChordMatch(liveChord, smoothChroma) {
        if (!this.isTunerActive) return;
        const spec = this.getIntendedChordSpec();
        if (!spec) {
            this.isChordMatched = false;
            return;
        }

        let matched = liveChord === spec.label;
        if (!matched && smoothChroma && smoothChroma.length === 12) {
            let energy = 0;
            let chordEnergy = 0;
            for (let i = 0; i < 12; i++) {
                energy += smoothChroma[i] * smoothChroma[i];
            }
            if (energy > 0.5) {
                for (const pc of spec.pitchClasses) {
                    chordEnergy += smoothChroma[pc];
                }
                const normChroma = Math.sqrt(energy);
                const templateNorm = Math.sqrt(spec.pitchClasses.length);
                const cosine = chordEnergy / (normChroma * templateNorm);
                if (cosine > 0.8) {
                    matched = true;
                }
            }
        }

        if (matched !== this.isChordMatched) {
            this.isChordMatched = matched;
            this.updateMatchBadge();
        }
    }

    activate() {
        if (this.isTunerActive) return;
        this.smoothedFrequency = 0;
        this.freqHistory = [];
        this.steadyInTuneFrames = 0;
        this.isChordMatched = false;
        this.tunerInterface.classList.remove('hidden');
        this.isTunerActive = true;
        this.syncChordUI();
        this.analyzeFrequency();
    }

    deactivate() {
        this.tunerInterface.classList.add('hidden');
        const featureSelection = document.getElementById('feature-selection');
        if (featureSelection) {
            featureSelection.classList.remove('hidden');
        }
        this.isTunerActive = false;
        if (this.animationId !== null) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
        this.resetDisplay();
    }

    resetDisplay() {
        this.noteDisplay.textContent = '--';
        this.frequencyDisplay.textContent = '0.00 Hz';
        this.centsDisplay.textContent = '0.0 cents';
        if (this.clarityDisplay) this.clarityDisplay.textContent = '--%';
        this.noteName.textContent = '--';
        this.freqHistory = [];
        this.smoothedFrequency = 0;
        this.steadyInTuneFrames = 0;
        if (this.tunerStatus) {
            this.tunerStatus.textContent = this.intendedRoot === 'chromatic' ? 'PLAY A NOTE' : 'PLAY CHORD TONE';
            this.tunerStatus.style.color = 'var(--primary-neon)';
        }
        this.needle.style.left = '50%';
        this.needle.style.background = 'var(--primary-neon)';
        this.needle.style.boxShadow = '0 0 10px var(--primary-neon)';
    }

    analyzeFrequency() {
        if (!this.isTunerActive) {
            this.animationId = null;
            return;
        }

        const now = performance.now();
        const timeData = this.audio.getTimeDomainData();
        const result = this.detectPitchYIN(timeData, this.audio.getSampleRate());

        if (result && result.frequency > 0) {
            this.lastDetectionTime = now;

            // Reject sudden single-frame octave glitches using median smoothing
            if (
                this.smoothedFrequency > 0 &&
                Math.abs(result.frequency - this.smoothedFrequency) / this.smoothedFrequency > 0.08
            ) {
                this.freqHistory.push(result.frequency);
                if (this.freqHistory.length > 5) this.freqHistory.shift();
                // Require at least 2 consistent frames before snapping to a distant new note
                const recentConsistent = this.freqHistory.filter(
                    (f) => Math.abs(f - result.frequency) / result.frequency < 0.04
                ).length;
                if (recentConsistent >= 2) {
                    this.smoothedFrequency = result.frequency;
                    this.freqHistory = [result.frequency];
                    this.steadyInTuneFrames = 0;
                }
            } else {
                this.freqHistory.push(result.frequency);
                if (this.freqHistory.length > 5) this.freqHistory.shift();
                const sorted = [...this.freqHistory].sort((a, b) => a - b);
                const medianFreq = sorted[Math.floor(sorted.length / 2)];
                const alpha = result.clarity > 0.94 ? 0.3 : 0.2;
                this.smoothedFrequency = this.smoothedFrequency > 0
                    ? this.smoothedFrequency * (1 - alpha) + medianFreq * alpha
                    : medianFreq;
            }

            if (this.smoothedFrequency > 0) {
                const noteInfo = this.frequencyToTargetNote(this.smoothedFrequency);
                this.updateTunerDisplay(noteInfo, this.smoothedFrequency, result.clarity);
            }
        } else if (this.smoothedFrequency > 0 && now - this.lastDetectionTime > 1200) {
            this.smoothedFrequency = 0;
            this.freqHistory = [];
            this.steadyInTuneFrames = 0;
            if (this.tunerStatus) {
                this.tunerStatus.textContent = this.intendedRoot === 'chromatic' ? 'PLAY A NOTE' : 'PLAY CHORD TONE';
                this.tunerStatus.style.color = 'var(--primary-neon)';
            }
            if (this.clarityDisplay) this.clarityDisplay.textContent = '--%';
        }

        this.animationId = requestAnimationFrame(() => this.analyzeFrequency());
    }

    /**
     * YIN pitch detection with DC-offset removal, cumulative mean normalized
     * difference function, absolute threshold, and parabolic sub-sample interpolation.
     */
    detectPitchYIN(buffer, sampleRate) {
        const size = buffer.length;
        if (size < 512) return null;

        if (this.centeredBuffer.length < size) {
            this.centeredBuffer = new Float32Array(size);
        }

        let mean = 0;
        for (let i = 0; i < size; i++) {
            mean += buffer[i];
        }
        mean /= size;

        let rms = 0;
        for (let i = 0; i < size; i++) {
            const c = buffer[i] - mean;
            this.centeredBuffer[i] = c;
            rms += c * c;
        }
        rms = Math.sqrt(rms / size);
        if (rms < 0.008) return null;

        const windowSize = Math.min(1536, Math.floor(size * 0.5));
        const minLag = Math.max(4, Math.floor(sampleRate / 1800));
        const maxLag = Math.min(size - windowSize - 1, Math.floor(sampleRate / 41));
        if (maxLag <= minLag + 2) return null;

        if (this.yinBuffer.length <= maxLag + 1) {
            this.yinBuffer = new Float32Array(maxLag + 2);
        }

        const yin = this.yinBuffer;
        const centered = this.centeredBuffer;
        yin[0] = 1;

        let runningSum = 0;
        for (let tau = 1; tau <= maxLag; tau++) {
            let sum = 0;
            for (let i = 0; i < windowSize; i++) {
                const delta = centered[i] - centered[i + tau];
                sum += delta * delta;
            }
            runningSum += sum;
            yin[tau] = runningSum > 0 ? (sum * tau) / runningSum : 1;
        }

        // First local minimum below strict threshold prevents octave-down jumps
        const threshold = 0.13;
        let tauEstimate = -1;
        for (let tau = minLag; tau <= maxLag; tau++) {
            if (yin[tau] < threshold) {
                while (tau + 1 <= maxLag && yin[tau + 1] < yin[tau]) {
                    tau++;
                }
                tauEstimate = tau;
                break;
            }
        }

        if (tauEstimate === -1) {
            let bestVal = 0.22;
            for (let tau = minLag; tau <= maxLag; tau++) {
                if (yin[tau] < bestVal) {
                    bestVal = yin[tau];
                    tauEstimate = tau;
                }
            }
        }

        if (tauEstimate === -1) return null;

        const minCmndf = yin[tauEstimate];
        const clarity = Math.max(0, Math.min(1, 1 - minCmndf));

        let betterTau = tauEstimate;
        if (tauEstimate > minLag && tauEstimate < maxLag) {
            const s0 = yin[tauEstimate - 1];
            const s1 = yin[tauEstimate];
            const s2 = yin[tauEstimate + 1];
            const denom = 2 * (2 * s1 - s2 - s0);
            if (Math.abs(denom) > 1e-9) {
                const shift = (s2 - s0) / denom;
                if (Math.abs(shift) < 1) {
                    betterTau = tauEstimate + shift;
                }
            }
        }

        const frequency = sampleRate / betterTau;
        if (!Number.isFinite(frequency) || frequency < 41 || frequency > 1800) {
            return null;
        }

        return { frequency, clarity };
    }

    frequencyToTargetNote(frequency) {
        const midiFloat = 12 * Math.log2(frequency / 440) + 69;
        const spec = this.getIntendedChordSpec();
        const instSpec = INSTRUMENT_TUNINGS[this.instrument] || null;

        if (!spec && instSpec) {
            const targets = this.lockedMidi !== null
                ? instSpec.strings.filter((s) => s.midi === this.lockedMidi)
                : instSpec.strings;
            let best = targets[0] || instSpec.strings[0];
            let bestCents = Infinity;
            for (const s of targets) {
                const cents = (midiFloat - s.midi) * 100;
                if (Math.abs(cents) < Math.abs(bestCents)) {
                    bestCents = cents;
                    best = s;
                }
            }
            return {
                label: best.name,
                trackKey: `m:${best.midi}`,
                cents: bestCents
            };
        }

        if (!spec) {
            const midiNote = Math.round(midiFloat);
            const cents = (midiFloat - midiNote) * 100;
            const noteIndex = ((midiNote % 12) + 12) % 12;
            const octave = Math.floor(midiNote / 12) - 1;
            return {
                label: `${this.noteNames[noteIndex]}${octave}`,
                trackKey: `p:${noteIndex}`,
                cents
            };
        }

        const candidates = this.lockedPitchClass !== null ? [this.lockedPitchClass] : spec.pitchClasses;
        const baseOctave = Math.floor(midiFloat / 12) - 1;
        let bestMidi = Math.round(midiFloat);
        let bestCents = Infinity;
        let bestPc = candidates[0];

        for (const pc of candidates) {
            for (let oct = baseOctave - 1; oct <= baseOctave + 1; oct++) {
                const candMidi = (oct + 1) * 12 + pc;
                const cents = (midiFloat - candMidi) * 100;
                if (Math.abs(cents) < Math.abs(bestCents)) {
                    bestCents = cents;
                    bestMidi = candMidi;
                    bestPc = pc;
                }
            }
        }

        const octave = Math.floor(bestMidi / 12) - 1;
        return {
            label: `${this.noteNames[bestPc]}${octave}`,
            trackKey: `p:${bestPc}`,
            cents: bestCents
        };
    }

    updateTunerDisplay(noteInfo, frequency, clarity) {
        const { label, trackKey, cents } = noteInfo;
        this.noteDisplay.textContent = label;
        this.frequencyDisplay.textContent = `${frequency.toFixed(2)} Hz`;
        this.centsDisplay.textContent = `${cents >= 0 ? '+' : ''}${cents.toFixed(1)} cents`;
        if (this.clarityDisplay) {
            this.clarityDisplay.textContent = `${Math.round(clarity * 100)}% lock`;
        }
        this.noteName.textContent = label;

        const normalizedCents = Math.max(-50, Math.min(50, cents));
        const needlePosition = 50 + normalizedCents;
        this.needle.style.left = `${needlePosition}%`;

        const absCents = Math.abs(cents);
        if (absCents <= 3.0) {
            this.needle.style.background = '#00ff88';
            this.needle.style.boxShadow = '0 0 15px #00ff88';
            if (this.tunerStatus) {
                this.tunerStatus.textContent = 'IN TUNE';
                this.tunerStatus.style.color = '#00ff88';
            }

            if (this.intendedRoot !== 'chromatic' || this.instrument !== 'chromatic') {
                if (this.lastSteadyKey === trackKey) {
                    this.steadyInTuneFrames++;
                } else {
                    this.lastSteadyKey = trackKey;
                    this.steadyInTuneFrames = 1;
                }
                if (this.steadyInTuneFrames === 6 && !this.tunedKeys.has(trackKey)) {
                    this.tunedKeys.add(trackKey);
                    this.syncChordUI();
                }
            }
        } else {
            this.steadyInTuneFrames = 0;
            if (absCents <= 10.0) {
                this.needle.style.background = '#ffd000';
                this.needle.style.boxShadow = '0 0 10px #ffd000';
                if (this.tunerStatus) {
                    this.tunerStatus.textContent = cents < 0 ? 'SLIGHTLY FLAT' : 'SLIGHTLY SHARP';
                    this.tunerStatus.style.color = '#ffd000';
                }
            } else {
                this.needle.style.background = '#ff0055';
                this.needle.style.boxShadow = '0 0 10px #ff0055';
                if (this.tunerStatus) {
                    this.tunerStatus.textContent = cents < 0 ? 'TUNE UP (FLAT)' : 'TUNE DOWN (SHARP)';
                    this.tunerStatus.style.color = '#ff0055';
                }
            }
        }
    }
}

/**
 * MusicXML Parser & VexFlow Renderer
 * Parses raw MusicXML (<score-partwise> / <score-timewise>) and renders engraved
 * notation into #lead-sheet-staff using VexFlow 5.
 */
class MusicXMLRenderer {
    constructor() {
        this.fifthToKeySig = [
            'Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F',
            'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'
        ];
        this.typeToDuration = {
            breve: 'w',
            whole: 'w',
            half: 'h',
            quarter: 'q',
            eighth: '8',
            '16th': '16',
            '32nd': '32',
            '64th': '64'
        };
        this.accidentalMap = {
            sharp: '#',
            flat: 'b',
            natural: 'n',
            'double-sharp': '##',
            'sharp-sharp': '##',
            'flat-flat': 'bb'
        };
        this.kindSuffixMap = {
            major: '',
            minor: 'm',
            dominant: '7',
            'major-seventh': 'maj7',
            'minor-seventh': 'm7',
            diminished: 'dim',
            augmented: 'aug',
            'suspended-fourth': 'sus4',
            'suspended-second': 'sus2',
            power: '5'
        };
    }

    getVexFlow() {
        return window.VexFlowLib || window.Vex?.Flow || window.Vex || null;
    }

    alterToSuffix(alter) {
        if (alter === 1) return '#';
        if (alter === 2) return '##';
        if (alter === -1) return 'b';
        if (alter === -2) return 'bb';
        return '';
    }

    inferDurationFromTicks(durationTicks, divisions) {
        if (!divisions || !durationTicks) return 'q';
        const quarters = durationTicks / divisions;
        if (quarters >= 3.5) return 'w';
        if (quarters >= 1.75) return 'h';
        if (quarters >= 0.85) return 'q';
        if (quarters >= 0.4) return '8';
        if (quarters >= 0.2) return '16';
        return '32';
    }

    parseHarmonyLabel(harmonyEl) {
        const rootStep = harmonyEl.querySelector('root > root-step')?.textContent?.trim();
        if (!rootStep) return null;
        const rootAlter = Number(harmonyEl.querySelector('root > root-alter')?.textContent?.trim() || '0');
        const kindEl = harmonyEl.querySelector('kind');
        const kindText = kindEl?.getAttribute('text');
        const kindVal = kindEl?.textContent?.trim() || 'major';
        const suffix = kindText !== null && kindText !== ''
            ? kindText
            : (this.kindSuffixMap[kindVal] ?? '');
        return `${rootStep}${this.alterToSuffix(rootAlter)}${suffix}`;
    }

    parseMusicXML(rawXml) {
        const xmlText = String(rawXml || '').trim();
        if (!xmlText) {
            throw new Error('MusicXML input is empty.');
        }

        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlText, 'application/xml');
        const parseErr = doc.querySelector('parsererror');
        if (parseErr) {
            throw new Error('Invalid XML syntax in MusicXML input.');
        }

        const title =
            doc.querySelector('work > work-title')?.textContent?.trim() ||
            doc.querySelector('movement-title')?.textContent?.trim() ||
            'Untitled Score';
        const composer =
            doc.querySelector('identification > creator[type="composer"]')?.textContent?.trim() || '';

        let measureNodes = [];
        const firstPart = doc.querySelector('score-partwise > part') || doc.querySelector('part');
        if (firstPart) {
            measureNodes = Array.from(firstPart.querySelectorAll(':scope > measure'));
        }
        if (measureNodes.length === 0) {
            // Handle <score-timewise> or standalone <measure> snippets
            const timewiseMeasures = Array.from(doc.querySelectorAll('score-timewise > measure'));
            if (timewiseMeasures.length > 0) {
                measureNodes = timewiseMeasures.map((m) => m.querySelector('part') || m);
            } else {
                measureNodes = Array.from(doc.querySelectorAll('measure'));
            }
        }

        if (measureNodes.length === 0) {
            throw new Error('No <measure> elements found in MusicXML.');
        }

        let divisions = 1;
        let currentClef = 'treble';
        let currentKeySig = 'C';
        let currentTime = { beats: 4, beatType: 4 };
        let primaryVoice = null;

        const measures = [];

        for (let mIdx = 0; mIdx < measureNodes.length; mIdx++) {
            const mNode = measureNodes[mIdx];
            const attrEl = mNode.querySelector(':scope > attributes');
            let showClef = mIdx === 0;
            let showKey = mIdx === 0;
            let showTime = mIdx === 0;

            if (attrEl) {
                const divText = attrEl.querySelector('divisions')?.textContent?.trim();
                if (divText && Number(divText) > 0) {
                    divisions = Number(divText);
                }

                const fifthsEl = attrEl.querySelector('key > fifths');
                if (fifthsEl) {
                    const fifths = Math.max(-7, Math.min(7, Number(fifthsEl.textContent?.trim() || '0')));
                    const nextKey = this.fifthToKeySig[fifths + 7] || 'C';
                    if (nextKey !== currentKeySig || mIdx === 0) {
                        currentKeySig = nextKey;
                        showKey = true;
                    }
                }

                const beatsEl = attrEl.querySelector('time > beats');
                const beatTypeEl = attrEl.querySelector('time > beat-type');
                if (beatsEl && beatTypeEl) {
                    const beats = Number(beatsEl.textContent?.trim() || '4') || 4;
                    const beatType = Number(beatTypeEl.textContent?.trim() || '4') || 4;
                    if (beats !== currentTime.beats || beatType !== currentTime.beatType || mIdx === 0) {
                        currentTime = { beats, beatType };
                        showTime = true;
                    }
                }

                const clefSign = attrEl.querySelector('clef > sign')?.textContent?.trim();
                const clefLine = attrEl.querySelector('clef > line')?.textContent?.trim();
                if (clefSign) {
                    let nextClef = 'treble';
                    if (clefSign === 'F') nextClef = 'bass';
                    else if (clefSign === 'C') nextClef = clefLine === '4' ? 'tenor' : 'alto';
                    else if (clefSign.toLowerCase() === 'percussion') nextClef = 'percussion';
                    if (nextClef !== currentClef || mIdx === 0) {
                        currentClef = nextClef;
                        showClef = true;
                    }
                }
            }

            const notes = [];
            let pendingChordSymbol = null;

            for (const child of Array.from(mNode.children)) {
                const tag = child.tagName.toLowerCase();
                if (tag === 'harmony') {
                    pendingChordSymbol = this.parseHarmonyLabel(child);
                    continue;
                }
                if (tag !== 'note') continue;
                if (child.querySelector(':scope > grace')) continue;

                const voiceName = child.querySelector(':scope > voice')?.textContent?.trim() || '1';
                if (primaryVoice === null) primaryVoice = voiceName;
                if (voiceName !== primaryVoice) continue;

                const isRest = Boolean(child.querySelector(':scope > rest'));
                const isChord = Boolean(child.querySelector(':scope > chord'));
                const typeText = child.querySelector(':scope > type')?.textContent?.trim()?.toLowerCase();
                const durTicks = Number(child.querySelector(':scope > duration')?.textContent?.trim() || '0');
                const dotCount = child.querySelectorAll(':scope > dot').length;
                const tieStart = Boolean(child.querySelector(':scope > tie[type="start"]'));
                const tieStop = Boolean(child.querySelector(':scope > tie[type="stop"]'));

                const baseDur = (typeText && this.typeToDuration[typeText]) ||
                    this.inferDurationFromTicks(durTicks, divisions);

                let vfKey = currentClef === 'bass' ? 'd/3' : 'b/4';
                let accidental = null;

                if (!isRest) {
                    const step = (child.querySelector(':scope > pitch > step')?.textContent?.trim() || 'C').toLowerCase();
                    const alter = Number(child.querySelector(':scope > pitch > alter')?.textContent?.trim() || '0');
                    const octave = child.querySelector(':scope > pitch > octave')?.textContent?.trim() || '4';
                    const alterSuffix = this.alterToSuffix(alter);
                    vfKey = `${step}${alterSuffix}/${octave}`;

                    const accText = child.querySelector(':scope > accidental')?.textContent?.trim()?.toLowerCase();
                    if (accText && this.accidentalMap[accText]) {
                        accidental = this.accidentalMap[accText];
                    } else if (alterSuffix) {
                        accidental = alterSuffix;
                    }
                }

                if (isChord && notes.length > 0 && !notes[notes.length - 1].isRest) {
                    const prev = notes[notes.length - 1];
                    prev.keys.push(vfKey);
                    prev.accidentals.push(accidental);
                    if (tieStart) prev.tieStart = true;
                    if (tieStop) prev.tieStop = true;
                } else {
                    notes.push({
                        keys: [vfKey],
                        accidentals: [accidental],
                        duration: `${baseDur}${dotCount > 0 ? 'd' : ''}${isRest ? 'r' : ''}`,
                        dotCount,
                        isRest,
                        clef: currentClef,
                        chordSymbol: pendingChordSymbol,
                        tieStart,
                        tieStop
                    });
                    pendingChordSymbol = null;
                }
            }

            if (notes.length === 0) {
                notes.push({
                    keys: [currentClef === 'bass' ? 'd/3' : 'b/4'],
                    accidentals: [null],
                    duration: 'wr',
                    dotCount: 0,
                    isRest: true,
                    clef: currentClef,
                    chordSymbol: pendingChordSymbol,
                    tieStart: false,
                    tieStop: false
                });
            }

            measures.push({
                number: mNode.getAttribute('number') || String(mIdx + 1),
                clef: currentClef,
                keySignature: currentKeySig,
                timeSignature: `${currentTime.beats}/${currentTime.beatType}`,
                beats: currentTime.beats,
                beatType: currentTime.beatType,
                showClef,
                showKey,
                showTime,
                notes
            });
        }

        return { title, composer, measures };
    }

    chordProgressionToMusicXML(keyStr, chordsStr, title = 'Detected Lead Sheet') {
        const keyMap = {
            C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7,
            F: -1, Bb: -2, 'A#': -2, Eb: -3, 'D#': -3, Ab: -4, 'G#': -4, Db: -5, Gb: -6
        };
        const minorToRelMajor = {
            A: 0, E: 1, B: 2, 'F#': 3, 'C#': 4, 'G#': 5, 'D#': 6,
            D: -1, G: -2, C: -3, F: -4, Bb: -5, 'A#': -5, Eb: -6
        };

        let fifths = 0;
        let mode = 'major';
        if (keyStr && keyStr !== '--' && keyStr !== 'Undetermined') {
            const parts = keyStr.trim().split(/\s+/);
            const root = parts[0];
            mode = (parts[1] || 'major').toLowerCase() === 'minor' ? 'minor' : 'major';
            fifths = mode === 'minor' ? (minorToRelMajor[root] ?? 0) : (keyMap[root] ?? 0);
        }

        const chordTokens = (chordsStr && chordsStr !== '--' && chordsStr !== 'Undetermined')
            ? chordsStr.split(/\s*-\s*/).map((s) => s.trim()).filter(Boolean).slice(0, 4)
            : [];

        const noteList = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const safeTitle = title.replace(/[<>&]/g, '');

        if (chordTokens.length === 0) {
            return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>${safeTitle}</work-title></work>
  <part-list><score-part id="P1"><part-name>Lead</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <key><fifths>${fifths}</fifths><mode>${mode}</mode></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><rest/><duration>4</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`;
        }

        const measuresXml = chordTokens.map((label, idx) => {
            const match = /^([A-G])(#?)(m|7)?$/.exec(label);
            if (!match) return '';
            const [, letter, sharp, quality] = match;
            const rootName = `${letter}${sharp}`;
            const rootAlter = sharp ? 1 : 0;
            const kind = quality === 'm' ? 'minor' : quality === '7' ? 'dominant' : 'major';
            const rootIdx = noteList.indexOf(rootName);
            const intervals = quality === 'm' ? [0, 3, 7] : quality === '7' ? [0, 4, 7, 10] : [0, 4, 7];

            let prevMidi = 59;
            const chordNotesXml = intervals.map((iv, nIdx) => {
                let midi = 60 + ((rootIdx + iv) % 12);
                while (midi <= prevMidi) midi += 12;
                if (midi > 79) midi -= 12;
                prevMidi = midi;
                const pcName = noteList[midi % 12];
                const step = pcName[0];
                const alter = pcName.includes('#') ? '<alter>1</alter>' : '';
                const octave = Math.floor(midi / 12) - 1;
                return `<note>
        ${nIdx > 0 ? '<chord/>' : ''}
        <pitch><step>${step}</step>${alter}<octave>${octave}</octave></pitch>
        <duration>4</duration>
        <type>whole</type>
      </note>`;
            }).join('\n      ');

            const attrXml = idx === 0
                ? `<attributes>
        <divisions>1</divisions>
        <key><fifths>${fifths}</fifths><mode>${mode}</mode></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>`
                : '';

            return `<measure number="${idx + 1}">
      ${attrXml}
      <harmony>
        <root><root-step>${letter}</root-step>${rootAlter ? `<root-alter>${rootAlter}</root-alter>` : ''}</root>
        <kind>${kind}</kind>
      </harmony>
      ${chordNotesXml}
    </measure>`;
        }).filter(Boolean).join('\n    ');

        return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>${safeTitle}</work-title></work>
  <part-list><score-part id="P1"><part-name>Lead</part-name></score-part></part-list>
  <part id="P1">
    ${measuresXml}
  </part>
</score-partwise>`;
    }

    getSampleMusicXML() {
        return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>Neon Prelude</work-title></work>
  <part-list><score-part id="P1"><part-name>Lead</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>2</divisions>
        <key><fifths>0</fifths><mode>major</mode></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <harmony><root><root-step>C</root-step></root><kind>major</kind></harmony>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><type>eighth</type></note>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>1</duration><type>eighth</type></note>
      <harmony><root><root-step>A</root-step></root><kind>minor</kind></harmony>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>half</type></note>
    </measure>
    <measure number="2">
      <harmony><root><root-step>F</root-step></root><kind>major</kind></harmony>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>3</duration><type>quarter</type><dot/></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><type>eighth</type></note>
      <harmony><root><root-step>G</root-step></root><kind>dominant</kind></harmony>
      <note><pitch><step>F</step><alter>1</alter><octave>4</octave></pitch><duration>2</duration><type>quarter</type><accidental>sharp</accidental></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;
    }

    renderMusicXML(rawXml, containerEl) {
        if (!containerEl) return null;
        const parsed = this.parseMusicXML(rawXml);
        const VF = this.getVexFlow();

        if (!VF || !VF.Renderer || !VF.Stave || !VF.StaveNote) {
            throw new Error('VexFlow notation engine is still initializing.');
        }

        const { Renderer, Stave, StaveNote, Voice, Formatter, Accidental, Beam, Dot, Annotation, StaveTie } = VF;

        containerEl.textContent = '';

        const containerWidth = Math.max(320, (containerEl.clientWidth ? containerEl.clientWidth - 16 : 360));
        const measuresPerRow = containerWidth >= 460 ? 2 : (parsed.measures.length === 1 ? 1 : 2);
        const rowHeight = 112;
        const rowCount = Math.ceil(parsed.measures.length / measuresPerRow);
        const width = Math.max(340, containerWidth);
        const height = Math.max(122, rowCount * rowHeight + 16);

        const renderer = new Renderer(containerEl, Renderer.Backends.SVG);
        renderer.resize(width, height);
        const context = renderer.getContext();
        context.setFillStyle('#f1f5f9');
        context.setStrokeStyle('#cbd5e1');

        const svgEl = containerEl.querySelector('svg');
        if (svgEl) {
            svgEl.setAttribute('viewBox', `0 0 ${width} ${height}`);
            svgEl.setAttribute('role', 'img');
            svgEl.setAttribute('aria-label', `${parsed.title} sheet music rendered with VexFlow`);
        }

        const horizontalPad = 10;
        const usableWidth = width - horizontalPad * 2;
        let prevTieSource = null;

        for (let row = 0; row < rowCount; row++) {
            const startIdx = row * measuresPerRow;
            const rowMeasures = parsed.measures.slice(startIdx, startIdx + measuresPerRow);
            const firstExtra = rowMeasures.length > 1 ? (row === 0 ? 64 : 36) : 0;
            const baseMeasureWidth = (usableWidth - firstExtra) / rowMeasures.length;
            let cursorX = horizontalPad;
            const staveY = 18 + row * rowHeight;

            rowMeasures.forEach((m, colIdx) => {
                const isRowStart = colIdx === 0;
                const mWidth = isRowStart ? baseMeasureWidth + firstExtra : baseMeasureWidth;
                const stave = new Stave(cursorX, staveY, mWidth);

                if (typeof stave.setStyle === 'function') {
                    stave.setStyle({ strokeStyle: 'rgba(148, 163, 184, 0.55)', fillStyle: '#00f3ff' });
                }
                if (typeof stave.setDefaultLedgerLineStyle === 'function') {
                    stave.setDefaultLedgerLineStyle({ strokeStyle: 'rgba(203, 213, 225, 0.7)' });
                }

                if (isRowStart || m.showClef) {
                    stave.addClef(m.clef);
                }
                if ((isRowStart && (row === 0 || m.keySignature !== 'C')) || m.showKey) {
                    try {
                        stave.addKeySignature(m.keySignature);
                    } catch {
                        // Ignore unsupported key strings
                    }
                }
                if ((isRowStart && row === 0) || m.showTime) {
                    stave.addTimeSignature(m.timeSignature);
                }

                stave.setContext(context).draw();

                const vfNotes = [];
                const measureTies = [];

                for (const n of m.notes) {
                    const staveNote = new StaveNote({
                        keys: n.keys,
                        duration: n.duration,
                        clef: n.clef || m.clef,
                        autoStem: true
                    });

                    if (typeof staveNote.setStyle === 'function') {
                        staveNote.setStyle({ fillStyle: '#f8fafc', strokeStyle: '#f8fafc' });
                    }

                    n.accidentals.forEach((acc, keyIdx) => {
                        if (acc && !n.isRest) {
                            staveNote.addModifier(new Accidental(acc), keyIdx);
                        }
                    });

                    if (n.dotCount > 0 && Dot && typeof Dot.buildAndAttach === 'function') {
                        for (let d = 0; d < n.dotCount; d++) {
                            Dot.buildAndAttach([staveNote], { all: true });
                        }
                    }

                    if (n.chordSymbol && Annotation) {
                        const ann = new Annotation(n.chordSymbol);
                        if (Annotation.VerticalJustify) {
                            ann.setVerticalJustification(Annotation.VerticalJustify.TOP);
                        }
                        if (typeof ann.setFont === 'function') {
                            ann.setFont('Outfit', 11, 'bold');
                        }
                        if (typeof ann.setStyle === 'function') {
                            ann.setStyle({ fillStyle: '#00f3ff' });
                        }
                        staveNote.addModifier(ann, 0);
                    }

                    if (n.tieStop && prevTieSource && StaveTie) {
                        measureTies.push(new StaveTie({
                            firstNote: prevTieSource,
                            lastNote: staveNote,
                            firstIndexes: [0],
                            lastIndexes: [0]
                        }));
                        prevTieSource = null;
                    }
                    if (n.tieStart) {
                        prevTieSource = staveNote;
                    }

                    vfNotes.push(staveNote);
                }

                if (vfNotes.length > 0) {
                    const voice = new Voice({ numBeats: m.beats, beatValue: m.beatType });
                    if (typeof voice.setStrict === 'function') {
                        voice.setStrict(false);
                    }
                    voice.addTickables(vfNotes);

                    const beams = Beam && typeof Beam.generateBeams === 'function'
                        ? Beam.generateBeams(vfNotes, { stemDirection: undefined })
                        : [];

                    const formatWidth = Math.max(60, stave.getNoteEndX() - stave.getNoteStartX() - 14);
                    new Formatter().joinVoices([voice]).format([voice], formatWidth);
                    voice.draw(context, stave);

                    for (const beam of beams) {
                        if (typeof beam.setStyle === 'function') {
                            beam.setStyle({ fillStyle: '#e2e8f0', strokeStyle: '#e2e8f0' });
                        }
                        beam.setContext(context).draw();
                    }
                    for (const tie of measureTies) {
                        if (typeof tie.setStyle === 'function') {
                            tie.setStyle({ fillStyle: '#00f3ff', strokeStyle: '#00f3ff' });
                        }
                        tie.setContext(context).draw();
                    }
                }

                cursorX += mWidth;
            });
        }

        return parsed;
    }
}

/**
 * UI Controller
 */
class UIController {
    constructor() {
        this.audioController = new AudioController();
        this.harmonyAnalyzer = new HarmonyAnalyzer(this.audioController);
        this.visualizer = new Visualizer('visualizer', this.audioController);
        this.recognitionService = new RecognitionService(this.audioController, this.harmonyAnalyzer);
        this.tuner = new Tuner(this.audioController);
        this.musicXmlRenderer = new MusicXMLRenderer();
        window.musicXMLRenderer = this.musicXmlRenderer;

        this.startBtn = document.getElementById('start-btn');
        this.identifyBtn = document.getElementById('identify-btn');
        this.backToModesBtn = document.getElementById('back-to-modes-btn');
        this.returnStartBtn = document.getElementById('return-start-btn');
        this.retryMicBtn = document.getElementById('retry-mic-btn');
        this.tunerFeatureBtn = document.getElementById('tuner-btn');
        this.identifyFeatureBtn = document.getElementById('identify-feature-btn');

        this.startOverlay = document.getElementById('start-overlay');
        this.featureSelection = document.getElementById('feature-selection');
        this.interface = document.getElementById('interface');
        this.modal = document.getElementById('result-modal');
        this.closeModalBtn = document.getElementById('close-modal-btn');
        this.closeModalXBtn = document.getElementById('close-modal');
        this.resultMainBtn = document.getElementById('result-main-btn');
        this.youtubeLinkBtn = document.getElementById('youtube-link-btn');
        this.youtubeLinkLabel = document.getElementById('youtube-link-label');
        this.sheetMusicBtn = document.getElementById('sheet-music-btn');
        this.sheetMusicPanel = document.getElementById('sheet-music-panel');
        this.leadSheetStaff = document.getElementById('lead-sheet-staff');
        this.leadSheetNotes = document.getElementById('lead-sheet-notes');
        this.toggleMusicXmlBtn = document.getElementById('toggle-musicxml-btn');
        this.musicXmlInputBox = document.getElementById('musicxml-input-box');
        this.musicXmlTextarea = document.getElementById('musicxml-textarea');
        this.renderMusicXmlBtn = document.getElementById('render-musicxml-btn');
        this.loadSampleXmlBtn = document.getElementById('load-sample-xml-btn');
        this.resetLiveXmlBtn = document.getElementById('reset-live-xml-btn');
        this.musicXmlFileInput = document.getElementById('musicxml-file-input');
        this.imslpResults = document.getElementById('imslp-results');
        this.freeSheetSources = document.getElementById('free-sheet-sources');
        this.focusMessage = document.getElementById('focus-message');
        this.idleHint = document.getElementById('idle-hint');
        this.micStatusBadges = document.querySelectorAll('[data-mic-status]');

        this.tunerLiveKey = document.getElementById('tuner-live-key');
        this.tunerLiveChord = document.getElementById('tuner-live-chord');
        this.songLiveKey = document.getElementById('song-live-key');
        this.songLiveChord = document.getElementById('song-live-chord');
        this.songCover = document.getElementById('song-cover');

        this.vizSettingsBtn = document.getElementById('viz-settings-btn');
        this.vizSettingsPanel = document.getElementById('visualizer-settings-panel');
        this.closeVizSettingsBtn = document.getElementById('close-viz-settings');
        this.styleButtons = document.querySelectorAll('[data-viz-style]');
        this.paletteButtons = document.querySelectorAll('[data-viz-palette]');
        this.sensitivitySlider = document.getElementById('viz-sensitivity');
        this.sensitivityValue = document.getElementById('viz-sensitivity-value');

        this.currentSong = null;
        this._sheetCacheKey = null;
        this.microphoneAccessGranted = false;
        this.isIdentifying = false;
        this._notificationTimer = null;
        this._harmonyInterval = null;

        this.bindEvents();
        this.syncVisualizerSettingsUI();
    }

    syncVisualizerSettingsUI() {
        this.styleButtons.forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.vizStyle === this.visualizer.style);
        });
        this.paletteButtons.forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.vizPalette === this.visualizer.palette);
        });
        if (this.sensitivitySlider) {
            this.sensitivitySlider.value = String(this.visualizer.sensitivity);
        }
        if (this.sensitivityValue) {
            this.sensitivityValue.textContent = `${this.visualizer.sensitivity.toFixed(1)}x`;
        }
    }

    toggleVisualizerSettings(forceOpen) {
        if (!this.vizSettingsPanel) return;
        const shouldOpen = typeof forceOpen === 'boolean'
            ? forceOpen
            : this.vizSettingsPanel.classList.contains('hidden');
        this.vizSettingsPanel.classList.toggle('hidden', !shouldOpen);
        if (this.vizSettingsBtn) {
            this.vizSettingsBtn.classList.toggle('is-active', shouldOpen);
            this.vizSettingsBtn.setAttribute('aria-expanded', String(shouldOpen));
        }
    }

    bindEvents() {
        this.startBtn.addEventListener('click', () => this.startApp());
        this.identifyBtn.addEventListener('click', () => this.handleIdentify());

        if (this.tunerFeatureBtn) {
            this.tunerFeatureBtn.addEventListener('click', () => this.activateTuner());
        }
        if (this.identifyFeatureBtn) {
            this.identifyFeatureBtn.addEventListener('click', () => this.activateIdentifySong());
        }
        if (this.backToModesBtn) {
            this.backToModesBtn.addEventListener('click', () => this.returnToModes());
        }
        if (this.returnStartBtn) {
            this.returnStartBtn.addEventListener('click', () => this.returnToStartScreen());
        }
        if (this.retryMicBtn) {
            this.retryMicBtn.addEventListener('click', () => this.retryMicrophone());
        }

        if (this.vizSettingsBtn) {
            this.vizSettingsBtn.addEventListener('click', () => this.toggleVisualizerSettings());
        }
        if (this.closeVizSettingsBtn) {
            this.closeVizSettingsBtn.addEventListener('click', () => this.toggleVisualizerSettings(false));
        }

        this.styleButtons.forEach((btn) => {
            btn.addEventListener('click', () => {
                this.visualizer.setStyle(btn.dataset.vizStyle);
                this.syncVisualizerSettingsUI();
            });
        });

        this.paletteButtons.forEach((btn) => {
            btn.addEventListener('click', () => {
                this.visualizer.setPalette(btn.dataset.vizPalette);
                this.syncVisualizerSettingsUI();
            });
        });

        if (this.sensitivitySlider) {
            this.sensitivitySlider.addEventListener('input', (e) => {
                this.visualizer.setSensitivity(e.target.value);
                if (this.sensitivityValue) {
                    this.sensitivityValue.textContent = `${this.visualizer.sensitivity.toFixed(1)}x`;
                }
            });
        }

        this.closeModalBtn.addEventListener('click', () => this.hideModal());
        if (this.closeModalXBtn) {
            this.closeModalXBtn.addEventListener('click', () => this.hideModal());
        }
        if (this.resultMainBtn) {
            this.resultMainBtn.addEventListener('click', () => {
                this.hideModal();
                this.returnToModes();
            });
        }

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (!this.modal.classList.contains('hidden')) {
                    this.hideModal();
                } else if (this.vizSettingsPanel && !this.vizSettingsPanel.classList.contains('hidden')) {
                    this.toggleVisualizerSettings(false);
                }
            }
        });

        if (this.sheetMusicBtn) {
            this.sheetMusicBtn.addEventListener('click', () => this.toggleSheetMusicPanel());
        }
        if (this.toggleMusicXmlBtn) {
            this.toggleMusicXmlBtn.addEventListener('click', () => {
                if (!this.musicXmlInputBox) return;
                const shouldOpen = this.musicXmlInputBox.classList.contains('hidden');
                this.musicXmlInputBox.classList.toggle('hidden', !shouldOpen);
                this.toggleMusicXmlBtn.classList.toggle('is-active', shouldOpen);
                this.toggleMusicXmlBtn.setAttribute('aria-expanded', String(shouldOpen));
            });
        }
        if (this.loadSampleXmlBtn) {
            this.loadSampleXmlBtn.addEventListener('click', () => {
                const sample = this.musicXmlRenderer.getSampleMusicXML();
                if (this.musicXmlTextarea) this.musicXmlTextarea.value = sample;
                this.renderRawMusicXML(sample);
            });
        }
        if (this.renderMusicXmlBtn) {
            this.renderMusicXmlBtn.addEventListener('click', () => {
                const raw = this.musicXmlTextarea ? this.musicXmlTextarea.value : '';
                this.renderRawMusicXML(raw);
            });
        }
        if (this.resetLiveXmlBtn) {
            this.resetLiveXmlBtn.addEventListener('click', () => {
                if (this.musicXmlTextarea) this.musicXmlTextarea.value = '';
                if (this.currentSong && !this.currentSong.error) {
                    this.renderLeadSheet(this.currentSong.key, this.currentSong.chords);
                }
            });
        }
        if (this.musicXmlFileInput) {
            this.musicXmlFileInput.addEventListener('change', (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                    const text = typeof reader.result === 'string' ? reader.result : '';
                    if (this.musicXmlTextarea) this.musicXmlTextarea.value = text;
                    this.renderRawMusicXML(text);
                };
                reader.readAsText(file);
                e.target.value = '';
            });
        }
    }

    startHarmonyLoop() {
        if (this._harmonyInterval !== null) return;
        this._harmonyInterval = setInterval(() => {
            if (!this.microphoneAccessGranted || document.hidden) return;
            this.harmonyAnalyzer.update(this.isIdentifying);

            const key = this.harmonyAnalyzer.liveKey;
            const chord = this.harmonyAnalyzer.liveChord;
            if (this.tunerLiveKey) this.tunerLiveKey.textContent = key;
            if (this.tunerLiveChord) this.tunerLiveChord.textContent = chord;
            if (this.songLiveKey) this.songLiveKey.textContent = key;
            if (this.songLiveChord) this.songLiveChord.textContent = chord;
            this.tuner.updateLiveChordMatch(chord, this.harmonyAnalyzer.smoothChroma);
        }, 120);
    }

    updateMicIndicators(granted) {
        this.microphoneAccessGranted = granted;
        this.micStatusBadges.forEach((badge) => {
            badge.textContent = granted ? 'MIC ACTIVE' : 'MIC DENIED';
            badge.classList.toggle('is-muted', !granted);
        });
        if (this.retryMicBtn) {
            this.retryMicBtn.classList.toggle('hidden', granted);
        }
        if (granted) {
            this.startHarmonyLoop();
        }
    }

    async retryMicrophone() {
        const success = await this.audioController.init();
        this.updateMicIndicators(success);
        if (success) {
            this.showNotification('Microphone enabled.');
        } else {
            this.showNotification('Microphone access still blocked in browser permissions.');
        }
    }

    async startApp() {
        const success = await this.audioController.init();
        this.startOverlay.classList.add('hidden');
        this.featureSelection.classList.remove('hidden');
        this.visualizer.start();
        this.updateMicIndicators(success);

        if (!success) {
            this.showNotification("Microphone access denied. Song identification and tuner disabled.");
        }
    }

    async handleIdentify() {
        if (this.isIdentifying) return;
        this.isIdentifying = true;
        this.identifyBtn.disabled = true;
        if (this.idleHint) this.idleHint.classList.add('hidden');
        this.focusMessage.classList.remove('hidden');

        try {
            const result = await this.recognitionService.identify((status) => {
                this.focusMessage.textContent = status;
            });
            this.showResult(result);
        } catch (err) {
            this.showResult({ error: true, message: err.message || "Identification failed." });
        } finally {
            this.identifyBtn.disabled = false;
            this.focusMessage.textContent = "LISTENING...";
            this.focusMessage.classList.add('hidden');
            if (this.idleHint) this.idleHint.classList.remove('hidden');
            this.isIdentifying = false;
        }
    }

    showResult(song) {
        this.currentSong = song;
        this._sheetCacheKey = null;

        if (this.sheetMusicPanel) {
            this.sheetMusicPanel.classList.add('hidden');
        }
        if (this.sheetMusicBtn) {
            this.sheetMusicBtn.setAttribute('aria-expanded', 'false');
            this.sheetMusicBtn.textContent = 'Free Sheet Music';
        }
        if (this.musicXmlInputBox) {
            this.musicXmlInputBox.classList.add('hidden');
        }
        if (this.toggleMusicXmlBtn) {
            this.toggleMusicXmlBtn.classList.remove('is-active');
            this.toggleMusicXmlBtn.setAttribute('aria-expanded', 'false');
        }
        if (this.musicXmlTextarea) {
            this.musicXmlTextarea.value = '';
        }

        if (this.songCover) {
            if (!song.error && song.coverArt) {
                this.songCover.src = song.coverArt;
                this.songCover.classList.remove('hidden');
            } else {
                this.songCover.classList.add('hidden');
                this.songCover.removeAttribute('src');
            }
        }

        if (song.error) {
            document.getElementById('song-title').textContent = "No Match Found";
            document.getElementById('artist-name').textContent = song.message;
            document.getElementById('release-date').textContent = "---";
            document.getElementById('song-key').textContent = song.key || "--";
            document.getElementById('song-chords').textContent = song.chords || "--";
            document.getElementById('song-description').textContent = "Live harmony analysis captured from your microphone.";
            if (this.sheetMusicBtn) this.sheetMusicBtn.disabled = true;
            if (this.youtubeLinkBtn) {
                this.youtubeLinkBtn.classList.add('hidden');
                this.youtubeLinkBtn.removeAttribute('href');
            }
        } else {
            document.getElementById('song-title').textContent = song.title;
            document.getElementById('artist-name').textContent = song.artist;
            document.getElementById('release-date').textContent = song.date;
            document.getElementById('song-key').textContent = song.key || "--";
            document.getElementById('song-chords').textContent = song.chords || "--";
            document.getElementById('song-description').textContent = song.description || "Identified via open-source fingerprinting.";
            if (this.sheetMusicBtn) this.sheetMusicBtn.disabled = false;

            if (this.youtubeLinkBtn) {
                const ytUrl = song.youtubeUrl || song.youtubeSearchUrl;
                if (ytUrl) {
                    this.youtubeLinkBtn.href = ytUrl;
                    this.youtubeLinkBtn.classList.remove('hidden');
                    if (this.youtubeLinkLabel) {
                        this.youtubeLinkLabel.textContent = song.youtubeUrl ? 'Watch on YouTube' : 'Search on YouTube';
                    }
                } else {
                    this.youtubeLinkBtn.classList.add('hidden');
                    this.youtubeLinkBtn.removeAttribute('href');
                }
            }
        }

        this.modal.classList.remove('hidden');
    }

    hideModal() {
        this.modal.classList.add('hidden');
    }

    async toggleSheetMusicPanel() {
        if (!this.currentSong || this.currentSong.error || !this.sheetMusicPanel) return;

        const isHidden = this.sheetMusicPanel.classList.contains('hidden');
        this.sheetMusicPanel.classList.toggle('hidden', !isHidden);
        if (this.sheetMusicBtn) {
            this.sheetMusicBtn.setAttribute('aria-expanded', String(isHidden));
            this.sheetMusicBtn.textContent = isHidden ? 'Hide Sheet Music' : 'Free Sheet Music';
        }

        if (!isHidden) return;

        this.renderLeadSheet(this.currentSong.key, this.currentSong.chords);

        const cacheKey = `${this.currentSong.title}::${this.currentSong.artist}`;
        if (this._sheetCacheKey === cacheKey) return;
        this._sheetCacheKey = cacheKey;

        this.renderFallbackFreeSources(this.currentSong.title, this.currentSong.artist);
        if (this.imslpResults) {
            this.imslpResults.textContent = 'Searching IMSLP public-domain archive...';
        }

        try {
            const params = new URLSearchParams({
                title: this.currentSong.title || '',
                artist: this.currentSong.artist || '',
            });
            const response = await fetch(`/api/sheet-music?${params.toString()}`);
            if (!response.ok) throw new Error('Sheet music lookup failed');
            const data = await response.json();

            if (Array.isArray(data.sources)) {
                this.renderFreeSourceLinks(data.sources);
            }
            this.renderImslpMatches(data.imslpMatches || []);
        } catch {
            if (this.imslpResults) {
                this.imslpResults.textContent = 'Could not reach IMSLP right now — use the direct free library links below.';
            }
        }
    }

    renderImslpMatches(matches) {
        if (!this.imslpResults) return;
        this.imslpResults.textContent = '';

        if (!matches.length) {
            const note = document.createElement('span');
            note.textContent = 'No exact public-domain match in IMSLP (modern tracks use the live chord staff above).';
            this.imslpResults.appendChild(note);
            return;
        }

        for (const item of matches) {
            const link = document.createElement('a');
            link.className = 'imslp-match-link';
            link.href = item.url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';

            const titleSpan = document.createElement('span');
            titleSpan.textContent = item.title;
            const arrowSpan = document.createElement('span');
            arrowSpan.textContent = 'Open PDF \u2197';

            link.appendChild(titleSpan);
            link.appendChild(arrowSpan);
            this.imslpResults.appendChild(link);
        }
    }

    renderFallbackFreeSources(title, artist) {
        const cleanArtist = artist && artist !== 'Unknown Artist' ? artist : '';
        const query = [title, cleanArtist].filter(Boolean).join(' ');
        const encodedFull = encodeURIComponent(query);
        const encodedTitle = encodeURIComponent(title || query);

        this.renderFreeSourceLinks([
            {
                name: 'IMSLP (Petrucci)',
                badge: 'Free PDFs',
                url: `https://imslp.org/index.php?title=Special:Search&search=${encodedTitle}`,
            },
            {
                name: 'Mutopia Project',
                badge: 'Open LilyPond',
                url: `https://www.mutopiaproject.org/cgibin/make-table.cgi?searchingfor=${encodedTitle}`,
            },
            {
                name: 'Musopen',
                badge: 'Public Domain',
                url: `https://musopen.org/music/?q=${encodedFull}`,
            },
            {
                name: 'Wikimedia Scores',
                badge: 'Open Commons',
                url: `https://commons.wikimedia.org/w/index.php?search=${encodeURIComponent(`${query} sheet music`)}&title=Special:MediaSearch&type=other`,
            },
        ]);
    }

    renderFreeSourceLinks(sources) {
        if (!this.freeSheetSources) return;
        this.freeSheetSources.textContent = '';

        for (const src of sources) {
            const link = document.createElement('a');
            link.className = 'free-source-link';
            link.href = src.url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';

            const nameEl = document.createElement('span');
            nameEl.className = 'free-source-name';
            nameEl.textContent = `${src.name} \u2197`;

            const metaEl = document.createElement('span');
            metaEl.className = 'free-source-meta';
            metaEl.textContent = src.badge || 'Free Sheet Music';

            link.appendChild(nameEl);
            link.appendChild(metaEl);
            this.freeSheetSources.appendChild(link);
        }
    }

    parseChordNotes(chordLabel) {
        const match = /^([A-G])(#?)(m|7)?$/.exec(chordLabel.trim());
        if (!match) return null;

        const [, letter, sharp, quality] = match;
        const noteList = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const rootIdx = noteList.indexOf(`${letter}${sharp}`);
        if (rootIdx === -1) return null;

        const intervals = quality === 'm' ? [0, 3, 7] : quality === '7' ? [0, 4, 7, 10] : [0, 4, 7];
        const diatonicMap = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };

        const notes = [];
        let lastStep = -1;
        let octave = 4;

        for (const interval of intervals) {
            const pc = (rootIdx + interval) % 12;
            const name = noteList[pc];
            const baseLetter = name[0];
            let step = diatonicMap[baseLetter] + (octave - 4) * 7;
            if (step <= lastStep) {
                octave += 1;
                step += 7;
            }
            if (step > 11) {
                step -= 7;
            }
            lastStep = step;
            notes.push({
                name,
                sharp: name.includes('#'),
                step, // 0 = C4 (ledger), 2 = E4 (bottom line), 10 = F5 (top line)
            });
        }

        return { label: chordLabel, notes };
    }

    renderRawMusicXML(rawXml) {
        if (!this.leadSheetStaff || !this.leadSheetNotes) return;
        try {
            const parsed = this.musicXmlRenderer.renderMusicXML(rawXml, this.leadSheetStaff);
            if (parsed) {
                const summary = `${parsed.title}${parsed.composer ? ` — ${parsed.composer}` : ''} (${parsed.measures.length} measure${parsed.measures.length === 1 ? '' : 's'})`;
                this.leadSheetNotes.textContent = summary;
            }
        } catch (err) {
            this.leadSheetStaff.textContent = '';
            this.leadSheetNotes.textContent = `MusicXML Error: ${err.message}`;
        }
    }

    renderLeadSheet(keyStr, chordsStr) {
        if (!this.leadSheetStaff || !this.leadSheetNotes) return;
        const xml = this.musicXmlRenderer.chordProgressionToMusicXML(
            keyStr,
            chordsStr,
            this.currentSong?.title || 'Detected Lead Sheet'
        );
        if (this.musicXmlTextarea && !this.musicXmlTextarea.value.trim()) {
            this.musicXmlTextarea.value = xml;
        }

        try {
            this.musicXmlRenderer.renderMusicXML(xml, this.leadSheetStaff);
            const rawChords = (chordsStr && chordsStr !== '--' && chordsStr !== 'Undetermined')
                ? chordsStr.split(/\s*-\s*/).map((c) => this.parseChordNotes(c)).filter(Boolean).slice(0, 4)
                : [];
            this.leadSheetNotes.textContent = rawChords.length > 0
                ? rawChords.map((c) => `${c.label}: ${c.notes.map((n) => n.name).join('-')}`).join('  |  ')
                : 'Tip: Live chords played during identification render here via MusicXML + VexFlow, or click Import XML.';
        } catch (err) {
            this.leadSheetStaff.textContent = '';
            this.leadSheetNotes.textContent = err.message;
        }
    }

    showNotification(message) {
        const existing = document.querySelector('.notification');
        if (existing && existing.parentNode) {
            existing.parentNode.removeChild(existing);
        }
        if (this._notificationTimer) {
            clearTimeout(this._notificationTimer);
        }

        const notification = document.createElement('div');
        notification.className = 'notification';
        notification.textContent = message;
        document.body.appendChild(notification);

        this._notificationTimer = setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
            this._notificationTimer = null;
        }, 5000);
    }

    activateTuner() {
        if (!this.microphoneAccessGranted) {
            this.showNotification("Microphone access is required for the tuner. Please allow microphone access.");
            return;
        }
        this.featureSelection.classList.add('hidden');
        this.interface.classList.add('hidden');
        this.tuner.activate();
    }

    activateIdentifySong() {
        this.featureSelection.classList.add('hidden');
        this.interface.classList.remove('hidden');
    }

    returnToModes() {
        this.toggleVisualizerSettings(false);
        this.tuner.deactivate();
        this.interface.classList.add('hidden');
        this.featureSelection.classList.remove('hidden');
    }

    returnToStartScreen() {
        this.toggleVisualizerSettings(false);
        this.tuner.deactivate();
        this.interface.classList.add('hidden');
        this.featureSelection.classList.add('hidden');
        this.startOverlay.classList.remove('hidden');
    }
}

const initNeonProtostar = () => {
    new UIController();
};

if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', initNeonProtostar, { once: true });
} else {
    initNeonProtostar();
}

export {};

