const MEMORY_STOP_BYTES = 256 * 1024 * 1024;
const WRITE_QUEUE_STOP_BYTES = 32 * 1024 * 1024;
const MAX_ACTIVE_MS = 30 * 60 * 1000;
const BUSY_PHASES = new Set(['starting', 'awaiting-audio-decision', 'recording', 'paused', 'finalizing', 'saving']);

function recordingName(title) {
  let part = String(title || '録画').normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '_')
    .replace(/^\.+|[.\s]+$/g, '').trim();
  part = Array.from(part).slice(0, 80).join('') || '録画';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) part = `_${part}`;
  return `${part}-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`;
}

function supportedMime() {
  return ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find((type) => globalThis.MediaRecorder?.isTypeSupported(type));
}

function cancellation(error) {
  return error?.name === 'AbortError' || error?.name === 'NotAllowedError' ||
    /USER_CANCELED|USER_CANCELLED|cancelled|canceled/i.test(error?.message || '');
}

function safeError(error) {
  // Browser error messages can contain page URLs; show a small, stable explanation instead.
  const explanations = {
    NotAllowedError: '共有の許可が得られませんでした。',
    NotFoundError: '録画できる映像が見つかりません。',
    NotReadableError: '映像を取得できません。OSの画面収録権限も確認してください。',
    InvalidStateError: '開始できませんでした。画面を開いた状態でもう一度操作してください。',
    NotSupportedError: 'この環境は指定した録画形式に対応していません。',
    SecurityError: 'ブラウザの制限により操作できませんでした。',
  };
  if(error?.name === 'CaptureControlError') return String(error.message).replace(/(?:https?|blob|data):\S+/g,'[URL]').slice(0,180);
  return explanations[error?.name] || '操作に失敗しました。もう一度お試しください。';
}

function displayTarget(stream) {
  const surface = stream.getVideoTracks()[0]?.getSettings?.().displaySurface;
  return { browser: '共有ダイアログで選んだタブ', window: '共有ダイアログで選んだウィンドウ',
    monitor: '共有ダイアログで選んだ画面' }[surface] || '共有ダイアログで選んだ対象';
}

/** Media lifetime stays in this visible extension page, never in the service worker. */
export class RecorderController {
  constructor({ onUpdate = () => {}, source = {}, acquire, release }) {
    this.onUpdate = onUpdate;
    this.source = source;
    this.acquire = acquire;
    this.release = release;
    this._phase = 'idle';
    this._message = '対象と音声、保存方法を選んで録画を開始してください。形式はWebMです。';
    this._pendingOutputHandle = null;
    this._result = null;
    this._session = null;
    this._pendingStart = null;
    this._startingPromise = null;
    this._choosing = false;
    this._heartbeat = null;
  }

  get busy() { return this._choosing || BUSY_PHASES.has(this._phase); }
  get stream() { return this._session?.stream || this._pendingStart?.stream || null; }

  snapshot() {
    const value = this._session || this._pendingStart || this._result;
    return {
      phase: this._phase,
      method: value?.method || '',
      target: value?.target || '',
      audio: Boolean(value?.audio),
      audioRequested: Boolean(value?.audioRequested),
      bytes: value?.bytes || 0,
      elapsed: this._session ? this._elapsed(this._session) : value?.elapsed || 0,
      fileName: value?.fileName || this._pendingOutputHandle?.name || '',
      message: this._message,
      resultReady: Boolean(this._result),
      resultSaved: Boolean(this._result?.saved),
      diskChosen: Boolean(this._pendingOutputHandle),
      chosenFileName: this._pendingOutputHandle?.name || '',
      downloadId: this._result?.downloadId ?? null,
      resultPlaybackAvailable: Boolean(this._result?.blob || this._result?.readHandle),
      diskAvailable: typeof globalThis.showSaveFilePicker === 'function',
      mime: value?.mime || 'video/webm',
      format: 'WebM',
      playbackBlocked: this._session?.audioContext?.state === 'suspended',
    };
  }

  _emit() {
    try { this.onUpdate(this.snapshot()); } catch { /* UI failures must not leak capture resources. */ }
  }

  _restingPhase() {
    return this._result ? (this._result.saved ? 'saved' : 'ready') : 'idle';
  }

  _refuse(message) {
    this._message = message;
    this._emit();
    return false;
  }

  async chooseFile() {
    if (this.busy) return this._refuse('録画や保存が終了してから保存先を変更してください。');
    if (typeof globalThis.showSaveFilePicker !== 'function') {
      return this._refuse('この環境ではファイルへ直接記録できません。メモリ保存を選んでください。');
    }
    this._choosing = true;
    try {
      // Invoke the picker before the first await to preserve this click's activation.
      const handle = await globalThis.showSaveFilePicker({
        suggestedName: recordingName(this.source.title),
        types: [{ description: 'WebM 動画', accept: { 'video/webm': ['.webm'] } }],
      });
      this._pendingOutputHandle = handle;
      this._message = `保存先を選びました: ${handle.name}。録画を開始すると記録します。`;
      return true;
    } catch (error) {
      this._message = cancellation(error)
        ? '保存先の選択をキャンセルしました。以前の保存先と録画は保持しています。'
        : safeError(error);
      return false;
    } finally {
      this._choosing = false;
      this._emit();
    }
  }

  start(mode, audio, output) {
    if (this.busy) return Promise.resolve(this._refuse('録画や保存の処理中です。終了するまでお待ちください。'));
    if (this._result?.blob && !this._result.saved) {
      return Promise.resolve(this._refuse('前の録画を保存するか、破棄してから新しい録画を開始してください。'));
    }
    if (!['tab', 'display'].includes(mode) || !['memory', 'file'].includes(output)) {
      return Promise.resolve(this._refuse('録画対象と保存方法を選んでください。'));
    }
    if (output === 'file' && !this._pendingOutputHandle) {
      return Promise.resolve(this._refuse('先に保存先のファイルを選んでください。'));
    }
    const mime = supportedMime();
    if (!mime || !globalThis.navigator?.mediaDevices) {
      return Promise.resolve(this._refuse('この環境ではWebMの録画を利用できません。'));
    }
    const op = { mode, audio: false, audioRequested: Boolean(audio), output, mime, cancelled: false, locked: false,
      outputHandle: output === 'file' ? this._pendingOutputHandle : null,
      stream: null, writable: null, audioContext: null, trackListeners: [],
      method: mode, target: mode === 'tab' ? (this.source.title || '元のタブ') : '',
      fileName: output === 'file' ? this._pendingOutputHandle.name : recordingName(this.source.title) };
    op.cancellation = new Promise((resolve) => { op.resolveCancellation = resolve; });
    this._pendingStart = op;
    this._phase = 'starting';
    this._message = '録画の準備中です。共有する対象を確認してください。';
    let capturePromise;
    try {
      if (mode === 'display') {
        // No lock, messaging or disk await may precede this call in the click handler.
        capturePromise = navigator.mediaDevices.getDisplayMedia({
          video: true, audio: op.audioRequested, selfBrowserSurface: 'exclude',
          systemAudio: op.audioRequested ? 'include' : 'exclude',
        });
      }
    } catch (error) {
      capturePromise = Promise.reject(error);
    }
    this._startingPromise = this._begin(op, capturePromise);
    this._emit();
    return this._startingPromise;
  }

  _cancelPending(op, message = '') {
    if (op.cancelled) return;
    op.cancelled = true;
    op.cancelMessage = message;
    op.resolveCancellation();
    op.resolveAudioDecision?.(false);
    // In the audio decision state sharing is already active. End it immediately.
    for (const track of op.stream?.getTracks() || []) {
      try { track.stop(); } catch { /* Stop the remaining tracks as well. */ }
    }
  }

  _checkStart(op) {
    if (op.cancelled) throw new DOMException('Cancelled', 'AbortError');
    if (!op.stream.getVideoTracks().some((track) => track.readyState !== 'ended')) {
      throw new DOMException('Sharing stopped', 'NotReadableError');
    }
  }

  async _capture(op, capturePromise) {
    const capture = Promise.resolve(capturePromise);
    // A native picker cannot be dismissed programmatically. If it resolves after cancellation,
    // dispose of that late stream without resurrecting the cancelled operation.
    capture.then((media) => {
      if (op.cancelled && op.stream !== media) {
        for (const track of media.getTracks()) {
          try { track.stop(); } catch { /* Stop all late capture tracks. */ }
        }
      }
    }, () => {});
    op.stream = await Promise.race([capture, op.cancellation.then(() => {
      throw new DOMException('Cancelled', 'AbortError');
    })]);
    this._checkStart(op);
    for (const track of op.stream.getTracks()) {
      const ended = () => this._cancelPending(op, '共有が終了したため、録画の開始を中止しました。');
      track.addEventListener('ended', ended, { once: true });
      op.trackListeners.push([track, ended]);
    }
    op.target = op.mode === 'tab' ? (this.source.title || '元のタブ') : displayTarget(op.stream);
    op.audio = op.stream.getAudioTracks().some((track) => track.readyState !== 'ended');
  }

  async _begin(op, capturePromise) {
    try {
      if (op.mode === 'display') {
        await this._capture(op, capturePromise);
        await this.acquire('display');
        op.locked = true;
      } else {
        const grant = await this.acquire('tab');
        op.locked = true;
        if (op.cancelled) throw new DOMException('Cancelled', 'AbortError');
        if (!grant?.streamId) throw new DOMException('Missing stream ID', 'NotReadableError');
        // The one-use ID expires within seconds: consume it immediately, without other work.
        const constraints = { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: grant.streamId } };
        await this._capture(op, navigator.mediaDevices.getUserMedia({
          video: constraints, audio: op.audioRequested ? constraints : false,
        }));
      }
      this._checkStart(op);
      if (op.audioRequested && !op.audio) {
        this._phase = 'awaiting-audio-decision';
        this._message = '音声を取得できませんでした。共有中ですが、まだ録画していません。音声なしで続けるか、対象を選び直してください。';
        const decision = new Promise((resolve) => { op.resolveAudioDecision = resolve; });
        this._emit();
        if (!await decision) throw new DOMException('Cancelled', 'AbortError');
        op.resolveAudioDecision = null;
        this._phase = 'starting';
        this._message = '音声なしで録画を開始しています。';
        this._emit();
      }
      this._checkStart(op);
      if (op.output === 'file') {
        // A chosen destination is single-use, including failed attempts to open its writer.
        // Capture/decision cancellation above leaves the unused selection intact.
        if (this._pendingOutputHandle === op.outputHandle) this._pendingOutputHandle = null;
        op.writerAttempted = true;
        const opening = Promise.resolve(op.outputHandle.createWritable());
        this._emit();
        opening.then((writable) => {
          if (op.cancelled && op.writable !== writable) Promise.resolve().then(() => writable.abort()).catch(() => {});
        }, () => {});
        op.writable = await Promise.race([opening, op.cancellation.then(() => {
          throw new DOMException('Cancelled', 'AbortError');
        })]);
      }
      this._checkStart(op);
      const session = {
        ...op, recorder: null, bytes: 0, chunks: [], pendingBytes: 0,
        writeChain: Promise.resolve(), failure: null, activeAt: null, elapsed: 0,
        trackListeners: [], finalPromise: null,
      };
      session.stopped = new Promise((resolve) => { session.resolveStopped = resolve; });
      const recorder = new MediaRecorder(op.stream, { mimeType: op.mime, videoBitsPerSecond: 4_000_000 });
      session.recorder = recorder;
      session.mime = recorder.mimeType || op.mime;
      recorder.addEventListener('dataavailable', (event) => this._chunk(session, event.data));
      recorder.addEventListener('stop', () => {
        session.resolveStopped();
        void this._finish(session);
      });
      recorder.addEventListener('error', () => {
        session.failure ||= '録画中にエラーが発生しました。';
        void this._finish(session);
      });
      recorder.start(1000);
      session.activeAt = performance.now();
      this._removeTrackListeners(op);
      for (const track of op.stream.getTracks()) {
        const ended = () => {
          session.stopReason ||= '共有が終了したため録画を停止しました。';
          void this._finish(session);
        };
        track.addEventListener('ended', ended, { once: true });
        session.trackListeners.push([track, ended]);
      }
      this._session = session;
      // Keep the previous result until both capture and MediaRecorder.start have succeeded.
      this._result = null;
      this._pendingStart = null;
      this._phase = 'recording';
      this._message = session.audio ? 'WebMで録画中です。' : 'WebMで録画中です。音声は含まれていません。';
      if (op.mode === 'tab' && session.audio) this._restoreTabAudio(session);
      this._heartbeat = setInterval(() => {
        if (this._elapsed(session) >= MAX_ACTIVE_MS) {
          session.stopReason = '録画時間が30分に達したため自動停止しました。';
          void this._finish(session);
        }
        this._emit();
      }, 1000);
      this._emit();
      return true;
    } catch (error) {
      this._removeTrackListeners(op);
      const releaseFailed = await this._cleanupResources(op);
      this._phase = this._restingPhase();
      this._message = (cancellation(error) || op.cancelled)
        ? (op.cancelMessage || (op.writerAttempted
          ? '録画の開始をキャンセルしました。前の録画は保持しています。次の録画では保存先を選び直してください。'
          : '録画の開始をキャンセルしました。前の録画と未使用の保存先は保持しています。'))
        : `${safeError(error)} 対象タブで拡張機能を開き直すと再試行できます。`;
      if (!cancellation(error) && !op.cancelled && !this._result) this._phase = 'error';
      if (op.writerAttempted && !(cancellation(error) || op.cancelled)) {
        this._message += ' 次の録画では保存先を選び直してください。';
      }
      if (releaseFailed) this._message += ' 録画制御の解除を確認できませんでした。次の開始前にこの画面を開き直してください。';
      return false;
    } finally {
      this._pendingStart = null;
      this._startingPromise = null;
      this._emit();
    }
  }

  continueWithoutAudio() {
    const op = this._pendingStart;
    if (this._phase !== 'awaiting-audio-decision' || !op || op.cancelled) return false;
    op.resolveAudioDecision?.(true);
    return true;
  }

  async cancelStart() {
    const op = this._pendingStart;
    if (!op) return false;
    this._cancelPending(op);
    this._message = '録画の開始を中止しています。';
    this._emit();
    await this._startingPromise;
    return true;
  }

  _restoreTabAudio(session) {
    try {
      const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Context) throw new Error('No AudioContext');
      session.audioContext = new Context();
      session.audioContext.createMediaStreamSource(session.stream).connect(session.audioContext.destination);
      // Some browsers keep resume pending until another user gesture; never block capture on it.
      Promise.resolve(session.audioContext.resume()).then(() => this._emit(), () => {});
      if (session.audioContext.state === 'suspended') {
        this._message += ' タブ音声の再生はブラウザに制限されています。一時停止後の再開で再試行できます。';
      }
    } catch {
      this._message += ' タブ音声をスピーカーに戻せませんでした。録画には音声を含めます。';
    }
  }

  _elapsed(session) {
    return Math.max(0, Math.round(session.elapsed + (session.activeAt === null ? 0 : performance.now() - session.activeAt)));
  }

  _freezeTime(session) {
    if (session.activeAt !== null) {
      session.elapsed += performance.now() - session.activeAt;
      session.activeAt = null;
    }
  }

  _chunk(session, blob) {
    if (!blob?.size) return;
    session.bytes += blob.size;
    if (session.output === 'file') {
      session.pendingBytes += blob.size;
      // MediaRecorder events do not await async handlers; a promise chain preserves file order.
      session.writeChain = session.writeChain.then(async () => {
        if (!session.failure) await session.writable.write(blob);
      }).catch(() => {
        session.failure ||= 'ファイルへの書き込みに失敗しました。';
        void this._finish(session);
      }).finally(() => { session.pendingBytes -= blob.size; });
      if (session.pendingBytes >= WRITE_QUEUE_STOP_BYTES) {
        session.stopReason = 'ファイルの書き込みが追いつかないため自動停止しました。';
        void this._finish(session);
      }
    } else {
      session.chunks.push(blob);
      if (session.bytes >= MEMORY_STOP_BYTES) {
        session.stopReason = '録画データが256MiBに達したため自動停止しました。最終データ分は超過する場合があります。';
        void this._finish(session);
      }
    }
    this._emit();
  }

  pause() {
    const session = this._session;
    if (this._phase !== 'recording' || !session) return false;
    try {
      session.recorder.pause();
      this._freezeTime(session);
      this._phase = 'paused';
      this._message = '録画を一時停止しています。共有自体は継続中です。';
      this._emit();
      return true;
    } catch { return this._refuse('一時停止できませんでした。停止して再試行してください。'); }
  }

  resume() {
    const session = this._session;
    if (this._phase !== 'paused' || !session) return false;
    try {
      session.recorder.resume();
      session.activeAt = performance.now();
      this._phase = 'recording';
      this._message = 'WebMの録画を再開しました。';
      if (session.audioContext?.state === 'suspended') {
        Promise.resolve(session.audioContext.resume()).then(() => this._emit(), () => {});
      }
      this._emit();
      return true;
    } catch { return this._refuse('再開できませんでした。停止して再試行してください。'); }
  }

  async stop() {
    if (this._pendingStart) return this.cancelStart();
    if (!this._session) return false;
    await this._finish(this._session);
    return true;
  }

  _finish(session) {
    // Install the shared promise before stop() can synchronously dispatch any mocked/browser event.
    if (!session.finalPromise) session.finalPromise = Promise.resolve().then(() => this._finalize(session));
    return session.finalPromise;
  }

  async _finalize(session) {
    this._phase = 'finalizing';
    this._message = '保存を確定中です。この画面を閉じないでください。';
    this._freezeTime(session);
    clearInterval(this._heartbeat);
    this._heartbeat = null;
    this._emit();
    if (session.recorder.state !== 'inactive') {
      try { session.recorder.stop(); }
      catch {
        session.failure ||= '録画を正常に終了できませんでした。';
        session.resolveStopped();
      }
    }
    // The final dataavailable event precedes stop; await it before reading the write chain.
    await session.stopped;
    this._removeTrackListeners(session);
    for (const track of session.stream.getTracks()) {
      try { track.stop(); } catch { /* Stop all remaining capture tracks as well. */ }
    }
    // Sharing ends promptly even if flushing the file takes longer.
    try { await session.audioContext?.close(); } catch { /* Media tracks have already stopped. */ }
    session.audioContext = null;
    await session.writeChain;
    if (session.output === 'file') {
      if (!session.failure) {
        try { await session.writable.close(); session.writable = null; }
        catch { session.failure = 'ファイルの保存を確定できませんでした。'; }
      }
      if (session.writable) {
        try { await session.writable.abort(); } catch { /* A partial/temp file may remain. */ }
        session.writable = null;
      }
    }
    const result = {
      method: session.method, target: session.target, audio: session.audio, audioRequested: session.audioRequested, bytes: session.bytes,
      elapsed: this._elapsed(session), fileName: session.fileName, mime: session.mime,
      saved: session.output === 'file' && !session.failure,
      readHandle: session.output === 'file' && !session.failure ? session.outputHandle : null,
      downloadId: null,
      blob: session.output === 'memory' && session.bytes
        ? new Blob(session.chunks, { type: session.mime }) : null,
    };
    session.chunks = [];
    const releaseFailed = await this._cleanupResources(session);
    this._session = null;
    this._result = result.saved || result.blob ? result : null;
    if (session.failure || (!result.saved && !result.blob)) {
      this._phase = 'error';
      this._message = session.failure || '録画データを取得できませんでした。';
      this._message += session.output === 'file'
        ? ' 不完全なファイルが残る場合があります。保存先を確認し、選び直してから録画してください。'
        : result.blob ? ' 取得済みデータを保存できます。再生できるかは未確認です。' : '';
    } else {
      this._phase = result.saved ? 'saved' : 'ready';
      this._message = result.saved ? 'ファイル保存完了。WebMの録画を保存しました。' : '録画できました。保存してください（WebM）。';
      if (session.stopReason) this._message = `${session.stopReason} ${this._message}`;
    }
    if (releaseFailed) this._message += ' 録画制御の解除を確認できませんでした。次の開始前にこの画面を開き直してください。';
    this._emit();
  }

  _removeTrackListeners(session) {
    for (const [track, listener] of session.trackListeners) track.removeEventListener('ended', listener);
    session.trackListeners = [];
  }

  async _cleanupResources(value) {
    for (const track of value.stream?.getTracks() || []) {
      try { track.stop(); } catch { /* Continue stopping the other tracks. */ }
    }
    try { await value.audioContext?.close(); } catch { /* Tracks already stopped. */ }
    if (value.writable) {
      try { await value.writable.abort(); } catch { /* Keep the failure visible in the result. */ }
      value.writable = null;
    }
    if (value.locked) {
      value.locked = false;
      try { await this.release(); } catch { return true; }
    }
    return false;
  }

  async getResultFile() {
    const result = this._result;
    if (result?.blob) return result.blob;
    // Only a successfully closed output handle is exposed for local playback.
    if (result?.saved && result.readHandle) return result.readHandle.getFile();
    return null;
  }

  async save() {
    if (this.busy) return this._refuse('録画や保存が終了するまでお待ちください。');
    const result = this._result;
    if (!result?.blob) return this._refuse(result?.saved ? 'この録画はファイルへ保存済みです。' : '保存できる録画がありません。');
    this._phase = 'saving';
    this._message = '録画の保存先を確認しています。';
    this._emit();
    const url = URL.createObjectURL(result.blob);
    let downloadId;
    let terminal = false;
    try {
      downloadId = await chrome.downloads.download({ url, filename: result.fileName, saveAs: true, conflictAction: 'uniquify' });
      const status = await this._waitForDownload(downloadId);
      terminal = true;
      if (status.state !== 'complete') throw new Error(status.error || 'DOWNLOAD_INTERRUPTED');
      result.saved = true;
      result.downloadId = downloadId;
      // The save dialog can rename the file. Keep only its basename in UI state.
      let finalName = status.filename;
      if (!finalName) {
        try {
          const [item] = await chrome.downloads.search({ id: downloadId });
          finalName = item?.filename;
        }
        catch { /* Completion is already confirmed; filename lookup must not undo it. */ }
      }
      if (finalName) result.fileName = String(finalName).split(/[\\/]/).at(-1) || result.fileName;
      this._phase = 'saved';
      this._message = 'ファイル保存完了。録画データはこの画面に保持しています。';
      return true;
    } catch (error) {
      this._phase = result.saved ? 'saved' : 'ready';
      this._message = cancellation(error)
        ? '保存をキャンセルしました。録画データは保持しています。'
        : '保存できませんでした。録画データは保持しています。保存先を確認して再試行してください。';
      return false;
    } finally {
      if (downloadId === undefined || terminal) URL.revokeObjectURL(url);
      else this._retainURLUntilTerminal(downloadId, url);
      this._emit();
    }
  }

  _waitForDownload(id) {
    return new Promise((resolve, reject) => {
      let finished = false;
      let checking = false;
      const finish = (value, error) => {
        if (finished) return;
        finished = true;
        clearInterval(timer);
        chrome.downloads.onChanged.removeListener(changed);
        error ? reject(error) : resolve(value);
      };
      const changed = (delta) => {
        if (delta.id === id && ['complete', 'interrupted'].includes(delta.state?.current)) {
          finish({ state: delta.state.current, error: delta.error?.current });
        }
      };
      const check = async () => {
        if (checking || finished) return;
        checking = true;
        try {
          const [item] = await chrome.downloads.search({ id });
          if (!item) finish({ state: 'interrupted', error: 'DOWNLOAD_REMOVED' });
          else if (['complete', 'interrupted'].includes(item.state)) finish(item);
        } catch (error) { finish(null, error); }
        finally { checking = false; }
      };
      const timer = setInterval(check, 500);
      chrome.downloads.onChanged.addListener(changed);
      void check(); // Reconcile an already-complete download missed before listener registration.
    });
  }

  _retainURLUntilTerminal(id, url) {
    // A search API failure does not prove the download stopped. Keep its Blob URL valid.
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const [item] = await chrome.downloads.search({ id });
        if (!item || ['complete', 'interrupted'].includes(item.state)) {
          clearInterval(timer);
          URL.revokeObjectURL(url);
        }
      } catch { /* Retry while the page remains open. */ }
      finally { checking = false; }
    };
    const timer = setInterval(check, 2000);
    void check();
  }

  discard() {
    if (this.busy) return this._refuse('録画や保存が終了してから破棄してください。');
    this._result = null;
    this._phase = 'idle';
    this._message = 'この画面の録画データを破棄しました。保存済みファイルは変更していません。';
    this._emit();
    return true;
  }
}
