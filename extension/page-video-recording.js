// Self-contained: Chrome injects this function into the selected frame's isolated world.
export async function controlPageVideo(request) {
  const key = Symbol.for('VideoHarbor.videoRecording');
  const SLICE_BYTES = 192 * 1024, MAX_CHUNK = 4 * 1024 * 1024, MAX_QUEUE = 8 * 1024 * 1024;
  const LEASE_MS = 15000, MAX_MS = 30 * 60 * 1000;
  const commands = ['inspect', 'prepare', 'poll', 'start', 'pause', 'resume', 'stop', 'close'];
  if (!request || !commands.includes(request.command) || !/^[a-f0-9-]{36}$/.test(request.token || '')) {
    return {error: '動画録画の指定が不正です。'};
  }
  let session = globalThis[key];
  const status = value => ({
    state: value.recorder.state, available: !value.closed && !value.failure && !value.stopped,
    audio: value.audio, audioReason: value.audioReason || '', target: value.title, mimeType: value.recorder.mimeType,
    reason: value.reason || '', failure: value.failure || '', done: value.stopped && !value.queue.length && !value.pending,
  });
  if (request.command === 'inspect' || request.command === 'prepare') {
    if (request.command === 'prepare' && session && !session.closed) return {error: 'このページではすでに動画の録画を準備中か録画中です。停止してから再試行してください。'};
    const ref = request.reference, discovery = document.__videoHarborDiscovery;
    const video = discovery?.elements?.get(ref?.elementToken);
    if (!ref || discovery?.token !== ref.frameToken || document.URL !== ref.documentURL
      || video?.tagName !== 'VIDEO' || !video.isConnected) {
      return {error: '選んだ動画が見つかりません。元ページで再スキャンしてください。'};
    }
    const sourceAttributes = () => [video.getAttribute('src'),
      ...Array.from(video.querySelectorAll?.('source') || [], node => node.getAttribute('src'))];
    const scannedSource = discovery.videoSources?.get(ref.elementToken);
    if (scannedSource && !scannedSource.currentSrc && !scannedSource.srcObject && !scannedSource.attributes) {
      return {error: '選んだ動画の確認情報が古いため、元ページで再スキャンして選び直してください。'};
    }
    if (scannedSource && ((scannedSource.currentSrc && scannedSource.currentSrc !== video.currentSrc) || scannedSource.srcObject !== video.srcObject
      || (scannedSource.attributes && JSON.stringify(scannedSource.attributes) !== JSON.stringify(sourceAttributes())))) {
      return {error: '選んだ動画の再生元が変わりました。再スキャンして選び直してください。'};
    }
    if (video.mediaKeys) return {error: '保護された動画は動画だけの録画に対応していません。'};
    if (request.command === 'inspect') return {
      currentTime: Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : null,
      duration: Number.isFinite(video.duration) ? video.duration : null,
      paused: Boolean(video.paused), ended: Boolean(video.ended),
    };
    const before = {currentSrc: video.currentSrc, srcObject: video.srcObject, attributes: JSON.stringify(sourceAttributes())};
    const sourceChangedWhileLoading = () => !video.isConnected || video.mediaKeys || video.srcObject !== before.srcObject
      || (before.currentSrc && video.currentSrc !== before.currentSrc)
      || JSON.stringify(sourceAttributes()) !== before.attributes;
    if (video.ended) {
      if (!request.restart) return {error: '動画の再生が終了しました。開始位置を確認して、もう一度録画を開始してください。'};
      try { video.currentTime = 0; } catch { return {error: '動画を先頭に戻せませんでした。元ページで開始位置を確認してください。'}; }
    }
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight || video.seeking) {
      const preload = video.getAttribute('preload');
      const changedPreload = video.readyState < 2 && video.preload !== 'auto';
      try {
        if (changedPreload) video.preload = 'auto';
        const ready = await new Promise(resolve => {
          const deadline = Date.now() + 3000;
          const check = () => {
            if (sourceChangedWhileLoading() || video.error) return resolve(false);
            if (video.readyState >= 2 && video.videoWidth && video.videoHeight && !video.seeking) return resolve(true);
            if (Date.now() >= deadline) return resolve(false);
            setTimeout(check, 50);
          };
          check();
        });
        if (!ready) return {error: '動画の読み込みを準備できませんでした。元ページで動画を読み込み、もう一度録画を開始してください。'};
      } finally {
        // Only undo our own preload hint; preserve a site's concurrent choice.
        if (changedPreload && video.preload === 'auto') {
          if (preload === null) video.removeAttribute('preload'); else video.setAttribute('preload', preload);
        }
      }
    }
    if (sourceChangedWhileLoading()) return {error: '選んだ動画の再生元が変わりました。再スキャンして選び直してください。'};
    if (typeof video.captureStream !== 'function' || typeof MediaRecorder !== 'function'
      || !['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].includes(request.mimeType)
      || !MediaRecorder.isTypeSupported(request.mimeType)) {
      return {error: 'この環境では動画だけのWebM録画を利用できません。'};
    }
    let stream, rawStream;
    const protectedTracks = new Set(), rawOwnedTracks = new Set(), recordingTracks = [];
    const rememberInputTracks = () => {
      try { for (const track of video.srcObject?.getTracks?.() || []) protectedTracks.add(track); } catch {}
    };
    const rememberRawTracks = () => {
      rememberInputTracks();
      for (const track of rawStream?.getTracks() || []) if (!protectedTracks.has(track)) rawOwnedTracks.add(track);
    };
    const stopOwnedTracks = () => {
      rememberRawTracks();
      for (const track of recordingTracks) { try { track.stop(); } catch {} }
      for (const track of rawOwnedTracks) if (!protectedTracks.has(track)) { try { track.stop(); } catch {} }
    };
    try {
      // Some browsers return the original srcObject tracks from captureStream.
      // Never remove or stop those tracks: recording owns independent clones.
      rememberInputTracks(); rawStream = video.captureStream(); rememberRawTracks();
      const rawTracks = rawStream.getTracks();
      for (const track of rawTracks) recordingTracks.push(track.clone());
      stream = new MediaStream(recordingTracks);
      if (!stream.getVideoTracks().some(track => track.readyState === 'live' && !track.muted)) {
        throw new Error('Unavailable video');
      }
      const audioBlocked = Boolean(request.audio && (video.muted || video.volume === 0));
      for (const track of stream.getAudioTracks()) {
        // An explicit no-audio decision must remain silent even if a currently
        // muted captured track later unmutes while the user is deciding.
        if (!request.audio || audioBlocked || track.readyState !== 'live' || track.muted) { stream.removeTrack(track); track.stop(); }
      }
      const recorder = new MediaRecorder(stream, {mimeType: request.mimeType, videoBitsPerSecond: 4000000});
      session = {token: request.token, video, stream, recorder, reference: ref, audioReason: audioBlocked ? '元動画がミュートまたは音量0です。音声を含めるには元ページで音を出してから選び直してください。' : '', audio: stream.getAudioTracks().some(track => track.readyState === 'live' && !track.muted),
        title: String(ref.title || video.getAttribute('aria-label') || video.getAttribute('title') || '選んだ動画').slice(0, 160),
        currentSrc: video.currentSrc, srcObject: video.srcObject, queue: [], queuedBytes: 0, pending: null,
        nextSequence: 1, lastAck: 0, stopped: false, closed: false, failure: '', reason: '', listeners: [],
        activeMs: 0, activeAt: null, started: false, leaseAt: Date.now()};
      const value = session, expectedTracks = new Set(rawStream.getTracks());
      const observedRawTracks = rawTracks.filter((track, index) => stream.getTracks().includes(recordingTracks[index]));
      const tracksChanged = () => {
        const tracks = rawStream.getTracks();
        return tracks.length !== expectedTracks.size || tracks.some(track => !expectedTracks.has(track));
      };
      const listen = (target, type, listener) => { target.addEventListener(type, listener); value.listeners.push([target, type, listener]); };
      const stopTracks = stopOwnedTracks;
      const removeListeners = () => { for (const [target, type, listener] of value.listeners) target.removeEventListener(type, listener); value.listeners = []; };
      const pauseStartedSource = () => {
        // Only pause the source this recording actually started. Inspection-only
        // preparation and a replacement video must keep their playback state.
        if (!value.started || value.sourcePauseAttempted) return;
        value.sourcePauseAttempted = true;
        if (!video.isConnected || document.URL !== ref.documentURL
          || video.currentSrc !== value.currentSrc || video.srcObject !== value.srcObject
          || JSON.stringify(sourceAttributes()) !== before.attributes || video.paused || video.ended) return;
        try { video.pause(); }
        catch { value.reason = [value.reason, '元動画を一時停止できませんでした。元ページで停止してください。'].filter(Boolean).join(' '); }
      };
      value.dispose = () => {
        if (value.closed) return;
        value.closed = true; clearInterval(value.timer); removeListeners();
        try { if (recorder.state !== 'inactive') recorder.stop(); } catch {}
        pauseStartedSource();
        stopTracks(); value.queue = []; value.pending = null; value.queuedBytes = 0;
        if (globalThis[key] === value) delete globalThis[key];
      };
      value.stop = (reason = '', failure = '') => {
        value.reason ||= reason; value.failure ||= failure; value.stopping = true;
        if (value.activeAt !== null) { value.activeMs += performance.now() - value.activeAt; value.activeAt = null; }
        if (!value.started) { value.stopped = true; stopTracks(); return; }
        if (recorder.state !== 'inactive') {
          try { recorder.stop(); } catch { value.failure ||= '動画の録画を正常に終了できませんでした。'; value.stopped = true; stopTracks(); }
        }
        pauseStartedSource();
      };
      const sourceChanged = () => video.currentSrc !== value.currentSrc || video.srcObject !== value.srcObject || !video.isConnected || Boolean(video.mediaKeys);
      value.check = () => {
        if (value.closed || value.stopped || value.stopping || (value.started && recorder.state === 'inactive')) return;
        if (sourceChanged()) value.stop('動画の再生元が変わったため停止しました。');
        else if (video.ended) value.stop('動画の再生が終了したため停止しました。');
        else if (tracksChanged()) value.stop('動画の映像・音声構成が変わったため停止しました。');
        else if (observedRawTracks.some(track => track.readyState !== 'live' || track.muted)) value.stop('', '動画の映像または音声を取得できなくなりました。配信元の制限を確認してください。');
        else if (value.audio && (video.muted || video.volume === 0)) value.stop('', '元動画がミュートまたは音量0になったため停止しました。音声のある状態で選び直してください。');
      };
      listen(recorder, 'dataavailable', event => {
        if (value.closed || !event.data?.size) return;
        if (event.data.size > MAX_CHUNK || value.queuedBytes + event.data.size > MAX_QUEUE) {
          value.stop('', '動画データの転送が追いつかないため停止しました。取得済みデータを確認してください。'); return;
        }
        value.queue.push({blob: event.data, offset: 0}); value.queuedBytes += event.data.size;
      });
      listen(recorder, 'stop', () => { value.stopped = true; pauseStartedSource(); stopTracks(); });
      listen(recorder, 'error', () => value.stop('', '動画の録画中にエラーが発生しました。'));
      listen(video, 'ended', () => value.stop('動画の再生が終了したため停止しました。'));
      listen(video, 'volumechange', value.check);
      for (const event of ['emptied', 'loadstart', 'encrypted']) listen(video, event, () => {
        if (!value.stopping && !value.stopped) value.stop('動画の再生元が変わったため停止しました。');
      });
      for (const track of observedRawTracks) {
        listen(track, 'ended', () => {
          if (value.closed || value.stopped || (value.started && recorder.state === 'inactive')) return;
          value.stop(video.ended ? '動画の再生が終了したため停止しました。' : '', video.ended ? '' : '動画の映像または音声の取得が終了しました。');
        });
        listen(track, 'mute', value.check);
      }
      // captureStream and our deliberate audio removal queue initial track events.
      // An event alone is not evidence that the final prepared track set changed.
      for (const event of ['addtrack', 'removetrack']) listen(rawStream, event, () => { rememberRawTracks(); value.check(); });
      listen(globalThis, 'pagehide', () => value.dispose());
      value.timer = setInterval(() => {
        if (Date.now() - value.leaseAt >= LEASE_MS) { value.dispose(); return; }
        value.check();
        const active = value.activeMs + (value.activeAt === null ? 0 : performance.now() - value.activeAt);
        if (active >= MAX_MS) value.stop('録画時間が30分に達したため自動停止しました。');
      }, 1000);
      globalThis[key] = value;
    } catch {
      stopOwnedTracks();
      return {error: 'この動画の映像を取得できません。配信元の制限や保護により動画だけの録画を利用できない場合があります。'};
    }
    return status(session);
  }
  if (!session || session.token !== request.token || session.closed) return {error: '動画録画の接続が終了しました。取得済みデータを確認し、元ページからやり直してください。'};
  session.leaseAt = Date.now();
  if (request.command === 'close') { session.dispose(); return {closed: true}; }
  session.check();
  if (request.command === 'start') {
    if (session.started || session.stopped || session.failure || session.video.ended) {
      return {error: '選んだ動画を録画できません。開始位置を確認して、もう一度録画を開始してください。'};
    }
    const value = session;
    if (value.video.paused) {
      const position = value.video.currentTime;
      const rate = Number.isFinite(value.video.playbackRate) ? Math.max(0, value.video.playbackRate) : 1;
      let playRequestedAt, sought = false;
      const onSeek = () => { sought = true; };
      const positionChanged = (anchor, forwardAllowance = 0.05) => sought || value.video.seeking
        || (Number.isFinite(anchor) && Number.isFinite(value.video.currentTime)
          && (value.video.currentTime < anchor - 0.05 || value.video.currentTime > anchor + forwardAllowance));
      const ownsPlayback = () => value.video.isConnected && value.video.currentSrc === value.currentSrc && value.video.srcObject === value.srcObject;
      const pauseOwnedPlayback = () => { if (ownsPlayback()) { try { value.video.pause(); } catch {} } };
      let timer, failed = false, onPlay;
      const startupErrors = new Set([
        '動画の再生元が変わりました。選び直してください。',
        '動画の再生位置が変わりました。開始位置を確認して、もう一度録画を開始してください。',
        '動画の録画開始を中止しました。',
        '動画の映像・音声構成が変わりました。選び直してください。',
        '動画の録画を開始できませんでした。',
      ]);
      const cleanup = () => {
        const current = globalThis[key];
        if (current?.token === value.token) current.dispose();
      };
      // Chrome's old element-capture listeners can recreate audio providers on
      // the next play after EOS, stealing audio from a stream prepared earlier.
      // Recapture in the real play event after those listeners. Chrome can
      // rebase a resumed media clock by about 60 ms even with no seek. Keep the
      // opening strict, allow a bounded correction at an already confirmed
      // mid-video position, and keep capture preparation bounded to 50 ms.
      const recording = new Promise((resolve, reject) => {
        onPlay = () => {
          if (failed || !ownsPlayback()) { reject(new Error('動画の再生元が変わりました。選び直してください。')); return; }
          const elapsed = Math.max(0, performance.now() - playRequestedAt) / 1000;
          const resumeAllowance = position > 0.05 ? 0.1 : 0.05;
          if (positionChanged(position, elapsed * rate + resumeAllowance)) {
            reject(new Error('動画の再生位置が変わりました。開始位置を確認して、もう一度録画を開始してください。')); return;
          }
          const playPosition = value.video.currentTime;
          controlPageVideo({command:'prepare',token:value.token,reference:value.reference,
            audio:value.audio,mimeType:value.recorder.mimeType}).then(prepared => {
            const next = globalThis[key];
            if (failed) { cleanup(); throw new Error('動画の録画開始を中止しました。'); }
            if (prepared.error) throw new Error(prepared.error);
            if (positionChanged(playPosition)) {
              cleanup(); throw new Error('動画の再生位置が変わりました。開始位置を確認して、もう一度録画を開始してください。');
            }
            if (!next || !prepared.available || next.audio !== value.audio
              || next.stream.getVideoTracks().length !== value.stream.getVideoTracks().length
              || next.stream.getAudioTracks().length !== value.stream.getAudioTracks().length) {
              cleanup(); throw new Error('動画の映像・音声構成が変わりました。選び直してください。');
            }
            return controlPageVideo({command:'start',token:value.token});
          }).then(started => {
            if (started.error || started.state !== 'recording') throw new Error(started.error || '動画の録画を開始できませんでした。');
            resolve();
          }, reject).catch(reject);
        };
        value.video.addEventListener('seeking', onSeek);
        value.video.addEventListener('seeked', onSeek);
        value.video.addEventListener('play', onPlay, {once:true});
      });
      // Release the inspection-only streams before play; the replacement owns
      // fresh recording clones. srcObject input tracks remain protected.
      value.dispose();
      try {
        let playback;
        playRequestedAt = performance.now();
        try { playback = Promise.resolve(value.video.play()); } catch (error) { playback = Promise.reject(error); }
        playback.then(() => { if (failed) pauseOwnedPlayback(); }, () => {});
        await Promise.race([Promise.all([recording, playback]),new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('元動画を自動再生できませんでした。サイトの再生許可や読み込み状態を確認して、もう一度お試しください。')),3000);
        })]);
        session = globalThis[key];
        if (!session || session.token !== value.token || session.closed || session.stopped || session.failure || session.video.paused) {
          throw new Error('元動画を自動再生できませんでした。サイトの再生許可や読み込み状態を確認して、もう一度お試しください。');
        }
      } catch (error) {
        failed = true; pauseOwnedPlayback(); cleanup();
        return {error: startupErrors.has(error?.message) ? error.message : '元動画を自動再生できませんでした。サイトの再生許可や読み込み状態を確認して、もう一度お試しください。'};
      } finally {
        clearTimeout(timer); value.video.removeEventListener('play', onPlay);
        value.video.removeEventListener('seeking', onSeek); value.video.removeEventListener('seeked', onSeek);
      }
    } else {
      try { value.recorder.start(500); value.started = true; value.activeAt = performance.now(); }
      catch { value.stop('', '動画の録画を開始できませんでした。'); return {error: value.failure}; }
    }
  } else if (request.command === 'pause') {
    if (session.recorder.state !== 'recording') return {error: '動画の録画を一時停止できませんでした。'};
    session.recorder.pause();
    session.activeMs += performance.now() - session.activeAt; session.activeAt = null;
  } else if (request.command === 'resume') {
    if (session.recorder.state !== 'paused') return {error: '動画の録画を再開できませんでした。'};
    session.recorder.resume(); session.activeAt = performance.now();
  } else if (request.command === 'stop') session.stop();
  if (request.command !== 'poll') return status(session);
  const ack = request.ack;
  if (!Number.isSafeInteger(ack) || ack < 0 || ack > (session.pending?.sequence || session.lastAck)) return {error: '動画データの受領確認が不正です。'};
  if (session.pending && ack === session.pending.sequence) {
    const head = session.queue[0]; head.offset += session.pending.size;
    // A partially acknowledged Blob still retains all its storage until shifted.
    if (head.offset === head.blob.size) { session.queue.shift(); session.queuedBytes -= head.blob.size; }
    session.lastAck = ack; session.pending = null;
  } else if (ack !== session.lastAck) return {error: '動画データの順序を確認できませんでした。'};
  if (!session.pending && session.queue.length) {
    const head = session.queue[0], data = new Uint8Array(await head.blob.slice(head.offset, head.offset + SLICE_BYTES).arrayBuffer());
    let text = '';
    for (let index = 0; index < data.length; index += 4096) text += String.fromCharCode(...data.subarray(index, index + 4096));
    session.pending = {sequence: session.nextSequence++, size: data.byteLength, base64: btoa(text)};
  }
  return {...status(session), ...(session.pending ? {chunk: session.pending} : {})};
}
