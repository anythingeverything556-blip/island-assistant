/* Voice: push-to-talk recording, a live (always-open) microphone with turn detection
   and barge-in, and a sentence-queue speaker. Audio goes out as 16 kHz mono WAV. */
window.Voice = (() => {
  const api = () => window.islandApi;

  // ---------------------------------------------------------------- shared audio helpers

  function rmsOf(d) {
    let sum = 0;
    for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
    return Math.sqrt(sum / d.length);
  }

  function merge(chunks) {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Float32Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  function downsample(data, from, to) {
    if (from === to) return data;
    const ratio = from / to;
    const out = new Float32Array(Math.floor(data.length / ratio));
    for (let i = 0; i < out.length; i++) {
      const a = Math.floor(i * ratio);
      const b = Math.min(data.length, Math.floor((i + 1) * ratio));
      let s = 0;
      for (let j = a; j < b; j++) s += data[j];
      out[i] = s / Math.max(1, b - a);
    }
    return out;
  }

  function toWavBase64(samples, sampleRate) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(buf);
    const str = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
    str(0, 'RIFF');
    v.setUint32(4, 36 + samples.length * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    str(36, 'data');
    v.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  // PCM (any sample rate) -> base64 16 kHz WAV, the format sent for transcription.
  function encode(pcm, sampleRate) {
    return toWavBase64(downsample(pcm, sampleRate, 16000), 16000);
  }

  // The microphone to use ('' = Windows' default). Set from Settings → Voice.
  let deviceId = '';
  const constraints = (id) => ({ audio: { ...(id ? { deviceId: { exact: id } } : {}), channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });

  async function openMic(onFrame) {
    // Echo cancellation also removes Island's own voice, because the speaker below
    // plays through this page.
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints(deviceId));
    } catch (e) {
      // The chosen mic was unplugged: fall back to the default one.
      if (!deviceId || !/Overconstrained|NotFound|NotReadable/.test(e.name)) throw e;
      stream = await navigator.mediaDevices.getUserMedia(constraints(''));
    }
    const ctx = new AudioContext();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const source = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(2048, 1, 1);
    proc.onaudioprocess = (e) => onFrame(new Float32Array(e.inputBuffer.getChannelData(0)), ctx.sampleRate);
    source.connect(proc);
    proc.connect(ctx.destination);
    const track = stream.getAudioTracks()[0];
    return {
      rate: ctx.sampleRate,
      label: track?.label || 'your microphone',
      async close() {
        proc.disconnect();
        source.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        await ctx.close();
      },
    };
  }

  // Plain-words reason a microphone couldn't be opened.
  function micError(e) {
    const n = String(e?.name || e || '');
    if (/NotAllowed|denied|Permission/i.test(n)) return "Windows is blocking the microphone. Open Windows Settings → Privacy & security → Microphone, and turn on “Microphone access” and “Let desktop apps access your microphone”.";
    if (/NotFound|Overconstrained/i.test(n)) return 'No microphone found. Plug one in (or a headset), then try again.';
    if (/NotReadable|TrackStart|Abort/i.test(n)) return 'The microphone is busy or not working. Close other apps using it (Zoom, Teams, Discord), or pick another one in Settings → Voice.';
    return `The microphone couldn't start (${n || 'unknown error'}).`;
  }

  async function listMics() {
    const all = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    return all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications').map((d) => ({ id: d.deviceId === 'default' ? '' : d.deviceId, label: d.label || 'Microphone' }));
  }

  // Settings' "Test microphone": a few seconds of levels. Resolves { peak, heard, label }.
  async function testMic(id, onLevel, ms = 6000) {
    const prev = deviceId;
    deviceId = id;
    let peak = 0, floor = null, heardAt = 0;
    const t0 = performance.now();
    let mic;
    try {
      mic = await openMic((d) => {
        const r = rmsOf(d);
        peak = Math.max(peak, r);
        if (performance.now() - t0 < 400) floor = floor === null ? r : Math.min(floor, r);
        onLevel?.(Math.min(1, r / 0.12), r);
        if (!heardAt && r > Math.max(0.009, (floor ?? 0.003) * 3)) heardAt = performance.now();
      });
    } finally {
      deviceId = prev;
    }
    await new Promise((res) => {
      const iv = setInterval(() => {
        // Stop early once speech has been heard for a moment.
        if (performance.now() - t0 > ms || (heardAt && performance.now() - heardAt > 1200)) { clearInterval(iv); res(); }
      }, 100);
    });
    await mic.close();
    return { peak, heard: !!heardAt, label: mic.label };
  }

  // ---------------------------------------------------------------- push-to-talk

  let ptt = null;

  // opts: { onLevel(0..1), onAutoStop(reason) }
  async function start(opts = {}) {
    if (ptt) return;
    const st = { t0: performance.now(), floor: null, floorSamples: [], speech: false, silent: 0, stopped: false, chunks: [], ...opts };
    ptt = st;
    st.mic = await openMic((d, rate) => {
      st.rate = rate;
      st.chunks.push(d);
      const rms = rmsOf(d);
      const elapsed = (performance.now() - st.t0) / 1000;
      if (elapsed < 0.35) st.floorSamples.push(rms);
      // The quietest early frame is the room; people often start talking straight away,
      // and averaging would mistake their voice for background noise.
      else if (st.floor === null) st.floor = Math.min(0.012, ...st.floorSamples, 0.012);
      const threshold = Math.max(0.009, (st.floor ?? 0.004) * 3);
      if (rms > threshold) {
        st.speech = true;
        st.silent = 0;
      } else st.silent += d.length / rate;
      st.onLevel?.(Math.min(1, rms / Math.max(threshold * 4, 0.05)));
      if (st.stopped) return;
      const auto = (r) => { st.stopped = true; st.onAutoStop?.(r); };
      if (st.speech && st.silent > 1.4) auto('done');
      else if (!st.speech && elapsed > 8) auto('silence');
      else if (elapsed > 90) auto('limit');
    }).catch((e) => {
      ptt = null;
      throw e;
    });
  }

  // Stops recording; resolves { wav, seconds, speech }.
  async function stop() {
    const st = ptt;
    if (!st) return null;
    ptt = null;
    await st.mic.close();
    const down = downsample(merge(st.chunks), st.rate || 48000, 16000);
    let peak = 0;
    for (const c of st.chunks) peak = Math.max(peak, rmsOf(c));
    return { wav: toWavBase64(down, 16000), seconds: down.length / 16000, speech: st.speech, peak, label: st.mic.label };
  }

  const active = () => !!ptt;

  // ---------------------------------------------------------------- live microphone

  // Stays open for a whole conversation. While armed it records one utterance at a
  // time and hands it over when you pause; while the assistant speaks it only listens
  // for you talking over it (barge-in).
  const Live = (() => {
    let mic = null;
    let st = null;

    async function open(cb) {
      if (mic) return;
      st = { cb, armed: false, barge: false, speech: false, silent: 0, loud: 0, chunks: [], pre: [], floor: 0.004, len: 0, pause: 0.9, t0: performance.now(), peak: 0, warned: false };
      mic = await openMic((d, rate) => frame(d, rate));
      st.label = mic.label;
    }

    function frame(d, rate) {
      const secs = d.length / rate;
      st.rate = rate;
      const rms = rmsOf(d);
      st.peak = Math.max(st.peak, rms);
      // Nothing at all from the mic for a while (muted in Windows, wrong device, privacy
      // block that delivers silence): say so instead of "Listening" forever.
      if (!st.warned && st.armed && performance.now() - st.t0 > 6000 && st.peak < 0.0015) {
        st.warned = true;
        st.cb.onSilentMic?.(st.label);
      }
      // Track the room's noise floor whenever nobody is talking.
      if (!st.speech && st.loud === 0) st.floor = st.floor * 0.97 + Math.min(rms, 0.03) * 0.03;
      const threshold = Math.max(0.009, st.floor * 3);
      const bargeThreshold = Math.max(0.03, st.floor * 6);
      st.cb.onLevel?.(Math.min(1, rms / Math.max(threshold * 4, 0.06)));
      st.pre.push(d);
      if (st.pre.length > 8) st.pre.shift(); // ~0.35 s of pre-roll so first words aren't clipped

      if (st.armed) {
        if (!st.speech) {
          if (rms > threshold) {
            st.speech = true;
            st.chunks = [...st.pre];
            st.len = 0;
            st.silent = 0;
            st.cb.onSpeechStart?.();
            stream(st.chunks, rate);
          }
          return;
        }
        st.chunks.push(d);
        stream([d], rate);
        st.len += secs;
        st.silent = rms > threshold ? 0 : st.silent + secs;
        // A pause right after a short start ("um...", "so...") is usually thinking, not the end.
        const pause = st.pause + (st.len - st.silent < 1.2 ? 0.5 : 0);
        if (st.silent > pause || st.len > 60) finish();
      } else if (st.barge) {
        st.loud = rms > bargeThreshold ? st.loud + secs : Math.max(0, st.loud - secs / 2);
        if (st.loud > 0.3) {
          // The user is talking over the assistant: stop it and take this as their turn.
          st.loud = 0;
          st.barge = false;
          st.armed = true;
          st.speech = true;
          st.chunks = [...st.pre];
          st.len = 0;
          st.silent = 0;
          st.cb.onBargeIn?.();
          stream(st.chunks, rate);
        }
      }
    }

    // Hands audio to a streaming transcriber as it's recorded (16 kHz 16-bit mono PCM).
    function stream(frames, rate) {
      if (!st.cb.onCapture) return;
      const pcm = downsample(merge(frames), rate, 16000);
      const out = new Int16Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) out[i] = Math.max(-1, Math.min(1, pcm[i])) * 0x7fff;
      st.cb.onCapture(out.buffer);
    }

    function finish() {
      const chunks = st.chunks;
      st.speech = false;
      st.armed = false;
      st.chunks = [];
      const pcm = merge(chunks);
      st.cb.onUtterance?.(encode(pcm, st.rate), pcm.length / st.rate);
    }

    return {
      open,
      arm() { if (st) { st.armed = true; st.barge = false; st.speech = false; } },
      disarm() { if (st) { st.armed = false; st.speech = false; } },
      bargeIn(on) { if (st) { st.barge = !!on; st.loud = 0; } },
      // How long a pause ends your turn (seconds).
      setPause(seconds) { if (st) st.pause = seconds; },
      // A streaming transcriber says the turn is over: end it now instead of waiting.
      endTurn() { if (st?.armed && st.speech && st.chunks.length) finish(); },
      isOpen: () => !!mic,
      async close() {
        const m = mic;
        mic = null;
        st = null;
        if (m) await m.close();
      },
    };
  })();

  // ---------------------------------------------------------------- speaker

  function plainForSpeech(md) {
    return md
      .replace(/```[\s\S]*?```/g, ' (code on screen) ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/^#+\s*/gm, '')
      .replace(/[*_>|~]/g, '')
      .replace(/^\s*[-•]\s+/gm, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Sentences are synthesised as soon as they arrive and played strictly in order.
  const Speaker = (() => {
    let ctx = null;
    let analyser = null;
    let gen = 0;
    let chain = Promise.resolve();
    let pending = 0;
    let current = null;
    let onState = null;
    let onMissing = null; // ({ missing, canInstall, onlineError }) when no voice could read a sentence's language
    let lang = ''; // the language the user last spoke (from transcription): a hint for which voice to use
    let onPlay = null; // a sentence started playing (for timing)
    let levelTimer = 0;

    function ensure() {
      if (ctx) return;
      ctx = new AudioContext();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.connect(ctx.destination);
    }

    function setBusy(b) {
      onState?.(b);
    }

    function say(text) {
      const clean = plainForSpeech(text);
      if (!clean) return;
      ensure();
      const g = gen;
      pending++;
      setBusy(true);
      const audio = api()
        .ttsSay(clean, lang)
        .then((r) => {
          if (r?.missing) onMissing?.(r);
          return r?.wav ? ctx.decodeAudioData(Uint8Array.from(atob(r.wav), (c) => c.charCodeAt(0)).buffer) : null;
        })
        .catch(() => null);
      chain = chain.then(async () => {
        const buf = await audio;
        if (g !== gen || !buf) return;
        await new Promise((resolve) => {
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(analyser);
          src.onended = resolve;
          current = { src, resolve };
          src.start();
          onPlay?.();
        });
        current = null;
      }).finally(() => {
        if (g !== gen) return;
        pending--;
        if (pending <= 0) {
          pending = 0;
          setBusy(false);
        }
      });
    }

    // A soft two-note "got it" the moment Island stops listening, so the wait for the
    // answer doesn't start with silence.
    function earcon() {
      ensure();
      const t = ctx.currentTime;
      [[660, 0], [880, 0.09]].forEach(([f, at]) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0, t + at);
        g.gain.linearRampToValueAtTime(0.05, t + at + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.16);
        o.connect(g).connect(ctx.destination);
        o.start(t + at);
        o.stop(t + at + 0.18);
      });
    }

    function stop() {
      gen++;
      pending = 0;
      chain = Promise.resolve();
      try { current?.src.stop(); } catch {}
      current?.resolve();
      current = null;
      setBusy(false);
    }

    // Output level 0..1 while speaking (for the live orb).
    function level() {
      if (!analyser || !current) return 0;
      const data = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += ((v - 128) / 128) ** 2;
      return Math.min(1, Math.sqrt(sum / data.length) * 4);
    }

    return { say, stop, level, onState: (fn) => (onState = fn), onMissing: (fn) => (onMissing = fn), setLang: (l) => (lang = l || ''), onPlay: (fn) => (onPlay = fn), earcon, busy: () => pending > 0 };
  })();

  // Whole-answer convenience for "speak replies": split into sentences and queue.
  function speak(markdown) {
    let text = plainForSpeech(markdown);
    if (!text) return;
    if (text.length > 900) text = text.slice(0, 900).replace(/[^.!?।。！？]*$/, '') + ' The rest is on screen.';
    for (const s of text.match(/[^.!?।॥。！？]+[.!?।॥。！？]+["')\]”’」]*\s*|[^.!?।॥。！？]+$/g) || [text]) Speaker.say(s);
  }

  const hush = () => Speaker.stop();

  return { start, stop, active, encode, Live, Speaker, speak, hush, plainForSpeech, micError, listMics, testMic, setDevice: (id) => (deviceId = id || '') };
})();
