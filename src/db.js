const DB_NAME = 'qrfile-pwa';
const DB_VERSION = 1;

function reqPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function openStateDb() {
  const req = indexedDB.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains('data')) db.createObjectStore('data', { keyPath: 'key' });
    if (!db.objectStoreNames.contains('parity')) db.createObjectStore('parity', { keyPath: 'key' });
  };
  return reqPromise(req);
}

export async function loadState(db) {
  const tx = db.transaction(['data', 'parity'], 'readonly');
  const data = await reqPromise(tx.objectStore('data').getAll());
  const parity = await reqPromise(tx.objectStore('parity').getAll());
  return { data, parity };
}

function exactArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export function persistRecord(db, record) {
  return new Promise((resolve, reject) => {
    const storeName = record.kind === 'data' ? 'data' : 'parity';
    const tx = db.transaction(storeName, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    if (record.kind === 'data') {
      tx.objectStore(storeName).put({
        key: `${record.fid}:${record.idx}`,
        fid: record.fid,
        idx: record.idx,
        total: record.total,
        payload: exactArrayBuffer(record.payload),
      });
    } else {
      tx.objectStore(storeName).put({
        key: `${record.fid}:${record.groupStart}:${record.parityIndex}`,
        fid: record.fid,
        groupStart: record.groupStart,
        total: record.total,
        groupCount: record.groupCount,
        parityIndex: record.parityIndex,
        payload: exactArrayBuffer(record.payload),
      });
    }
  });
}

export async function clearStateDb(db) {
  const tx = db.transaction(['data', 'parity'], 'readwrite');
  tx.objectStore('data').clear();
  tx.objectStore('parity').clear();
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}
