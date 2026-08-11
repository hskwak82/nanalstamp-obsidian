// storagelayer.ts — nanalStorage(S3) 전송 계층. main.ts에서 **본문 무변경**으로 이동(2026-07-26).
// 업로드/다운로드·청크·DEK 조회·존재 확인. 상태와 상위 호출 계약은 pluginbase.ts 참조.
// private → protected 는 계층이 갈리며 필요한 최소 변경(외부 공개 아님).
import { FileSystemAdapter, Notice, TFile, RequestUrlResponse, requestUrl } from "obsidian";
import { t } from "./i18n";
import { hexToBase64, blobExt, PROOF_EXT, bodyByteSize, storageEndpoint } from "./storagecore";
import { cdcChunks, nextCut, buildManifest, parseManifest, CHUNK_THRESHOLD, CHUNK_MAX } from "./chunkcore";
import { encryptBlob, decryptBlob, isEncrypted } from "./cryptocore";
import { nodeReq, sha256Hex, sha256HexBytes } from "./pathutil";
import { UPLOAD_CONCURRENCY } from "./constants";
import { isMarkdownPath } from "./sealscope";
import { NanalStampBase } from "./pluginbase";

export abstract class StorageLayer extends NanalStampBase {
  // B/C1/C2: nanalStamp WORM 스토리지가 동작하는 조건. C1부터 githubExport와 병행 가능(택일 아님).
  // C2: 팀 custody가 nanal이면 멤버의 개인 storageBackend 선택과 무관하게 강제 활성(팀 설정이 우선).
  nanalActive(): boolean {
    // 팀 custody 가 켜져 있으면 **팀이 비용을 낸다** — 멤버 개인 구독이 만료돼도 팀 보관은 이어진다.
    // (팀 자체의 유효성은 서버가 팀 경로 presign 에서 판정한다.)
    if (this.settings.teamStorage === "nanal") return true;
    return this.isPro() && this.settings.storageBackend === "nanal";
  }

  // 그날부터 보관: "지금부터만" 선택 시 시작 시점(nanalSince) 이전에 마지막 수정된 파일은 소급 업로드 제외.
  // 새로 작성·수정된 노트는 mtime이 최신이라 자연 통과 — 신규 봉인의 즉시 업로드는 이 게이트에 걸리지 않는다.
  nanalEligibleFile(f: TFile): boolean {
    return this.settings.nanalBackfill || f.stat.mtime >= this.settings.nanalSince;
  }

  // B: 봉인된 버전의 원문+proof를 nanalStamp WORM 스토리지(S3 Object Lock)에 업로드.
  // 키는 서버가 만든다: u/<uid>/sha256-<원문해시>.<ext|proof> — proof도 '원문 해시' 키라 조회가 해시 하나로 끝난다.
  // presign에 x-amz-checksum-sha256이 서명돼 내용≠해시 업로드는 S3가 거부. 업로드는 플러그인↔S3 직접(서버는 내용 안 봄).
  // 확정 proof는 내용이 갱신되므로 force 재업로드(버저닝 버킷 → 새 버전, append-only 유지).
  // 부분 실패 시 false → nanalIndex 미갱신 → sealArchiveRetry/sweep이 재시도.
  /// 원본 바이트를 규칙대로 올린다(암호화·청크 판정 포함). **TFile 이 필요 없다.**
  ///
  /// 복구 경로는 지워진 노트를 다루므로 TFile 이 없다. 그렇다고 업로드 로직을 따로 쓰면
  /// 암호화·청크·키 유도가 조금이라도 갈릴 때 나중에 **읽을 수 없는 객체**가 생긴다.
  /// 그래서 봉인 시점 업로드와 복구가 이 함수 하나를 공유한다.
  protected async putOriginalBytes(
    hash: string, ext: string, origBytes: Uint8Array, keyPath: string,
  ): Promise<{ ok: boolean; dekMissing: boolean }> {
    // v2a: 대형 원본(>512KB)은 CDC 조각+manifest — 변경분만 업로드·과금. 이하는 단일 객체.
    if (origBytes.byteLength > CHUNK_THRESHOLD) {
      return { ok: await this.nanalPutChunked(hash, ext, origBytes, keyPath), dekMissing: false };
    }
    // Phase D: 원문은 항상 암호화 업로드(NSE1). DEK 없으면 평문 폴백 금지(크립토-슈레딩 보장).
    // 저장소와 DEK 는 **같은 판정**에서 나와야 한다 — 갈리면 팀 키로 잠근 것이 개인 자리에
    // 놓이거나 그 반대가 되어, 나중에 읽을 수 없는 객체가 생긴다.
    const team = this.teamBlobFor(keyPath);
    const dek = await this.nanalDek(team);
    if (!dek) return { ok: false, dekMissing: true };
    const encBody = await encryptBlob(dek, hash, "blob", origBytes); // 계약: hash === sha256(origBytes)
    const encHash = await sha256HexBytes(encBody);
    const ok = await this.nanalPutBlob(
      hash, hash, ext, "application/octet-stream", encBody.buffer as ArrayBuffer, false, team, encHash);
    return { ok, dekMissing: false };
  }

  /// 원문 업로드 실패 안내 — 메모리 경로와 스트리밍 경로가 같은 문구를 쓰게 한 곳에 모은다.
  /// 402 backoff 가 원인이면 nanalQuotaFull Notice 가 이미 떴다("재시도 예정" 오해 문구 중복 방지).
  /// DEK 부재는 사유를 드러낸다 — 특히 410(파기)은 종결 상태라 "재시도합니다"로 오도하지 않는다.
  private noteOriginalFail(dekMissing: boolean, silent: boolean, path: string): false {
    if (!silent) {
      const dekGone = this.dekDeny.get(this.teamBlobFor(path) ? "team" : "user")?.gone === true;
      if (dekMissing) new Notice(dekGone ? t.nanalDekGone : t.nanalMirrorFail("storage key"));
      else new Notice(Date.now() < this.storageQuotaBackoffUntil ? t.nanalQuotaFull : t.nanalMirrorFail("upload"));
    }
    return false;
  }

  /// 원문이 올라간 뒤의 증명 업로드(공용).
  /// v2b: nanal 저장용 proof 는 청크 참조 v2 — 체인 구간 중복을 .chain 청크가 대신한다.
  /// 구서버는 v 파라미터를 무시하고 v1 을 반환한다(우아한 강등).
  private async putProofAfterOriginal(file: TFile, hash: string, proofBody: string, silent: boolean): Promise<boolean> {
    let nanalProofBody = proofBody;
    try {
      const v2 = await requestUrl({
        url: `${this.base()}/attest/bundle?hash=${hash}&v=2`, method: "GET",
        // 그 봉인이 들어간 계정에게 묻는다 — 개인 키로 팀 봉인을 물으면 v2 를 못 받아
        // proof 가 v1 로 떨어진다(조용한 강등이라 아무도 모른다).
        headers: { "x-nanal-api-key": this.keyFor(this.teamBlobFor(file.path)) }, throw: false,
      });
      if (v2.status === 200 && v2.json?.found) nanalProofBody = JSON.stringify(v2.json, null, 2);
    } catch { /* v1 폴백 */ }
    const proofHash = await sha256Hex(nanalProofBody);
    if (!(await this.nanalPutBlob(hash, proofHash, PROOF_EXT, "application/json", nanalProofBody, true, this.teamBlobFor(file.path)))) {
      if (!silent) new Notice(Date.now() < this.storageQuotaBackoffUntil ? t.nanalQuotaFull : t.nanalMirrorFail("proof upload"));
      return false;
    }
    if (!silent) new Notice(t.nanalMirrorOk);
    return true;
  }

  /// 파일 전체 해시를 스트리밍으로 — 힙에 올리지 않는다.
  /// WebCrypto 에 증분 해시가 없어 Node 의 createHash 를 쓴다(데스크톱 전용).
  /// 64MiB 마다 이벤트 루프에 양보한다 — 625MB 파일에서 UI 가 1초 가까이 멈추지 않게.
  protected async hashFileStream(abs: string): Promise<string> {
    const fs = nodeReq("fs");
    const h = nodeReq("crypto").createHash("sha256");
    const fd = fs.openSync(abs, "r");
    try {
      const buf = Buffer.allocUnsafe(1 << 20);
      let pos = 0, since = 0;
      for (;;) {
        const n = fs.readSync(fd, buf, 0, buf.length, pos);
        if (n <= 0) break;
        h.update(buf.subarray(0, n));
        pos += n; since += n;
        if (since >= (64 << 20)) { since = 0; await new Promise((r) => window.setTimeout(r, 0)); }
      }
    } finally { fs.closeSync(fd); }
    return h.digest("hex");
  }

  /// vault 파일의 절대 경로(데스크톱만). 스트리밍 업로드는 Obsidian 이 아니라 파일시스템에서 읽는다.
  protected absPathOf(file: TFile): string | null {
    const ad = this.app.vault.adapter;
    if (!(ad instanceof FileSystemAdapter)) return null;
    try { return nodeReq("path").join(ad.getBasePath(), file.path); } catch { return null; }
  }

  /// 원본을 **파일에서** 올린다 — 힙에 통째로 올리지 않는다.
  /// 임계 이하는 어차피 작으므로(512KiB) 읽어서 기존 경로를 그대로 쓴다.
  protected async putOriginalFile(
    hash: string, ext: string, abs: string, size: number, keyPath: string,
  ): Promise<{ ok: boolean; dekMissing: boolean }> {
    if (size > CHUNK_THRESHOLD) {
      return { ok: await this.nanalPutChunked(hash, ext, { abs, size }, keyPath), dekMissing: false };
    }
    return this.putOriginalBytes(hash, ext, this.readFileRange(abs, 0, size), keyPath);
  }

  /// 복구용 업로드(파일 경로) — 대형 첨부를 힙에 올리지 않는다.
  async uploadRecoveredFile(
    relPath: string, hash: string, abs: string, size: number, proofBody: string,
  ): Promise<boolean> {
    if (!this.nanalActive()) return false;
    if (this.nanalUploading.has(relPath)) return false;
    this.nanalUploading.add(relPath);
    try {
      const ext = isMarkdownPath(relPath) ? "md" : blobExt(relPath);
      const { ok } = await this.putOriginalFile(hash, ext, abs, size, relPath);
      if (!ok) return false;
      const proofHash = await sha256Hex(proofBody);
      return await this.nanalPutBlob(hash, proofHash, PROOF_EXT, "application/json", proofBody, true, this.teamBlobFor(relPath));
    } catch { return false; } finally { this.nanalUploading.delete(relPath); }
  }

  /// 복구용 업로드 — 지워진 노트도 올린다(vault 에 파일이 없어도 된다).
  /// 봉인 시점 경로와 **같은 함수**로 올리므로 형식이 갈리지 않는다.
  async uploadRecoveredBytes(
    relPath: string, hash: string, bytes: Uint8Array, proofBody: string,
  ): Promise<boolean> {
    if (!this.nanalActive()) return false;
    if (this.nanalUploading.has(relPath)) return false;
    this.nanalUploading.add(relPath);
    try {
      if ((await sha256HexBytes(bytes)) !== hash) return false;   // 계약 가드
      const ext = isMarkdownPath(relPath) ? "md" : blobExt(relPath);
      const { ok } = await this.putOriginalBytes(hash, ext, bytes, relPath);
      if (!ok) return false;
      const proofHash = await sha256Hex(proofBody);
      return await this.nanalPutBlob(hash, proofHash, PROOF_EXT, "application/json", proofBody, true, this.teamBlobFor(relPath));
    } catch {
      return false;
    } finally {
      this.nanalUploading.delete(relPath);
    }
  }

  protected async mirrorToNanal(file: TFile, hash: string, proofBody: string, silent = false, original?: string | ArrayBuffer): Promise<boolean> {
    if (!this.nanalActive()) return false;
    // 업로드 게이트(최종 방어선): 팀 정책 또는 서버 하드캡(5GB — 초과 presign은 400) 초과면 선차단·스킵 기록.
    // 봉인(해시 증명)은 이미 유효 — 여기서 걸려도 원본 클라우드 보관만 빠진다(attachSkipped로 노출).
    if (this.overUploadLimit(file)) { void this.noteUploadSkip(file); return false; }
    void this.clearUploadSkip(file.path); // 한도 이내(파일 축소·정책 완화 포함) — 과거 스킵 기록 해제
    this.maybeNoticeLargeUpload(file);    // 대형 파일 정보성 안내(차단 아님, 세션당 1회)
    if (this.nanalUploading.has(file.path)) return false; // 업로드 진행 중 — 재시도가 재포착
    this.nanalUploading.add(file.path);
    try {
      const ext = this.isBinary(file) ? blobExt(file.path) : "md";
      // 대형 첨부는 파일에서 곧장 스트리밍한다 — 힙에 통째로 올리면 625MB 파일 하나가 그만큼을
      // 차지한다(실측 +631MB). 이미 원문이 넘어왔다면(작은 노트 경로) 그대로 쓴다.
      const streamAbs = (original == null && this.isBinary(file) && file.stat.size > CHUNK_THRESHOLD)
        ? this.absPathOf(file) : null;
      if (streamAbs) {
        const r = await this.putOriginalFile(hash, ext, streamAbs, file.stat.size, file.path);
        if (!r.ok) return this.noteOriginalFail(r.dekMissing, silent, file.path);
        return this.putProofAfterOriginal(file, hash, proofBody, silent);
      }
      if (original == null) original = this.isBinary(file) ? await this.app.vault.readBinary(file) : await this.app.vault.read(file);
      const origBytes = typeof original === "string" ? new TextEncoder().encode(original) : new Uint8Array(original);
      // Phase D 계약 가드: 암호화 키·nonce가 hash에서 파생되므로 내용≠hash 업로드는 GCM 붕괴.
      // 과거엔 S3 평문 checksum이 이를 거부했지만 이제 checksum은 암호문 해시라 여기서 직접 막는다.
      // (재읽기 경로에서 봉인 후 파일이 바뀐 레이스 — false 반환이면 기존 재시도가 재봉인분을 재포착.)
      if ((await sha256HexBytes(origBytes)) !== hash) return false;
      // v2a: 대형 원본(>512KB)은 CDC 조각+manifest — 변경분만 업로드·과금. 이하는 단일 객체.
      // Phase D: 원문은 항상 암호화 업로드(NSE1). DEK 조회 실패·410(파기)이면 업로드 중단 —
      // 평문 폴백 금지(크립토-슈레딩 보장). 암호문이므로 content-type은 octet-stream.
      // 키·게이트는 평문 해시(hash) 그대로 — 수렴 암호화라 dedup·exists도 평문 해시로 정합.
      const { ok: okOriginal, dekMissing } = await this.putOriginalBytes(hash, ext, origBytes, file.path);
      if (!okOriginal) return this.noteOriginalFail(dekMissing, silent, file.path);
      return this.putProofAfterOriginal(file, hash, proofBody, silent);
    } catch (e: any) {
      console.error("[nanalstamp] nanal storage error", file.path, e);
      if (!silent) new Notice(t.nanalMirrorFail(e?.message ?? String(e)));
      return false;
    } finally {
      this.nanalUploading.delete(file.path);
    }
  }

  // B: blob 존재 일괄 확인(/storage/exists) — 증빙 모달이 '실제 저장된 곳만' 버튼을 노출할 때 쓴다.
  // 실패·미지원 서버는 null(버튼 생략 — 잡음 금지).
  async nanalExists(items: Array<{ sha256: string; ext: string }>, team = this.teamNanal()): Promise<boolean[] | null> {
    if (!this.settings.apiKey || items.length === 0) return null;
    try {
      const res = await requestUrl({
        url: storageEndpoint(this.base(), team, "exists"),
        method: "POST",
        headers: { "content-type": "application/json", "x-nanal-api-key": this.keyFor(team) },
        body: JSON.stringify({ items }),
        throw: false,
      });
      if (res.status !== 200 || !Array.isArray(res.json?.exists)) return null;
      return res.json.exists.map((x: any) => x === true);
    } catch { return null; }
  }

  // 보관 대기의 전역 사유(있으면) — 대기 모달 상단 표시용. 파일별 사유 추적은 YAGNI(전역 상태로 90% 진단).
  storagePendingReason(): string | null {
    if (Date.now() < this.storageQuotaBackoffUntil) {
      return t.pendReasonQuota(Math.max(1, Math.ceil((this.storageQuotaBackoffUntil - Date.now()) / 60000)));
    }
    if (this.dekDeny.get(this.teamNanal() ? "team" : "user")?.gone) return t.pendReasonShredded;
    return null;
  }

  // C2 폴백 읽기 래퍼: geturl(팀/개인 라우트) → presigned GET. 팀 모드에서 404(라우트 404 또는 S3 404)면
  // 개인 라우트(/storage/geturl)로 1회 재시도 — 팀 전환 전 개인 네임스페이스(u/)에 저장된 기존 blob의
  // 열람을 보장한다(전환 갭 — "자기 데이터 회수 보장" 원칙, 2026-07-15 결정). 모든 읽기(nanalFetch 단일·
  // manifest 재조립·proof/chain)가 이 래퍼를 지난다. 쓰기·exists는 폴백 없음(쓰기는 팀 단독 저장 결정 유지,
  // exists는 HEAD 2배 비용이라 생략 — 열람 버튼 미노출은 수용).
  // Phase D: 본문은 항상 바이트로 받고, NSE1 프레임이면 '실제로 서빙한 라우트'(팀 폴백 결과)의 DEK로 복호해
  // 평문 바이트를 돌려준다 — 호출부의 기존 평문 해시 검증·재조립은 무변경. plainHash는 이 blob의 키인 sha256
  // 인자 그대로(단일·조각·manifest 모두 그 해시로 암호화됐다), 도메인은 ext로 구분.
  // encHash(암호화 manifest의 chash)가 있으면 복호 전에 암호문 해시를 대조해 조기 검증한다.
  // 복호 실패는 '우연히 NSE1로 시작하는 구 평문'일 수 있으므로 원본 바이트로 폴백 — 최종 게이트는 호출부의
  // 평문 해시 대조. DEK 조회 실패(410 파기 등)는 throw → 호출부 catch가 nanalRestoreFail로 표면화.
  protected async nanalGetObject(sha256: string, ext: string, encHash?: string): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; status: number }> {
    const attempt = async (team: boolean): Promise<{ ok: true; dl: RequestUrlResponse; team: boolean } | { ok: false; status: number }> => {
      const res = await requestUrl({
        url: storageEndpoint(this.base(), team, "geturl"), method: "POST",
        headers: { "content-type": "application/json", "x-nanal-api-key": this.keyFor(team) },
        body: JSON.stringify({ sha256, ext }), throw: false,
      });
      if (res.status !== 200) return { ok: false, status: res.status };
      const dl = await requestUrl({ url: res.json.url, method: "GET", throw: false });
      if (dl.status !== 200) return { ok: false, status: dl.status };
      return { ok: true, dl, team };
    };
    let got = await attempt(this.teamNanal());
    if (!got.ok && got.status === 404 && this.teamNanal()) got = await attempt(false);
    if (!got.ok) return got;
    let bytes: Uint8Array = new Uint8Array(got.dl.arrayBuffer);
    if (isEncrypted(bytes)) {
      if (encHash && (await sha256HexBytes(bytes)) !== encHash) throw new Error("hash");
      const dek = await this.nanalDek(got.team);
      if (!dek) throw new Error("storage key unavailable");
      try {
        bytes = await decryptBlob(dek, sha256, ext === "manifest" ? "manifest" : "blob", bytes);
      } catch { /* 구 평문이 우연히 NSE1로 시작한 경우 — 원본 바이트 유지, 평문 해시 검증이 판정 */ }
    }
    return { ok: true, bytes };
  }

  // B: 스토리지 blob 다운로드 + sha256 재검증(스토리지가 오염됐어도 해시 불일치로 감지 — 신뢰 앵커는 해시).
  // 실패는 사용자에게 보여줄 i18n 문자열로 반환(404 = 봉인됐지만 아직 업로드 안 된 버전).
  async nanalFetch(hash: string, ext: string, isMd: boolean): Promise<{ data: string | ArrayBuffer } | { error: string }> {
    if (!this.settings.apiKey) return { error: t.apiKeyMissing };
    try {
      const got = await this.nanalGetObject(hash, ext);
      if (!got.ok) {
        if (got.status === 404) return await this.nanalFetchChunked(hash, isMd); // v2a: 대형 원본은 manifest로 저장됨
        if (got.status === 429) return { error: t.egressLimit }; // egress 월 한도(서버 계량)
        return { error: t.nanalRestoreFail(String(got.status)) };
      }
      // Phase D: 복호(또는 평문 통과)된 바이트의 해시가 봉인 해시와 일치해야 한다 — 신뢰 앵커는 해시.
      if ((await sha256HexBytes(got.bytes)) !== hash) return { error: t.nanalRestoreBadHash };
      if (isMd) return { data: new TextDecoder().decode(got.bytes) };
      return { data: got.bytes.buffer.slice(got.bytes.byteOffset, got.bytes.byteOffset + got.bytes.byteLength) as ArrayBuffer };
    } catch (e: any) {
      return { error: t.nanalRestoreFail(e?.message ?? String(e)) };
    }
  }

  // v2a: manifest 재조립 복원 — 조각별 해시 검증 + 전체 해시 == 봉인 해시 재검증(뷰의 기존 원칙).
  protected async nanalFetchChunked(hash: string, isMd: boolean): Promise<{ data: string | ArrayBuffer } | { error: string }> {
    try {
      const got = await this.nanalGetObject(hash, "manifest"); // C2: 개인 네임스페이스 폴백 포함
      if (!got.ok) return got.status === 404 ? { error: t.nanalRestoreNone } : { error: t.nanalRestoreFail(String(got.status)) };
      const m = parseManifest(new TextDecoder().decode(got.bytes));
      if (!m) return { error: t.nanalRestoreBadHash };
      // 할당 전 합계 검증 — 손상된 manifest의 거대 total_size가 먼저 할당을 시도하지 않도록.
      const offsets: number[] = [];
      let acc = 0;
      for (const c of m.chunks) { offsets.push(acc); acc += c.size; }
      if (acc !== m.totalSize) return { error: t.nanalRestoreBadHash };
      // 손상·악성 manifest의 거대 할당 조기 차단(자기 버킷 한정이지만 fail-fast)
      if (m.totalSize > 1024 * 1024 * 1024) return { error: t.nanalRestoreBadHash };
      const out = new Uint8Array(m.totalSize);
      // 5개 단위 병렬 다운로드(순서는 오프셋으로 보존)
      for (let i = 0; i < m.chunks.length; i += 5) {
        const batch = m.chunks.slice(i, i + 5).map(async (c, j) => {
          // Phase D: enc manifest면 chash로 다운로드 암호문을 복호 전에 조기 검증(래퍼 내부) — 최종은 평문 해시.
          const cg = await this.nanalGetObject(c.hash, "chunk", m.enc ? c.chash : undefined); // C2: 개인 네임스페이스 폴백 포함
          if (!cg.ok) throw new Error(String(cg.status));
          if (cg.bytes.byteLength !== c.size || (await sha256HexBytes(cg.bytes)) !== c.hash) throw new Error("hash");
          out.set(cg.bytes, offsets[i + j]);
        });
        try { await Promise.all(batch); }
        catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return msg === "hash" ? { error: t.nanalRestoreBadHash } : { error: t.nanalRestoreFail(msg) };
        }
      }
      if (isMd) {
        const text = new TextDecoder().decode(out);
        if ((await sha256Hex(text)) !== hash) return { error: t.nanalRestoreBadHash };
        return { data: text };
      }
      const full = out.buffer as ArrayBuffer;
      if ((await sha256HexBytes(full)) !== hash) return { error: t.nanalRestoreBadHash };
      return { data: full };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { error: t.nanalRestoreFail(msg) };
    }
  }

  // v2b: nanal 오브젝트 텍스트 다운로드(geturl → GET). proof/chain 전용 경량 헬퍼.
  protected async nanalDownloadText(sha256: string, ext: string): Promise<{ text: string } | { error: string }> {
    try {
      const got = await this.nanalGetObject(sha256, ext); // C2: 개인 네임스페이스 폴백 포함
      if (!got.ok) return got.status === 404 ? { error: t.nanalRestoreNone } : { error: t.nanalRestoreFail(String(got.status)) };
      return { text: new TextDecoder().decode(got.bytes) }; // proof/chain은 비암호화(검증 표면) — 래퍼는 평문 통과
    } catch (e: unknown) {
      return { error: t.nanalRestoreFail(e instanceof Error ? e.message : String(e)) };
    }
  }

  // v2b: nanal 보관 proof를 자기완결 v1로 재조립 — np-verify에 그대로 넣을 수 있는 형태.
  // v1이 저장돼 있으면 그대로 반환. v2면 chain_refs의 .chain 청크를 받아(해시 검증) segment를 복원.
  protected async nanalProofAsV1(hash: string): Promise<{ data: string } | { error: string }> {
    const got = await this.nanalDownloadText(hash, PROOF_EXT);
    if ("error" in got) return got;
    let proof: any;
    try { proof = JSON.parse(got.text); } catch { return { error: t.nanalRestoreBadHash }; }
    if (proof?.version !== 2) return { data: got.text }; // v1 — 이미 자기완결
    const entries: any[] = [];
    for (const ref of proof.chain_refs ?? []) {
      const c = await this.nanalDownloadText(String(ref.sha256), "chain");
      if ("error" in c) return c;
      if ((await sha256Hex(c.text)) !== String(ref.sha256)) return { error: t.nanalRestoreBadHash };
      try { entries.push(...JSON.parse(c.text)); } catch { return { error: t.nanalRestoreBadHash }; }
    }
    entries.push(...(proof.tail ?? []));
    const headSeq: number = typeof proof.anchor?.head_seq === "number" ? proof.anchor.head_seq : Number.MAX_SAFE_INTEGER;
    const matched: number = typeof proof.matched_seq === "number" ? proof.matched_seq : 0;
    const segment = entries
      .filter((e) => typeof e?.seq === "number" && e.seq >= matched && e.seq <= headSeq)
      .sort((a, b) => a.seq - b.seq);
    const v1 = {
      version: 1, found: true, issuer: proof.issuer ?? "nanalStamp",
      file_hash: proof.file_hash, matched_seq: proof.matched_seq, matched_path: proof.matched_path,
      segment, anchor: proof.anchor ?? null, reviews: proof.reviews ?? [], pubkey_b64: proof.pubkey_b64,
    };
    return { data: JSON.stringify(v1, null, 2) };
  }

  protected nanalDek(team: boolean): Promise<string | null> {
    const k = team ? "team" : "user";
    const deny = this.dekDeny.get(k);
    if (deny && Date.now() < deny.until) return Promise.resolve(null);
    const hit = this.dekCache.get(k);
    if (hit) return hit;
    const p = this.fetchDek(k, team);
    this.dekCache.set(k, p);
    return p;
  }

  /// team 은 **호출자가 경로로 판정해** 넘긴다(`teamBlobFor(path)`). 기본값이 없는 것은 의도다 —
  /// 빠뜨린 자리가 조용히 팀 저장소로 가는 것이 2026-07-31 에 겪은 사고다.
  protected async nanalPutBlob(sealedHash: string, blobHash: string, ext: string, contentType: string, body: string | ArrayBuffer, force: boolean, team: boolean, encSha256?: string): Promise<boolean> {
    if (Date.now() < this.storageQuotaBackoffUntil) return false;
    // 거부된 키로 계속 밀지 않는다 — 원문·증명·청크·manifest 쓰기가 전부 이 함수를 지나므로
    // 여기 한 곳이면 충분하다. team 인자는 바로 아래 keyFor 에 넘기는 것과 같은 값이다(P-03).
    if (this.authFailedFor(team)) return false;
    const size = bodyByteSize(body);
    const pre = await this.requestWithOneRetry(() => requestUrl({
      url: storageEndpoint(this.base(), team, "presign"),
      method: "POST",
      headers: { "content-type": "application/json", "x-nanal-api-key": this.keyFor(team) },
      body: JSON.stringify({ sha256: sealedHash, blob_sha256: blobHash, ext, content_type: contentType, force, size, enc_sha256: encSha256 }),
      throw: false,
    }));
    if (!pre) { console.error("[nanalstamp] storage presign network fail"); return false; }
    if (pre.status === 402) {
      // 병렬 업로드 중 여러 조각이 동시에 402를 받아도 Notice는 최초 1회만(backoff 선점 여부로 판정).
      const first = Date.now() >= this.storageQuotaBackoffUntil;
      this.storageQuotaBackoffUntil = Date.now() + 3_600_000;
      if (first) new Notice(t.nanalQuotaFull);
      return false;
    }
    // 키 거부는 재시도로 낫지 않는다 — 해당 계정만 세우고 다음 호출은 첫머리 가드가 조용히 막는다.
    // 분기·Notice·상태바는 markAuthFailed 가 flush 의 401 과 똑같이 처리한다(P-03).
    // **presign 응답만** 본다: 아래 PUT 은 S3 presigned URL 이라 403 이 서명·만료 문제일 수 있고,
    // 그것으로 키를 죽이면 멀쩡한 계정의 보관이 통째로 멈춘다.
    if (pre.status === 401 || pre.status === 403) { this.markAuthFailed(team); return false; }
    if (pre.status !== 200) { console.error("[nanalstamp] storage presign", pre.status, pre.json?.error ?? ""); return false; }
    if (pre.json?.exists) return true; // 이미 저장됨(콘텐츠주소 중복제거)
    const put = await this.requestWithOneRetry(() => requestUrl({
      url: pre.json.url,
      method: "PUT",
      headers: { "content-type": contentType, "x-amz-checksum-sha256": hexToBase64(encSha256 ?? blobHash) },
      body,
      throw: false,
    }));
    if (!put) { console.error("[nanalstamp] storage put network fail"); return false; }
    if (put.status < 200 || put.status >= 300) { console.error("[nanalstamp] storage put", put.status, put.text?.slice?.(0, 200) ?? ""); return false; }
    return true;
  }

  // v2a: 대형 원본 CDC 업로드. 조각은 자기 해시 키(공유), manifest는 원문 해시 키(완료 마커 — 마지막 업로드).
  // 부분 실패 시 manifest 부재 = 미완료 → 기존 재시도가 재포착하고, 올라간 조각은 exists 스킵(이어올리기).
  // Phase D: 조각·manifest 모두 NSE1 암호화 업로드. exists 확인은 평문 해시 그대로(수렴 암호화 정합).
  /// 조각을 어디서 가져오는지만 다른 두 경로 — 메모리 버퍼 / **파일 스트리밍**.
  /// 대형 첨부를 통째로 힙에 올리지 않기 위한 것이고, 경계 규칙은 nextCut 하나를 공유하므로
  /// 두 경로가 만드는 조각은 바이트 단위로 같다(chunkcore.test.ts 가 고정).
  protected async nanalPutChunked(
    sealedHash: string, ext: string, src: Uint8Array | { abs: string; size: number }, path: string,
  ): Promise<boolean> {
    if (Date.now() < this.storageQuotaBackoffUntil) return false;
    try {
      // 원문 수준 dedup: 같은 내용이 이미 단일 객체(.ext) 또는 manifest로 저장돼 있으면 즉시 완료
      // (단일 객체 경로의 presign HEAD dedup에 대응 — 없으면 동일 내용을 조각으로 중복 업로드하게 된다)
      const team = this.teamBlobFor(path);
      const whole = await this.nanalExists([{ sha256: sealedHash, ext }], team);
      if (whole && whole[0]) return true;
      const dek = await this.nanalDek(team);
      if (!dek) return false; // 평문 폴백 금지 — DEK 없이는(파기 포함) 업로드 중단
      // 조각 목록(해시·크기)과 "i번째 조각 바이트를 달라"는 접근자. 파일 경로면 그때그때 읽어
      // 힙에 남는 것은 **동시에 처리 중인 조각뿐**이다(최대 UPLOAD_CONCURRENCY × 4MiB).
      let hashes: string[]; let sizes: number[]; let totalSize: number;
      let chunkAt: (i: number) => Promise<Uint8Array>;
      if (src instanceof Uint8Array) {
        const parts = cdcChunks(src);
        hashes = [];
        for (const p of parts) {
          const buf = p.buffer.slice(p.byteOffset, p.byteOffset + p.byteLength) as ArrayBuffer;
          hashes.push(await sha256HexBytes(buf));
        }
        sizes = parts.map((p) => p.byteLength);
        totalSize = src.byteLength;
        chunkAt = async (i) => parts[i];
      } else {
        const { plan, whole } = await this.planChunksOfFile(src.abs, src.size);
        // 계약 가드(암호화 키·nonce가 평문 해시에서 파생된다): 봉인 이후 파일이 바뀌었으면 중단.
        // 그 새 내용은 자기 자신의 봉인이 다시 올린다.
        if (whole !== sealedHash) return false;
        hashes = plan.map((p) => p.hash);
        sizes = plan.map((p) => p.size);
        totalSize = src.size;
        chunkAt = async (i) => this.readFileRange(src.abs, plan[i].off, plan[i].size);
      }
      const partCount = hashes.length;
      // 존재 일괄 확인(서버 상한 50/호출) — 있는 조각은 업로드·쿼터 0
      const have: boolean[] = new Array(partCount).fill(false);
      for (let i = 0; i < hashes.length; i += 50) {
        const res = await this.nanalExists(hashes.slice(i, i + 50).map((h) => ({ sha256: h, ext: "chunk" })), team);
        if (res) for (let j = 0; j < res.length; j++) have[i + j] = res[j];
      }
      // 존재하는 조각도 chash·csize는 manifest에 필요 — 수렴 암호화라 재암호화 결과가 결정적으로 동일.
      // 업로드는 UPLOAD_CONCURRENCY(3)개 제한 병렬: 인덱스 공유 워커 풀 — 각 워커가 다음 조각을 집어
      // 암호화(경량 CPU)→업로드. 조각 하나라도 최종 실패면 failed를 세워 새 조각을 집지 않고 전체 false
      // (manifest는 전 조각 성공 후에만 — 기존 시맨틱 유지. 이미 올라간 조각은 다음 재시도의 exists가 스킵).
      const encMeta: { chash: string; csize: number }[] = new Array(partCount);
      const toUpload = have.reduce((n, h) => n + (h ? 0 : 1), 0);
      let uploaded = 0;
      if (toUpload > 0) this.setUploadProgress({ path, done: 0, total: toUpload });
      let nextIdx = 0;
      let failed = false;
      const worker = async (): Promise<void> => {
        while (!failed) {
          const i = nextIdx++;
          if (i >= partCount) return;
          const encChunk = await encryptBlob(dek, hashes[i], "blob", await chunkAt(i)); // 계약: hashes[i] === sha256(조각)
          const chash = await sha256HexBytes(encChunk);
          encMeta[i] = { chash, csize: encChunk.byteLength };
          if (have[i]) continue;
          if (!(await this.nanalPutBlob(sealedHash, hashes[i], "chunk", "application/octet-stream", encChunk.buffer as ArrayBuffer, false, team, chash))) { failed = true; return; }
          uploaded++;
          if (this.uploadProgress?.path === path) this.setUploadProgress({ path, done: uploaded, total: toUpload });
        }
      };
      await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, partCount) }, () => worker()));
      if (failed) return false;
      // manifest는 결정적(같은 원문 = 같은 내용·같은 DEK = 같은 암호문)이라 force 불필요 — 재시도 시 HEAD dedup이 스킵.
      // blob_sha256은 평문 manifest 해시 유지(재시도 dedup의 근거), 암호화 plainHash는 sealedHash + "manifest" 도메인
      // (원문 blob의 "blob" 도메인과 분리 — 같은 sealedHash라도 키·nonce가 다르다).
      const manifest = buildManifest(hashes.map((h, i) => ({ hash: h, size: sizes[i], chash: encMeta[i].chash, csize: encMeta[i].csize })), totalSize, true);
      const manifestBytes = new TextEncoder().encode(manifest);
      const encManifest = await encryptBlob(dek, sealedHash, "manifest", manifestBytes);
      // content-type도 octet-stream — 본문이 JSON이 아니라 NSE1 암호문이므로(단일 객체 경로와 일관)
      return await this.nanalPutBlob(sealedHash, await sha256HexBytes(manifestBytes), "manifest", "application/octet-stream", encManifest.buffer as ArrayBuffer, false, team, await sha256HexBytes(encManifest));
    } catch (e) {
      console.error("[nanalstamp] chunked upload", e);
      return false;
    } finally {
      // 완료·실패 공통: 이 파일의 진행 표시 해제(다른 파일의 동시 업로드 진행 표시는 건드리지 않음)
      if (this.uploadProgress?.path === path) this.setUploadProgress(null);
    }
  }

  /// 파일을 조금씩 읽어 조각 경계·평문 해시만 만든다(**메모리 상수**). 데스크톱 전용.
  /// 실측: 625MB 파일에서 전체 버퍼 방식 +631MB vs 이 방식 +5MB, 조각 516개 전부 일치(2026-07-30).
  /// 전체 해시도 **같은 읽기에서** 함께 구한다. 봉인 후 파일이 바뀌었는지 확인하려면 전체 해시가
  /// 필요한데, 그걸 위해 파일을 한 번 더 읽으면 스트리밍의 의미가 반감된다.
  /// (WebCrypto 에는 증분 해시가 없어 Node 의 createHash 를 쓴다 — 데스크톱 전용 경로다.)
  protected async planChunksOfFile(
    abs: string, size: number,
  ): Promise<{ plan: Array<{ hash: string; size: number; off: number }>; whole: string }> {
    const fs = nodeReq("fs");
    const whole = nodeReq("crypto").createHash("sha256");
    const plan: Array<{ hash: string; size: number; off: number }> = [];
    const fd = fs.openSync(abs, "r");
    try {
      const buf = Buffer.allocUnsafe(CHUNK_MAX);
      let filled = 0, pos = 0, off = 0;
      for (;;) {
        // nextCut 의 계약: CHUNK_MAX 까지 채우거나 파일 끝이어야 한다.
        while (filled < CHUNK_MAX && pos < size) {
          const n = fs.readSync(fd, buf, filled, Math.min(CHUNK_MAX - filled, size - pos), pos);
          if (n <= 0) break;
          filled += n; pos += n;
        }
        if (filled === 0) break;
        const cut = nextCut(buf, filled);
        whole.update(buf.subarray(0, cut));   // 조각 순서 = 파일 순서
        plan.push({ hash: await sha256HexBytes(buf.buffer.slice(buf.byteOffset, buf.byteOffset + cut)), size: cut, off });
        off += cut;
        buf.copyWithin(0, cut, filled);
        filled -= cut;
      }
    } finally { fs.closeSync(fd); }
    return { plan, whole: whole.digest("hex") };
  }

  /// 파일의 한 구간만 읽는다(조각 하나). 워커가 병렬로 부르므로 매번 열고 닫는다 —
  /// position 을 명시하는 읽기라 공유 fd 의 오프셋 경쟁이 없다.
  protected readFileRange(abs: string, off: number, len: number): Uint8Array {
    const fs = nodeReq("fs");
    const fd = fs.openSync(abs, "r");
    try {
      const b = Buffer.allocUnsafe(len);
      let got = 0;
      while (got < len) {
        const n = fs.readSync(fd, b, got, len - got, off + got);
        if (n <= 0) break;
        got += n;
      }
      return new Uint8Array(b.buffer, b.byteOffset, got);
    } finally { fs.closeSync(fd); }
  }

}
