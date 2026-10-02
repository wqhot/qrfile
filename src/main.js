import './styles.css';
import {
  compactFrameRanges,
  estimateFecRecoverable,
  mergeRecord,
  missingIndices,
  parityCount,
  parseTransportText,
  recoverFec,
  restoreSession,
} from './protocol.js';
import { clearStateDb, loadState, openStateDb, persistRecord } from './db.js';

const $ = (id) => document.getElementById(id);
const ui = {
  pwaBadge: $('pwaBadge'), installHint: $('installHint'), preview: $('preview'), canvas: $('captureCanvas'), viewerStatus: $('viewerStatus'),
  startCamera: $('startCamera'), stopSource: $('stopSource'), videoInput: $('videoInput'), photoInput: $('photoInput'),
  workerCount: $('workerCount'), scanWidth: $('scanWidth'), playbackRate: $('playbackRate'), sessionSelect: $('sessionSelect'),
  progressBar: $('progressBar'), receivedStat: $('receivedStat'), totalStat: $('totalStat'), missingStat: $('missingStat'), fecStat: $('fecStat'),
  parityStat: $('parityStat'), decodeRateStat: $('decodeRateStat'), fileIdText: $('fileIdText'), runFec: $('runFec'), restoreFile: $('restoreFile'),
  saveRestored: $('saveRestored'), exportMissing: $('exportMissing'), clearState: $('clearState'), restoreResult: $('restoreResult'),
  attemptsStat: $('attemptsStat'), validStat: $('validStat'), duplicateStat: $('duplicateStat'), errorStat: $('errorStat'), storageStat: $('storageStat'), log: $('log'),
};

const sessions = new Map();
let db = null;
let pool = null;
let currentFid = null;
let mediaStream = null;
let sourceMode = null; // camera | video
let objectVideoUrl = null;
let captureActive = false;
let captureRaf = 0;
let lastCaptureAt = 0;
let lastRestoredFile = null;
let persistChain = Promise.resolve();
const uniqueDecodeTimes = [];
const stats = { attempts: 0, valid: 0, duplicates: 0, errors: 0 };

function log(message, level = 'info') {
  const now = new Date().toLocaleTimeString();
  const line = `[${now}] ${message}`;
  const lines = ui.log.textContent ? ui.log.textContent.split('\n') : [];
  lines.push(line);
  while (lines.length > 80) lines.shift();
  ui.log.textContent = lines.join('\n');
  ui.log.scrollTop = ui.log.scrollHeight;
  if (level === 'error') console.error(message); else console.log(message);
}

function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function detectInstallHint() {
  const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  ui.pwaBadge.textContent = isStandalone() ? 'PWA' : 'Web';
  ui.installHint.classList.toggle('hidden', !(isiOS && !isStandalone()));
}

class DecoderPool {
  constructor(count, onLiveResult) {
    this.onLiveResult = onLiveResult;
    this.nextId = 1;
    this.waitQueue = [];
    this.slots = Array.from({ length: count }, () => this.makeSlot());
  }

  makeSlot() {
    const worker = new Worker(new URL('./scanner-worker.js', import.meta.url), { type: 'module' });
    const slot = { worker, busy: false, job: null };
    worker.onmessage = (event) => {
      const result = event.data;
      const job = slot.job;
      slot.busy = false;
      slot.job = null;
      if (job) {
        if (job.live) this.onLiveResult(result);
        else if (result.ok) job.resolve(result);
        else job.reject(new Error(result.error || 'decoder worker failed'));
      }
      this.drain();
    };
    worker.onerror = (event) => {
      const job = slot.job;
      slot.busy = false;
      slot.job = null;
      if (job && !job.live) job.reject(new Error(event.message || 'decoder worker error'));
      log(`解码 Worker 错误: ${event.message || 'unknown error'}`, 'error');
      this.drain();
    };
    return slot;
  }

  get idleSlot() { return this.slots.find((s) => !s.busy); }

  start(slot, job) {
    slot.busy = true;
    slot.job = job;
    if (job.kind === 'rgba') {
      slot.worker.postMessage({ id: job.id, kind: 'rgba', buffer: job.buffer, width: job.width, height: job.height }, [job.buffer]);
    } else {
      slot.worker.postMessage({ id: job.id, kind: 'blob', blob: job.blob });
    }
  }

  tryLive(imageData) {
    const slot = this.idleSlot;
    if (!slot) return false;
    const id = this.nextId++;
    this.start(slot, { id, kind: 'rgba', buffer: imageData.data.buffer, width: imageData.width, height: imageData.height, live: true });
    return true;
  }

  decodeRgba(imageData) {
    return new Promise((resolve, reject) => {
      const job = { id: this.nextId++, kind: 'rgba', buffer: imageData.data.buffer, width: imageData.width, height: imageData.height, live: false, resolve, reject };
      this.waitQueue.push(job);
      this.drain();
    });
  }

  decodeBlob(blob) {
    return new Promise((resolve, reject) => {
      this.waitQueue.push({ id: this.nextId++, kind: 'blob', blob, live: false, resolve, reject });
      this.drain();
    });
  }

  drain() {
    while (this.waitQueue.length) {
      const slot = this.idleSlot;
      if (!slot) break;
      this.start(slot, this.waitQueue.shift());
    }
  }

  terminate() {
    for (const slot of this.slots) slot.worker.terminate();
    for (const job of this.waitQueue) job.reject?.(new Error('decoder pool restarted'));
    this.waitQueue = [];
    this.slots = [];
  }
}

function rebuildPool() {
  const count = Number(ui.workerCount.value) || 2;
  if (pool) pool.terminate();
  pool = new DecoderPool(count, handleWorkerResult);
  log(`解码 Worker: ${count}`);
}

function recordForDb(record) {
  persistChain = persistChain.then(() => persistRecord(db, record)).catch((error) => {
    log(`保存中间结果失败: ${error.message}`, 'error');
  });
}

function handleTexts(texts, source = 'scan') {
  if (!texts?.length) return;
  for (const text of texts) {
    let record;
    try {
      record = parseTransportText(text);
      stats.valid++;
    } catch (error) {
      stats.errors++;
      updateDiagnostics();
      if (source !== 'live') log(`识别到 QR，但不是有效 QRFile 帧: ${error.message}`);
      continue;
    }
    try {
      const merged = mergeRecord(sessions, record);
      if (merged.added) {
        recordForDb(record);
        uniqueDecodeTimes.push(performance.now());
        if (!currentFid || currentFid !== record.fid) currentFid = record.fid;
        updateSessionSelector();
        updateUi();
      } else if (merged.duplicate) {
        stats.duplicates++;
      }
    } catch (error) {
      stats.errors++;
      log(`合并帧失败: ${error.message}`, 'error');
    }
  }
  updateDiagnostics();
}

function handleWorkerResult(result) {
  if (!result.ok) {
    log(`实时解码失败: ${result.error}`, 'error');
    updateDiagnostics();
    return;
  }
  handleTexts(result.texts, 'live');
}

function updateDiagnostics() {
  ui.attemptsStat.textContent = String(stats.attempts);
  ui.validStat.textContent = String(stats.valid);
  ui.duplicateStat.textContent = String(stats.duplicates);
  ui.errorStat.textContent = String(stats.errors);
}

function currentSession() {
  return currentFid ? sessions.get(currentFid) : null;
}

function updateSessionSelector() {
  const old = currentFid;
  ui.sessionSelect.innerHTML = '';
  const list = [...sessions.values()].sort((a, b) => a.fid.localeCompare(b.fid));
  if (!list.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '暂无数据';
    ui.sessionSelect.appendChild(opt);
    currentFid = null;
    return;
  }
  for (const s of list) {
    const opt = document.createElement('option');
    opt.value = s.fid;
    opt.textContent = `${s.fid.slice(0, 8)}…  ${s.parts.size}/${s.total}`;
    ui.sessionSelect.appendChild(opt);
  }
  currentFid = (old && sessions.has(old)) ? old : list[0].fid;
  ui.sessionSelect.value = currentFid;
}

function updateUi() {
  const session = currentSession();
  const now = performance.now();
  while (uniqueDecodeTimes.length && uniqueDecodeTimes[0] < now - 5000) uniqueDecodeTimes.shift();
  ui.decodeRateStat.textContent = (uniqueDecodeTimes.length / 5).toFixed(1);
  if (!session) {
    ui.receivedStat.textContent = '0';
    ui.totalStat.textContent = '0';
    ui.missingStat.textContent = '0';
    ui.fecStat.textContent = '0';
    ui.parityStat.textContent = '0';
    ui.progressBar.style.width = '0%';
    ui.fileIdText.textContent = 'file_id: -';
    return;
  }
  const missing = session.total - session.parts.size;
  const fec = estimateFecRecoverable(session);
  const pct = session.total ? (session.parts.size / session.total) * 100 : 0;
  ui.receivedStat.textContent = String(session.parts.size);
  ui.totalStat.textContent = String(session.total);
  ui.missingStat.textContent = String(missing);
  ui.fecStat.textContent = String(fec);
  ui.parityStat.textContent = String(parityCount(session));
  ui.progressBar.style.width = `${Math.min(100, pct).toFixed(2)}%`;
  ui.fileIdText.textContent = `file_id: ${session.fid}`;
}

async function updateStorageStat() {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est?.quota) return;
    const used = (est.usage || 0) / (1024 * 1024);
    const quota = est.quota / (1024 * 1024);
    ui.storageStat.textContent = `${used.toFixed(1)} / ${quota.toFixed(0)} MiB`;
  } catch (_) {}
}

function captureFrame() {
  if (!captureActive || !pool?.idleSlot || ui.preview.readyState < 2 || ui.preview.videoWidth < 1) return;
  const maxWidth = Number(ui.scanWidth.value) || 1280;
  const scale = Math.min(1, maxWidth / ui.preview.videoWidth);
  const width = Math.max(1, Math.round(ui.preview.videoWidth * scale));
  const height = Math.max(1, Math.round(ui.preview.videoHeight * scale));
  if (ui.canvas.width !== width || ui.canvas.height !== height) {
    ui.canvas.width = width;
    ui.canvas.height = height;
  }
  const ctx = ui.canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(ui.preview, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  if (pool.tryLive(imageData)) stats.attempts++;
}

function scanLoop(ts) {
  if (!captureActive) return;
  if (ts - lastCaptureAt >= 24) {
    lastCaptureAt = ts;
    captureFrame();
  }
  captureRaf = requestAnimationFrame(scanLoop);
}

function startScanLoop() {
  if (captureActive) return;
  captureActive = true;
  lastCaptureAt = 0;
  cancelAnimationFrame(captureRaf);
  captureRaf = requestAnimationFrame(scanLoop);
}

function stopScanLoop() {
  captureActive = false;
  cancelAnimationFrame(captureRaf);
}

async function stopSource() {
  stopScanLoop();
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) track.stop();
    mediaStream = null;
  }
  ui.preview.pause();
  ui.preview.srcObject = null;
  ui.preview.removeAttribute('src');
  ui.preview.load();
  ui.preview.controls = false;
  if (objectVideoUrl) {
    URL.revokeObjectURL(objectVideoUrl);
    objectVideoUrl = null;
  }
  sourceMode = null;
  ui.viewerStatus.textContent = '已停止';
}

async function startCamera() {
  await stopSource();
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持摄像头 API；请使用 HTTPS/Safari');
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30, max: 60 },
    },
  });
  ui.preview.srcObject = mediaStream;
  ui.preview.controls = false;
  await ui.preview.play();
  sourceMode = 'camera';
  ui.viewerStatus.textContent = '实时扫描中 · 尽量让屏幕与手机保持平行';
  try {
    const track = mediaStream.getVideoTracks()[0];
    const caps = track.getCapabilities?.();
    if (caps?.focusMode?.includes?.('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
  } catch (_) {}
  startScanLoop();
  log('摄像头已启动');
}

async function startVideoFile(file) {
  await stopSource();
  objectVideoUrl = URL.createObjectURL(file);
  ui.preview.src = objectVideoUrl;
  ui.preview.controls = true;
  ui.preview.muted = true;
  ui.preview.playsInline = true;
  await new Promise((resolve, reject) => {
    ui.preview.onloadedmetadata = resolve;
    ui.preview.onerror = () => reject(new Error('浏览器无法打开该视频'));
  });
  ui.preview.playbackRate = Number(ui.playbackRate.value) || 1;
  sourceMode = 'video';
  ui.viewerStatus.textContent = `视频扫描中 · ${formatDuration(ui.preview.duration)}`;
  ui.preview.onended = () => {
    stopScanLoop();
    ui.viewerStatus.textContent = '视频扫描完成';
    log('视频播放结束；可执行 FEC 或恢复文件');
  };
  await ui.preview.play();
  startScanLoop();
  log(`开始扫描视频: ${file.name}`);
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '-';
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function imageFileToImageData(file, maxWidth = 1920) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error(`浏览器无法解码图片 ${file.name}`));
    });
    const scale = Math.min(1, maxWidth / img.naturalWidth);
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function importPhotos(files) {
  const list = [...files];
  if (!list.length) return;
  log(`开始导入 ${list.length} 张照片`);
  let done = 0;
  let next = 0;
  const concurrency = Math.min(pool?.slots?.length || 1, list.length);

  async function consumer() {
    while (true) {
      const index = next++;
      if (index >= list.length) return;
      const file = list[index];
      try {
        // Bounded decode avoids materializing a large photo selection in memory at once on iOS.
        const imageData = await imageFileToImageData(file);
        const result = await pool.decodeRgba(imageData);
        stats.attempts++;
        handleTexts(result.texts, 'photo');
      } catch (error) {
        stats.errors++;
        log(`${file.name}: ${error.message}`, 'error');
      } finally {
        done++;
        ui.viewerStatus.textContent = `照片处理 ${done}/${list.length}`;
        updateDiagnostics();
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => consumer()));
  ui.viewerStatus.textContent = `照片导入完成 ${done}/${list.length}`;
  log('照片导入完成');
}

async function runFecForCurrent() {
  const session = currentSession();
  if (!session) throw new Error('没有可恢复的文件会话');
  const count = await recoverFec(session, async (record) => {
    await persistRecord(db, record);
  });
  updateSessionSelector();
  updateUi();
  log(`FEC 完成，恢复 ${count} 个数据帧`);
  return count;
}

function showResult(html, error = false) {
  ui.restoreResult.classList.remove('hidden');
  ui.restoreResult.classList.toggle('error', error);
  ui.restoreResult.innerHTML = html;
}

async function restoreCurrent() {
  const session = currentSession();
  if (!session) throw new Error('没有可恢复的文件会话');
  await runFecForCurrent();
  const missing = missingIndices(session);
  if (missing.length) {
    const ranges = compactFrameRanges(missing);
    showResult(`<b>仍缺 ${missing.length} 个数据 QR</b><br><span class="mono">${escapeHtml(ranges)}</span>`, true);
    throw new Error(`仍缺 ${missing.length} 帧`);
  }
  ui.viewerStatus.textContent = '正在校验并恢复文件…';
  const restored = await restoreSession(session);
  lastRestoredFile = new File([restored.data], restored.name, { type: 'application/octet-stream' });
  ui.saveRestored.disabled = false;
  showResult(`<b>恢复成功：${escapeHtml(restored.name)}</b><br>大小 ${formatBytes(restored.data.length)}<br><span class="mono">SHA-256 ${restored.sha256}</span>`);
  ui.viewerStatus.textContent = '文件恢复成功';
  log(`恢复成功: ${restored.name}, ${restored.data.length} bytes`);
}

async function saveRestored() {
  if (!lastRestoredFile) return;
  try {
    if (navigator.canShare?.({ files: [lastRestoredFile] })) {
      await navigator.share({ files: [lastRestoredFile], title: lastRestoredFile.name });
      return;
    }
  } catch (error) {
    if (error.name === 'AbortError') return;
    log(`系统分享失败，改用下载: ${error.message}`);
  }
  downloadBlob(lastRestoredFile, lastRestoredFile.name);
}

async function exportMissing() {
  const session = currentSession();
  if (!session) throw new Error('没有文件会话');
  await runFecForCurrent();
  const missing = missingIndices(session);
  if (!missing.length) {
    showResult('<b>没有缺帧</b>，可以直接恢复文件。');
    return;
  }
  const text = `${compactFrameRanges(missing)}\n`;
  const name = `qrfile-${session.fid}.missing-frames.txt`;
  const file = new File([text], name, { type: 'text/plain;charset=utf-8' });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'QRFile 缺帧列表' });
      return;
    }
  } catch (error) {
    if (error.name === 'AbortError') return;
  }
  downloadBlob(file, name);
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

async function loadPersistedState() {
  const saved = await loadState(db);
  for (const item of saved.data) {
    const record = { kind: 'data', fid: item.fid, idx: item.idx, total: item.total, payload: new Uint8Array(item.payload) };
    mergeRecord(sessions, record);
  }
  for (const item of saved.parity) {
    const record = {
      kind: 'parity', fid: item.fid, groupStart: item.groupStart, total: item.total,
      groupCount: item.groupCount, parityIndex: item.parityIndex, payload: new Uint8Array(item.payload),
    };
    mergeRecord(sessions, record);
  }
  updateSessionSelector();
  updateUi();
  const count = saved.data.length + saved.parity.length;
  if (count) log(`已加载中间结果：${saved.data.length} 数据帧，${saved.parity.length} 奇偶帧`);
}

async function clearAllState() {
  if (!confirm('确认清空所有已接收二维码和中间结果？此操作不能撤销。')) return;
  await stopSource();
  await clearStateDb(db);
  sessions.clear();
  currentFid = null;
  lastRestoredFile = null;
  ui.saveRestored.disabled = true;
  ui.restoreResult.classList.add('hidden');
  stats.attempts = stats.valid = stats.duplicates = stats.errors = 0;
  uniqueDecodeTimes.length = 0;
  updateSessionSelector();
  updateUi();
  updateDiagnostics();
  await updateStorageStat();
  log('已清空中间结果');
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL });
    log('离线 Service Worker 已注册');
  } catch (error) {
    log(`Service Worker 注册失败: ${error.message}`, 'error');
  }
}

function bindEvents() {
  ui.startCamera.onclick = () => startCamera().catch((e) => { log(e.message, 'error'); ui.viewerStatus.textContent = e.message; });
  ui.stopSource.onclick = () => stopSource().catch((e) => log(e.message, 'error'));
  ui.videoInput.onchange = () => {
    const file = ui.videoInput.files?.[0];
    if (file) startVideoFile(file).catch((e) => { log(e.message, 'error'); ui.viewerStatus.textContent = e.message; });
    ui.videoInput.value = '';
  };
  ui.photoInput.onchange = () => {
    const files = [...(ui.photoInput.files || [])];
    importPhotos(files).catch((e) => log(e.message, 'error'));
    ui.photoInput.value = '';
  };
  ui.workerCount.onchange = rebuildPool;
  ui.playbackRate.onchange = () => { if (sourceMode === 'video') ui.preview.playbackRate = Number(ui.playbackRate.value) || 1; };
  ui.sessionSelect.onchange = () => { currentFid = ui.sessionSelect.value || null; updateUi(); };
  ui.runFec.onclick = () => runFecForCurrent().catch((e) => log(e.message, 'error'));
  ui.restoreFile.onclick = () => restoreCurrent().catch((e) => { log(e.message, 'error'); });
  ui.saveRestored.onclick = () => saveRestored().catch((e) => log(e.message, 'error'));
  ui.exportMissing.onclick = () => exportMissing().catch((e) => log(e.message, 'error'));
  ui.clearState.onclick = () => clearAllState().catch((e) => log(e.message, 'error'));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && sourceMode === 'camera') ui.viewerStatus.textContent = '应用进入后台，摄像头扫描暂停';
  });
}

async function init() {
  detectInstallHint();
  bindEvents();
  const cores = navigator.hardwareConcurrency || 4;
  ui.workerCount.value = String(Math.min(4, Math.max(2, Math.floor(cores / 2))));
  rebuildPool();
  db = await openStateDb();
  await loadPersistedState();
  await registerServiceWorker();
  await updateStorageStat();
  setInterval(() => { updateUi(); updateStorageStat(); }, 1000);
  log('QRFile Receiver 已就绪');
}

init().catch((error) => {
  ui.viewerStatus.textContent = `初始化失败: ${error.message}`;
  log(`初始化失败: ${error.stack || error.message}`, 'error');
});
