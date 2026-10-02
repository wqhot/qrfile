import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';

const wasmUrl = new URL(`${import.meta.env.BASE_URL}zxing_reader.wasm`, self.location.origin).href;
let readyPromise = null;

function ensureReady() {
  if (!readyPromise) {
    readyPromise = prepareZXingModule({
      overrides: {
        locateFile(path, prefix) {
          if (path.endsWith('.wasm')) return wasmUrl;
          return prefix + path;
        },
      },
      fireImmediately: true,
    });
  }
  return readyPromise;
}

const options = {
  formats: ['QRCode'],
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  maxNumberOfSymbols: 1,
};

self.onmessage = async (event) => {
  const { id, kind } = event.data;
  try {
    await ensureReady();
    let input;
    if (kind === 'rgba') {
      const { buffer, width, height } = event.data;
      input = { data: new Uint8ClampedArray(buffer), width, height };
    } else if (kind === 'blob') {
      input = event.data.blob;
    } else {
      throw new Error(`unknown decoder job ${kind}`);
    }
    const results = await readBarcodes(input, options);
    const texts = results.filter((r) => r && !r.error && r.text).map((r) => r.text);
    self.postMessage({ id, ok: true, texts });
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error?.message || error) });
  }
};
