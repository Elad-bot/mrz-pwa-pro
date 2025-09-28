// --- Replace the existing upload handler with this one ---
fileInput.onchange = async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;

  statusEl.textContent = 'Loading photo…';

  // Try to honor EXIF orientation if the browser supports it
  let frame;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    frame = document.createElement('canvas');
    frame.width = bitmap.width; frame.height = bitmap.height;
    frame.getContext('2d').drawImage(bitmap, 0, 0);
  } catch {
    // Fallback: classic <img> path (may ignore EXIF)
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = URL.createObjectURL(file);
    });
    frame = document.createElement('canvas');
    frame.width = img.naturalWidth; frame.height = img.naturalHeight;
    frame.getContext('2d').drawImage(img, 0, 0, frame.width, frame.height);
  }

  statusEl.textContent = 'Processing photo…';

  // 1) Try the precise band crop (fast)
  let { l1, l2 } = extractLines(frame);

  // If they don't look like MRZ lines, run whole-image detection
  if (!looksMrz(l1) || !looksMrz(l2)) {
    const lines = await detectMrzLinesWholeImage(frame); // new function below
    if (lines && lines.length === 2) {
      l1 = pad44(lines[0]);
      l2 = pad44(lines[1]);
    }
  }

  const parsed = parseWithCorrections(l1, l2);
  renderResult(parsed);
};

// --- Replace / update helpers below ---

function looksMrz(s){
  if (!s) return false;
  // MRZ lines are 44 chars, mostly A–Z/0–9/<, with lots of '<'
  const lenOK = s.length >= 40;
  const ltCount = (s.match(/</g) || []).length;
  return lenOK && ltCount >= 10;
}

// NEW: whole-image detection using a coarse OCR,
// then pick two lines that look the most like MRZ.
async function detectMrzLinesWholeImage(fullCanvas){
  const worker = await Tesseract.createWorker('eng', 1, {
    corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5/tesseract-core.wasm.js',
    workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
  });
  await worker.setParameters({
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<',
    preserve_interword_spaces: '1',
    tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK
  });

  // Downscale large images to speed up this coarse pass
  const scaled = downscaleForCoarse(fullCanvas, 1600);
  const { data } = await worker.recognize(scaled);
  await worker.terminate();

  const rawLines = (data.text || '')
    .toUpperCase()
    .replace(/[^A-Z0-9<\n]/g, '')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);

  // Score each line: prefer many '<' and length near 44
  const scored = rawLines
    .map(s => ({ s, score: ((s.match(/</g)||[]).length * 2) + Math.min(s.length, 44) }))
    .sort((a,b) => b.score - a.score);

  // Pick the top two that pass looksMrz and keep their original order
  const picks = scored.filter(x => looksMrz(x.s)).slice(0, 2).map(x => x.s);
  return picks.length === 2 ? picks : null;
}

function downscaleForCoarse(srcCanvas, targetMaxWidth){
  if (srcCanvas.width <= targetMaxWidth) return srcCanvas;
  const scale = targetMaxWidth / srcCanvas.width;
  const c = document.createElement('canvas');
  c.width = Math.round(srcCanvas.width * scale);
  c.height = Math.round(srcCanvas.height * scale);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(srcCanvas, 0, 0, c.width, c.height);
  return c;
}
