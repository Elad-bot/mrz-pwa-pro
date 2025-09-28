/* MRZ PWA with: burst capture OR upload still image (single-frame path). */
const video = document.getElementById('video');
const work = document.getElementById('work');
const statusEl = document.getElementById('status');
const scanBtn = document.getElementById('scanBtn');
const flipBtn = document.getElementById('flipBtn');
const fileInput = document.getElementById('fileInput');
const fieldsEl = document.getElementById('fields');
const rawEl = document.getElementById('raw');
const copyJsonBtn = document.getElementById('copyJson');
const confPill = document.getElementById('confPill');

let currentFacing = 'environment';
let stream;

async function startCamera() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: currentFacing }, width:{ideal:1920}, height:{ideal:1080} },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    statusEl.textContent = 'Camera ready. Align MRZ and tap Scan or upload a photo.';
  } catch (e) {
    statusEl.textContent = 'Camera error: ' + e.message;
  }
}
if (navigator.mediaDevices?.getUserMedia) startCamera();
flipBtn.onclick = () => { currentFacing = currentFacing === 'environment' ? 'user' : 'environment'; startCamera(); };

scanBtn.onclick = async () => {
  if (!video.videoWidth) { statusEl.textContent = 'Camera not ready.'; return; }
  scanBtn.disabled = true; statusEl.textContent = 'Capturing burst…';

  const frames = await captureBurst(6, 90);
  const ranked = frames.map(c => ({ c, sharp: lapVar(c) })).sort((a,b)=>b.sharp-a.sharp);
  const top = ranked.slice(0,3).map(o => o.c);

  statusEl.textContent = 'Processing…';
  const linePairs = await Promise.all(top.map(frame => ocrTwoLines(frame)));
  const voted = voteLines(linePairs);
  const parsed = parseWithCorrections(voted.l1, voted.l2);
  renderResult(parsed);
  scanBtn.disabled = false;
};

// Upload path: single still image from native camera
fileInput.onchange = async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  statusEl.textContent = 'Loading photo…';
  const img = new Image();
  img.onload = async () => {
    const frame = document.createElement('canvas');
    frame.width = img.naturalWidth; frame.height = img.naturalHeight;
    const ctx = frame.getContext('2d');
    ctx.drawImage(img, 0, 0, frame.width, frame.height);
    statusEl.textContent = 'Processing photo…';
    const { l1, l2 } = await ocrTwoLines(frame);
    const parsed = parseWithCorrections(l1, l2);
    renderResult(parsed);
  };
  img.onerror = () => { statusEl.textContent = 'Failed to load image.'; };
  img.src = URL.createObjectURL(file);
};

// ----- burst helpers -----
function captureFrame() {
  const c = document.createElement('canvas');
  c.width = video.videoWidth; c.height = video.videoHeight;
  const ctx = c.getContext('2d');
  ctx.drawImage(video, 0, 0, c.width, c.height);
  return c;
}
async function captureBurst(n=6, gapMs=80){
  const arr = [];
  for (let i=0;i<n;i++) { arr.append ? arr.append(captureFrame()) : arr.push(captureFrame()); await new Promise(r=>setTimeout(r, gapMs)); }
  return arr;
}

// Sharpness
function lapVar(c){
  const w=c.width,h=c.height,ctx=c.getContext('2d');
  const id = ctx.getImageData(0,0,w,h); const d=id.data;
  const g = new Uint8ClampedArray(w*h);
  for(let i=0,j=0;i<d.length;i+=4,j++) g[j]=(0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2])|0;
  const K=[0,1,0,1,-4,1,0,1,0]; const out=new Float32Array(w*h);
  for(let y=1;y<h-1;y++){ for(let x=1;x<w-1;x++){ let s=0,k=0,idx=y*w+x;
    for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) s += g[idx+dy*w+dx]*K[k++];
    out[idx]=s; } }
  let mean=0; for(let i=0;i<out.length;i++) mean+=out[i]; mean/=out.length;
  let v=0; for(let i=0;i<out.length;i++){ const t=out[i]-mean; v+=t*t; } return v/out.length;
}

// OCR two lines
async function ocrTwoLines(frame){
  const { l1, l2 } = extractLines(frame);
  const worker = await Tesseract.createWorker('eng', 1, {
    corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5/tesseract-core.wasm.js',
    workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
  });
  await worker.setParameters({
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<',
    preserve_interword_spaces: '1',
    tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE
  });
  const [r1,r2] = await Promise.all([worker.recognize(l1), worker.recognize(l2)]);
  await worker.terminate();
  let a = norm(r1.data.text), b = norm(r2.data.text);
  if (a.length < 36 || b.length < 36) {
    const band = wholeBand(frame);
    const w2 = await Tesseract.createWorker('eng', 1, {
      corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5/tesseract-core.wasm.js',
      workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
    });
    await w2.setParameters({
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<',
      tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK
    });
    const rr = await w2.recognize(band);
    await w2.terminate();
    const lines = norm(rr.data.text).split('\\n').map(s=>s.trim()).filter(Boolean);
    const picks = lines.filter(looksMrz).slice(0,2);
    if (picks.length === 2) [a,b] = picks;
  }
  return { l1: pad44(a), l2: pad44(b) };
}

function norm(s){ return (s||'').toUpperCase().replace(/[^A-Z0-9<\\n]/g,''); }
function looksMrz(s){ return s.length >= 36 && (s.match(/</g)||[]).length >= 5; }
function pad44(s){ s=s.replace(/\\s+/g,'').replace(/\\|/g,'I'); return s.padEnd(44,'<').slice(0,44); }

// Band extraction
function extractLines(full){
  const W=full.width,H=full.height;
  const bandY = Math.floor(H*0.68), bandH = Math.floor(H*0.28);
  const band = document.createElement('canvas');
  band.width=W; band.height=bandH;
  band.getContext('2d').drawImage(full,0,bandY,W,bandH,0,0,W,bandH);
  const innerY = Math.floor(bandH*0.08), innerH = Math.floor(bandH*0.84);
  const lineH = Math.floor(innerH/2);
  const l1 = cropPrep(band, 0, innerY, W, lineH);
  const l2 = cropPrep(band, 0, innerY+lineH, W, lineH);
  return { l1, l2 };
}
function wholeBand(full){
  const W=full.width,H=full.height;
  const bandY = Math.floor(H*0.68), bandH = Math.floor(H*0.28);
  const band = document.createElement('canvas');
  band.width=W; band.height=bandH;
  band.getContext('2d').drawImage(full,0,bandY,W,bandH,0,0,W,bandH);
  return upBinarize(band, 2);
}
function cropPrep(src,x,y,w,h){
  const t = document.createElement('canvas');
  t.width=w; t.height=h;
  t.getContext('2d').drawImage(src,x,y,w,h,0,0,w,h);
  return upBinarize(t, 2);
}
function upBinarize(c,scale=2){
  const up = document.createElement('canvas');
  up.width=Math.floor(c.width*scale); up.height=Math.floor(c.height*scale);
  const ctx=up.getContext('2d');
  ctx.imageSmoothingEnabled=false; ctx.drawImage(c,0,0,up.width,up.height);
  const id=ctx.getImageData(0,0,up.width,up.height), d=id.data;
  const TW=16, TH=16;
  for(let ty=0; ty<up.height; ty+=TH){
    for(let tx=0; tx<up.width; tx+=TW){
      let sum=0,cnt=0;
      for(let y=ty;y<Math.min(ty+TH,up.height);y++)
        for(let x=tx;x<Math.min(tx+TW,up.width);x++){
          const i=(y*up.width+x)*4;
          const g=0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2]; sum+=g; cnt++;
        }
      const mean=sum/cnt, thr=mean-10;
      for(let y=ty;y<Math.min(ty+TH,up.height);y++)
        for(let x=tx;x<Math.min(tx+TW,up.width);x++){
          const i=(y*up.width+x)*4;
          const g=0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2];
          const v = g>thr?255:0; d[i]=d[i+1]=d[i+2]=v; d[i+3]=255;
        }
    }
  }
  ctx.putImageData(id,0,0);
  return up;
}

// Voting (kept for burst path)
function voteLines(pairs){
  const cols = (arr, i) => arr.map(p => p[i] || '<');
  const l1s = pairs.map(p => p.l1);
  const l2s = pairs.map(p => p.l2);
  const vote = (arrs) => {
    let out='';
    for (let i=0;i<44;i++){
      const col = cols(arrs, i);
      const tally = new Map();
      col.forEach(ch => tally.set(ch, (tally.get(ch)||0)+1));
      out += [...tally.entries()].sort((a,b)=>b[1]-a[1])[0][0];
    }
    return out;
  };
  return { l1: vote(l1s), l2: vote(l2s) };
}

// ICAO + corrections + confidence (same as pro version)
const MAP = {}; for (let i=0;i<=9;i++) MAP[i]=i; for (let i=0;i<26;i++) MAP[String.fromCharCode(65+i)]=10+i; MAP['<']=0; const W=[7,3,1];
function icaoDigit(s){ let t=0; for(let i=0;i<s.length;i++){ t += (MAP[s[i]]??0)*W[i%3]; } return t%10; }
function yymmddIso(s){
  if(!/^\\d{6}$/.test(s)) return null;
  const yy=+s.slice(0,2), mm=+s.slice(2,4), dd=+s.slice(4,6);
  const today=new Date(); const y2000=2000+yy;
  const guess=new Date(Date.UTC(y2000,mm-1,dd));
  const ten=new Date(Date.UTC(today.getUTCFullYear()+10,today.getUTCMonth(),today.getUTCDate()));
  const year = guess>ten?1900+yy:y2000;
  const d=new Date(Date.UTC(year,mm-1,dd)); return isNaN(d)?null:d.toISOString().slice(0,10);
}
function trySubs(field, digitsOnly=false){
  const subs=[['O','0'],['I','1'],['L','1'],['B','8'],['S','5'],['G','6']];
  const variants=new Set([field]);
  for(const [a,b] of subs){ variants.add(field.replaceAll(a,b)); variants.add(field.replaceAll(b,a)); }
  if(digitsOnly){ [...variants].forEach(v => variants.add(v.replace(/[^0-9<]/g,''))); }
  return [...variants];
}
function parseWithCorrections(l1, l2){
  const docType=l1[0];
  const issuing=l1.slice(2,5);
  const nameField=l1.slice(5,44);
  const [surRaw, givRaw='']=nameField.split('<<');
  const surname=surRaw.replace(/</g,' ').trim().replace(/\s+/g,' ');
  const given=givRaw.replace(/</g,' ').trim().replace(/\s+/g,' ');

  let number=l2.slice(0,9), numChk=l2[9];
  const nationality=l2.slice(10,13);
  let dob=l2.slice(13,19), dobChk=l2[19];
  const sex=l2[20];
  let exp=l2.slice(21,27), expChk=l2[27];
  const personal=l2.slice(28,42), finalChk=l2[42];

  const numOk = /\\d/.test(numChk) ? trySubs(number).some(v => icaoDigit(v)===+numChk && (number=v,true)) : null;
  const dobOk = /\\d/.test(dobChk) ? trySubs(dob,true).some(v => icaoDigit(v)===+dobChk && (dob=v,true)) : null;
  const expOk = /\\d/.test(expChk) ? trySubs(exp,true).some(v => icaoDigit(v)===+expChk && (exp=v,true)) : null;

  let compOk=null;
  if(/\\d/.test(finalChk)){
    const composite = (n,d,e) => n + (numChk||'<') + d + (dobChk||'<') + e + (expChk||'<') + personal;
    const nVars = trySubs(number), dVars = trySubs(dob,true), eVars = trySubs(exp,true);
    outer: for(const n of nVars){ for(const d of dVars){ for(const e of eVars){
      if(icaoDigit(composite(n,d,e))===+finalChk){ compOk=true; break outer; }
    } } }
    if(compOk===null) compOk=false;
  }

  let score=0;
  if(dobOk===true) score+=0.35;
  if(expOk===true) score+=0.35;
  if(compOk===true) score+=0.20;
  const cleanName = surname && given && surname.length<=30 && given.length<=40 && !surname.includes('<<<') && !given.includes('<<<');
  if(cleanName) score+=0.10;

  const ok = [dobOk, expOk, compOk].filter(v=>v!==null).every(Boolean);

  return {
    ok, confidence: +score.toFixed(2),
    documentType: docType, issuingCountry: issuing, nationality,
    surname, givenNames: given, fullNameDisplay: (given+' '+surname).trim(),
    passportNumber: number, passportNumberCheckOk: numOk??null,
    dateOfBirth: yymmddIso(dob), dateOfBirthCheckOk: dobOk??null,
    sex, expiryDate: yymmddIso(exp), expiryDateCheckOk: expOk??null,
    personalNumber: personal.replace(/<+$/,'') || null,
    compositeCheckOk: compOk,
    rawLine1: l1, rawLine2: l2
  };
}

// Render
function renderResult(res){
  rawEl.textContent = JSON.stringify(res, null, 2);
  copyJsonBtn.disabled = false;
  copyJsonBtn.onclick = () => navigator.clipboard.writeText(JSON.stringify(res)).then(()=>{
    statusEl.textContent = 'Copied JSON to clipboard.';
  });
  confPill.textContent = (res.confidence*100).toFixed(0)+'%';
  confPill.className = 'pill ' + (res.confidence>=0.85 ? 'ok' : res.confidence>=0.70 ? 'warn' : 'bad');
  const rows = [
    ['Full name', res.fullNameDisplay],
    ['Surname', res.surname],
    ['Given names', res.givenNames],
    ['Passport #', res.passportNumber + (res.passportNumberCheckOk===true?' ✓':res.passportNumberCheckOk===false?' ✗':'')],
    ['Nationality (ICAO-3)', res.nationality],
    ['Issuing country (ICAO-3)', res.issuingCountry],
    ['DOB', res.dateOfBirth + (res.dateOfBirthCheckOk?' ✓':' ✗')],
    ['Sex', res.sex],
    ['Expiry', res.expiryDate + (res.expiryDateCheckOk?' ✓':' ✗')],
    ['Composite check', res.compositeCheckOk===true?'✓':(res.compositeCheckOk===false?'✗':'—')],
  ];
  fieldsEl.innerHTML = rows.map(([k,v]) => `
    <div class="card">
      <div class="label">${k}</div>
      <div class="value">${v ?? '—'}</div>
    </div>
  `).join('');
}
