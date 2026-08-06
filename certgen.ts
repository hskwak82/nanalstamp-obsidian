// ── P6: 특정 시점 증명서/번들 산출물 빌더 ─────────────────────────────────────
// Obsidian 런타임에 의존하지 않는 순수 함수들. main.ts가 import해서 쓰고, 프리뷰/테스트
// 스크립트도 같은 함수를 재사용해 "보여준 산출물"과 "실제 코드"가 절대 어긋나지 않게 한다.

// 아카이브된 한 버전의 오프라인 자기검증 결과(내용 해시 vs proof.file_hash + 확정 블록).
export type PitVerify = {
  computed: string;   // 아카이브 원문을 실제로 해시한 값
  expected: string;   // proof 안의 file_hash
  hashMatch: boolean; // computed === expected
  block?: number;     // 확정된 비트코인 블록 높이(없으면 미확정)
  seq?: number;       // 체인 시퀀스
  ok: boolean;        // hashMatch && block 존재
};

export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

// FREE 번들에 함께 넣는 사람용 검증 안내(오프라인·서버 불필요). 아카이브 README와 톤 일치(영문 표준).
export function pitVerifyReadme(safe: string, dateLabel: string, v: PitVerify): string {
  const match = v.hashMatch ? "MATCH ✓" : "MISMATCH ✗";
  return (
    `# Point-in-time proof — ${safe}\n\n` +
    `Archived version: **${dateLabel}**${v.seq != null ? ` · sequence #${v.seq}` : ""}${v.block != null ? ` · Bitcoin block #${v.block}` : ""}\n\n` +
    `This folder is a self-verifying bundle. It proves that **this exact content existed** at the time its\n` +
    `Bitcoin anchor was confirmed — even though the live note may have been edited since.\n\n` +
    `- \`note.md\` — the original note bytes as they were when sealed.\n` +
    `- \`proof.nanalproof\` — the proof bundle (chain segment, signatures, Merkle path, OpenTimestamps, Bitcoin block, public key).\n\n` +
    `## Verify it yourself (no nanalStamp servers required)\n\n` +
    `1. **Hash the content:** \`shasum -a 256 note.md\` (or any SHA-256 tool).\n` +
    `2. **Compare** it to \`file_hash\` inside \`proof.nanalproof\`.\n` +
    `   - Expected: \`${v.expected || "(none in proof)"}\`\n` +
    `   - At export the content hashed to: \`${v.computed}\` → **${match}**\n` +
    `3. **Anchor to Bitcoin:** verify the embedded OpenTimestamps proof (\`ots verify\`) — it ties the hash to Bitcoin block #${v.block ?? "?"}.\n` +
    `4. **One-click full check:** open https://api.nanalstamp.com/np-verify and drop \`proof.nanalproof\` + \`note.md\` — it re-hashes the content, verifies the issuer's Ed25519 signature and the Merkle path, all in your browser.\n\n` +
    `The trust anchor is Bitcoin, not nanalStamp. Even if nanalStamp disappears, this bundle stands on its own.\n`
  );
}

// PRO HTML 증명서(자체완결 표지) — 증명된 그 시점의 원문을 그대로 싣고(바이트 불변),
// 원문을 드래그드롭하면 브라우저(SubtleCrypto)에서 즉석 재검증까지 된다.
// 신뢰 3층: (1) verifyUrl/QR = 서버 원장 진위확인(문서 밖 신뢰) (2) 내장 proof의 Ed25519 서명
// 실검증(공개키 지문을 /attest/pubkey와 대조) (3) OTS→비트코인(최종 심급). 페이지 자기검증은 편의일 뿐.
export function pitCertificateHtml(noteName: string, noteContent: string, dateLabel: string, oid: string, v: PitVerify, iconUrl?: string, verifyUrl?: string, qrDataUri?: string, proofRaw?: string): string {
  // 씰은 정본 nanal.png(iconUrl)만 — 없으면 아무것도 그리지 않는다(자물쇠 이모지 등 대체물 금지, 브랜드 원칙).
  const seal = iconUrl ? `<img src="${escapeHtml(iconUrl)}" alt="nanalStamp" width="56" height="56">` : "";
  // JSON 안의 "</script" 로 스크립트 블록이 조기 종료되지 않게 — "\/"는 JSON에서 유효한 이스케이프.
  const proofEmbed = proofRaw ? proofRaw.replace(/<\//g, "<\\/") : null;
  let npVerifyUrl: string | null = null;
  if (verifyUrl) { try { npVerifyUrl = new URL(verifyUrl).origin + "/np-verify"; } catch { npVerifyUrl = null; } }
  const verdict = v.ok
    ? `<span class="ok">Verified — content matches its proof, anchored to Bitcoin.</span>`
    : v.hashMatch
      ? `<span class="warn">Content matches its proof, but no confirmed Bitcoin block yet.</span>`
      : `<span class="bad">Content does not match the hash in its proof.</span>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>nanalStamp certificate — ${escapeHtml(noteName)}</title>
<style>
  :root{--red:#D32A2A;--ink:#1a1a1a;--mut:#666;--line:#e6e6e6}
  *{box-sizing:border-box}
  body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--ink);margin:0;background:#f5f5f4}
  .sheet{max-width:720px;margin:32px auto;background:#fff;border:1px solid var(--line);border-radius:14px;padding:40px 44px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
  header{display:flex;align-items:center;gap:14px;border-bottom:2px solid var(--red);padding-bottom:16px;margin-bottom:24px}
  header h1{font-size:20px;margin:0;letter-spacing:-.01em}
  header .sub{color:var(--mut);font-size:13px;margin-top:2px}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);margin:26px 0 8px}
  .note{font-size:22px;font-weight:600;margin:0 0 4px;word-break:break-word}
  table{width:100%;border-collapse:collapse;margin-top:6px}
  td{padding:7px 0;border-bottom:1px solid var(--line);vertical-align:top}
  td.k{color:var(--mut);width:150px;white-space:nowrap}
  code{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
  .verdict{padding:12px 14px;border-radius:9px;margin-top:8px;font-weight:500}
  .verdict.g{background:#eaf7ee}.verdict.y{background:#fdf4e3}.verdict.r{background:#fbeaea}
  .ok{color:#137a37}.warn{color:#9a6a00}.bad{color:#b3261e}
  .content{margin-top:6px;border:1px solid var(--line);border-radius:9px;background:#fafafa;padding:16px 18px;max-height:420px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
  .drop{margin-top:10px;border:1.5px dashed var(--line);border-radius:9px;padding:18px;text-align:center;color:var(--mut);cursor:pointer}
  .drop.hit{border-color:var(--red)}
  #res{margin-top:8px;font-weight:600}
  footer{margin-top:28px;padding-top:16px;border-top:1px solid var(--line);color:var(--mut);font-size:12px;line-height:1.7}
  @media print{body{background:#fff}.sheet{border:0;box-shadow:none;margin:0}.drop{display:none}}
</style></head>
<body><div class="sheet">
  <header><div>${seal}</div><div><h1>Point-in-time certificate</h1><div class="sub">nanalStamp · Bitcoin-anchored proof of existence</div></div></header>

  <h2>Note</h2>
  <p class="note">${escapeHtml(noteName)}</p>

  <div class="verdict ${v.ok ? "g" : v.hashMatch ? "y" : "r"}">${verdict}</div>

  <h2>Details</h2>
  <table>
    <tr><td class="k">Archived</td><td id="m-archived">${escapeHtml(dateLabel)}</td></tr>
    <tr><td class="k">Sequence</td><td id="m-seq">#${v.seq ?? "?"}</td></tr>
    <tr><td class="k">Bitcoin block</td><td id="m-block">#${v.block ?? "?"}</td></tr>
    <tr><td class="k">Content SHA-256</td><td><code id="m-hash">${escapeHtml(v.expected || v.computed)}</code></td></tr>
    <tr><td class="k">Archive commit</td><td><code id="m-oid">${escapeHtml(oid)}</code></td></tr>
  </table>

  <h2>Certified content</h2>
  <p style="color:var(--mut);margin:0 0 6px">The exact note text as it existed at this point in time — the precise bytes the hash above was computed from.</p>
  <div class="content" id="content">${escapeHtml(noteContent)}</div>
  <p id="integ" style="margin:6px 0 0;font-weight:600;font-size:13px"></p>

  <h2>Verify this yourself</h2>
  <p style="color:var(--mut);margin:0 0 8px">Drop the original note file here — your browser hashes it locally (nothing is uploaded) and checks it against this certificate.</p>
  <div class="drop" id="drop">Drop the note file, or click to choose<input id="file" type="file" hidden></div>
  <div id="res"></div>
${verifyUrl ? `
  <h2>Independent verification</h2>
  <table><tr>
    ${qrDataUri ? `<td style="border:0;padding:0 18px 0 0;width:130px;vertical-align:top"><img src="${qrDataUri}" width="130" height="130" alt="verification QR"></td>` : ""}
    <td style="border:0;padding:0;vertical-align:top">
      <p style="margin:0 0 6px">Scan the QR or open the link to check this record against the <b>live nanalStamp ledger</b> — the authoritative sealed-at time, sequence and Bitcoin block for this hash:</p>
      <p style="margin:0 0 8px"><a href="${escapeHtml(verifyUrl)}">${escapeHtml(verifyUrl)}</a></p>
      <p style="margin:0;color:var(--mut);font-size:13px">If anything on this page disagrees with the ledger page, <b>trust the ledger, not this page</b>.${npVerifyUrl ? ` Fully offline verification (signature + Merkle + Bitcoin): <a href="${escapeHtml(npVerifyUrl)}">${escapeHtml(npVerifyUrl)}</a> with the embedded proof below.` : ""}</p>
    </td></tr></table>` : ""}
  <div id="sig" style="margin-top:10px;font-size:13px"></div>
  ${proofEmbed ? `<p style="margin:8px 0 0"><button id="dlproof" style="font:inherit;font-size:13px;padding:5px 12px;border:1px solid var(--line);border-radius:7px;background:#fafafa;cursor:pointer">Download machine proof (.nanalproof)</button></p>
  <script type="application/json" id="proof">${proofEmbed}</script>` : ""}

  <footer>
    The trust anchor is Bitcoin, not nanalStamp. This certificate is a human-readable cover; the machine proof is the
    <code>.nanalproof</code> bundle. Anyone can confirm the timestamp against the Bitcoin blockchain via OpenTimestamps
    (<code>ots verify</code>) even if nanalStamp no longer exists.
    <br>Note: like any HTML file, this page (including its scripts) can be altered. For adversarial verification, always
    hash the original file with an independent tool — <code>shasum -a 256 note.md</code> — and compare against the
    Bitcoin-anchored hash in the <code>.nanalproof</code> bundle.
  </footer>
</div>
<script>
  var EXPECT = ${JSON.stringify(v.expected || v.computed)};
  var drop = document.getElementById('drop'), file = document.getElementById('file'), res = document.getElementById('res');
  function show(ok, txt){ res.textContent = txt; res.style.color = ok ? '#137a37' : '#b3261e'; }
  async function sha256hex(bytes){
    var d = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(d)).map(function(b){return b.toString(16).padStart(2,'0')}).join('');
  }
  // 표시 원문 + 메타데이터 표를 내장 클레임과 대조 — HTML의 어느 필드를 손대도 로드 즉시 들통난다.
  // 한계(정직하게): 클레임 상수와 표를 함께 고치거나 이 스크립트를 지우면 자기검증은 무력화된다.
  // 그래서 최종 신뢰는 이 페이지가 아니라 .nanalproof(서명·비트코인 앵커)와 독립 해시 도구에 있다(푸터 참조).
  var CLAIMS = ${JSON.stringify({
    archived: dateLabel,
    seq: `#${v.seq ?? "?"}`,
    block: `#${v.block ?? "?"}`,
    hash: v.expected || v.computed,
    oid: oid,
  })};
  var displayedOk = null;
  (async function(){
    var integ = document.getElementById('integ');
    try{
      var problems = [];
      var el = document.getElementById('content');
      var h = await sha256hex(new TextEncoder().encode(el.textContent));
      if (h !== EXPECT) problems.push('certified content');
      var fields = { 'm-archived': CLAIMS.archived, 'm-seq': CLAIMS.seq, 'm-block': CLAIMS.block, 'm-hash': CLAIMS.hash, 'm-oid': CLAIMS.oid };
      for (var id in fields) {
        var td = document.getElementById(id);
        if (!td || td.textContent.trim() !== fields[id]) problems.push(id.replace('m-', '') + ' field');
      }
      displayedOk = problems.length === 0;
      if (displayedOk){ integ.textContent = '✓ Content and details displayed above match the certified claims.'; integ.style.color = '#137a37'; }
      else {
        integ.textContent = '⚠️ TAMPERED — this copy was modified (' + problems.join(', ') + ' do not match the certified claims). Do not trust it; verify independently.';
        integ.style.color = '#b3261e';
        el.style.borderColor = '#b3261e';
      }
    }catch(e){ integ.textContent = 'Could not self-check this page: ' + e; integ.style.color = '#9a6a00'; }
  })();
  async function check(f){
    try{
      var hex = await sha256hex(await f.arrayBuffer());
      if (hex !== EXPECT){ show(false, '⚠️ No match. hash = ' + hex); return; }
      if (displayedOk === false){ show(false, '⚠️ The dropped file matches the certified hash, but the content DISPLAYED on this page was tampered with — trust the file, not this page.'); return; }
      show(true, '✅ Match — this file is the certified content.');
    }catch(e){ show(false, 'Could not read file: ' + e); }
  }
  drop.addEventListener('click', function(){ file.click(); });
  file.addEventListener('change', function(){ if(file.files[0]) check(file.files[0]); });
  drop.addEventListener('dragover', function(e){ e.preventDefault(); drop.classList.add('hit'); });
  drop.addEventListener('dragleave', function(){ drop.classList.remove('hit'); });
  drop.addEventListener('drop', function(e){ e.preventDefault(); drop.classList.remove('hit'); if(e.dataTransfer.files[0]) check(e.dataTransfer.files[0]); });
  // Ed25519 서명 실검증(오프라인): 내장 proof에서 이 해시의 체인 엔트리를 찾아 entry_hash를
  // 재계산(preimage: user|seq|prev_hash|file_hash|path|received_at)하고 발급자 공개키로 서명을 검증.
  // 문서 안의 공개키를 그대로 믿지 않도록 키 지문을 /attest/pubkey(독립 채널)와 대조하라고 안내한다.
  (async function(){
    var sig = document.getElementById('sig');
    var pe = document.getElementById('proof');
    if (!sig) return;
    if (!pe) { sig.textContent = 'No embedded machine proof — verify the .nanalproof bundle at /np-verify instead.'; sig.style.color = '#9a6a00'; return; }
    try{
      var proof = JSON.parse(pe.textContent);
      var seg = proof.segment || [];
      var entry = null;
      for (var i = 0; i < seg.length; i++){ if (seg[i].file_hash === EXPECT) { entry = seg[i]; break; } }
      if (!entry) { sig.textContent = '⚠️ Embedded proof contains no chain entry for this hash — proof/certificate mismatch.'; sig.style.color = '#b3261e'; return; }
      var pre = entry.user + '|' + entry.seq + '|' + entry.prev_hash + '|' + entry.file_hash + '|' + entry.path + '|' + entry.received_at;
      var eh = await sha256hex(new TextEncoder().encode(pre));
      if (eh !== entry.entry_hash) { sig.textContent = '⚠️ TAMPERED — recomputed entry hash does not match the embedded proof.'; sig.style.color = '#b3261e'; return; }
      function b64b(s){ var bin = atob(s), a = new Uint8Array(bin.length); for (var j = 0; j < bin.length; j++) a[j] = bin.charCodeAt(j); return a; }
      function hexb(s){ var a = new Uint8Array(s.length / 2); for (var j = 0; j < a.length; j++) a[j] = parseInt(s.substr(j * 2, 2), 16); return a; }
      var pub = b64b(proof.pubkey_b64);
      var key = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
      var ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, b64b(entry.signature), hexb(entry.entry_hash));
      var fp = (await sha256hex(pub)).slice(0, 16);
      if (ok){
        sig.textContent = '';
        sig.appendChild(document.createTextNode('✓ Issuer Ed25519 signature verified over this record (seq #' + entry.seq + '). Key fingerprint '));
        var fpEl = document.createElement('code'); fpEl.textContent = fp; sig.appendChild(fpEl);
        sig.appendChild(document.createTextNode(' — compare it with the issuer\\u2019s published key ('));
        var epEl = document.createElement('code'); epEl.textContent = 'GET /attest/pubkey'; sig.appendChild(epEl);
        sig.appendChild(document.createTextNode(').'));
        sig.style.color = '#137a37';
      } else {
        sig.textContent = '⚠️ SIGNATURE INVALID — this record was not signed by the key embedded in this certificate.';
        sig.style.color = '#b3261e';
      }
    }catch(e){ sig.textContent = 'Signature check unavailable in this browser (' + e + ') — verify the proof at /np-verify instead.'; sig.style.color = '#9a6a00'; }
  })();
  var dl = document.getElementById('dlproof');
  if (dl) dl.addEventListener('click', function(){
    var pe2 = document.getElementById('proof');
    if (!pe2) return;
    var blob = new Blob([pe2.textContent], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'proof.nanalproof';
    a.click();
    URL.revokeObjectURL(a.href);
  });
</script>
</body></html>`;
}
