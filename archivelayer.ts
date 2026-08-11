// archivelayer.ts — 로컬 git 아카이브·계보(rename 추적)·그날로(복원)·GitHub 미러.
// main.ts에서 **본문 무변경**으로 이동(2026-07-26). 상속 순서:
//   NanalStampPlugin → ArchiveLayer → StorageLayer → NanalStampBase → Plugin
// StorageLayer 위에 두는 이유: 아카이브가 S3 전송(nanalFetch 등)을 부르지만 그 반대는 없다.
import { FileSystemAdapter, Notice, Platform, TFile } from "obsidian";
import * as git from "isomorphic-git";
import { t } from "./i18n";
import { fmtDateTime } from "./fmtutil";
import { nodeReq, sha256HexBytes, basenameOf, safeName, hashPath } from "./pathutil";
import { REWIND_LOG_TTL_MS, ARCHIVE_INLINE_MAX, ARCHIVE_REF_EXT } from "./constants";
import { blobExt, restoredPath } from "./storagecore";
import { ArchiveVersionModal, AttachmentVersionModal } from "./modals";
import { buildArchiveMsg, parseArchiveMsg, archiveNotePath } from "./archivemsg";
import { RewindEntry, parseRewindCommit, pathSpans, collapseRenames, successorCandidates } from "./rewindcore";
import { ArchiveEntry, parseArchiveCommit } from "./dashcore";
import { isMarkdownPath } from "./sealscope";
import { StorageLayer } from "./storagelayer";
// 모달 2종은 최종 클래스(NanalStampPlugin) 타입을 받는다. 이 계층에서 `this`는 아직
// ArchiveLayer이므로 다운캐스트가 필요하다 — 런타임에는 항상 NanalStampPlugin 인스턴스다.
import type NanalStampPlugin from "./main";

export abstract class ArchiveLayer extends StorageLayer {
  protected archiveBusy: Promise<unknown> = Promise.resolve();
  protected lineageCache = new Map<string, string | null>(); // `${old}|${lastOid}` → 후계 경로(검증 완료) 또는 null(못 찾음)
  protected lineageResult: { log: RewindEntry[]; map: Record<string, string> } | null = null; // 같은 로그 스냅샷이면 통째로 재사용
  protected rewindLogCache: { at: number; entries: RewindEntry[] } | null = null;

  // 데스크탑만. archivePath는 vault 밖 절대경로라 Node fs로 다룬다. 모든 git 연산은
  // archiveBusy 락에 태워 sweep·활성노트 동시 호출 시 repo 손상을 막는다.
  // 로컬 아카이브는 **끌 수 있는 기능이 아니다.** 원본 없이 해시만 남으면 봉인은 됐는데
  // 무엇을 봉인했는지 보일 수 없다 — 제품이 성립하지 않는다. FREE 는 이것이 유일한 원본
  // 보관처이고, 유료도 이것이 있어야 S3 단일 사본을 면한다. 나아가 "봉인된 바이트는
  // 반드시 아카이브에 있다"는 불변식이 전송 누락을 막는 근거다(2026-07-30).
  // 남은 제약은 물리적인 것 하나뿐 — 모바일에는 파일시스템·git 이 없다.
  protected archiveEnabled(): boolean {
    return Platform.isDesktopApp;
  }

  protected runArchive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.archiveBusy.then(fn, fn);
    this.archiveBusy = next.then(() => undefined, () => undefined);
    void next.then(() => this.touchGitCache(), () => this.touchGitCache());
    return next;
  }

  // ── isomorphic-git 공유 캐시 ───────────────────────────────────────────────
  //
  // 왜 있나(2026-07-31 실측): 아카이브가 커지면 .git 이 팩파일 하나로 뭉친다(이 기기 906MB).
  // 팩에서 객체 하나를 꺼내려면 팩 색인을 읽고 델타 사슬을 되풀어야 하는데, 호출마다
  // 처음부터 다시 하면 **읽기 하나가 0.28초**다(Obsidian 안에서는 3.4초까지 나왔다).
  //
  //   1,534건 읽기 — 캐시 없음 82분(추정) · 공유 캐시 4초
  //
  // 이 때문에 증빙 대시보드가 **아예 렌더되지 않았다**(그날로 카드가 삭제 후보 1,434건을
  // 하나씩 읽다 멎었다). isomorphic-git 은 이럴 때 쓰라고 cache 인자를 받는데 우리는
  // 넘기지 않았고, 넘기는 세 군데도 매번 **빈 객체를 새로 만들어** 호출 사이에 아무것도
  // 남지 않았다.
  //
  // 캐시는 팩 색인과 되푼 객체를 들고 있어 위 측정에서 240MB 늘었다. 그래서 **영구히
  // 들고 있지 않는다** — 마지막 아카이브 작업 뒤 잠시 조용하면 통째로 버린다. 한 작업
  // (대시보드 렌더·그날로·패키지 생성) 안에서는 캐시를 온전히 나눠 쓰고, 끝나면 메모리가
  // 돌아온다.
  //
  // 상해도 되는 캐시인가: git 객체는 **내용이 곧 이름(oid)** 이라 같은 oid 는 영원히 같은
  // 바이트다. 오래된 값을 돌려줄 수가 없다.
  protected gitCache: object = {};
  private gitCacheTimer: number | null = null;   // window.setTimeout 의 반환(브라우저 런타임)
  private static readonly GIT_CACHE_IDLE_MS = 60_000;

  private touchGitCache(): void {
    if (this.gitCacheTimer) window.clearTimeout(this.gitCacheTimer);
    this.gitCacheTimer = window.setTimeout(() => {
      this.gitCache = {};
      this.gitCacheTimer = null;
    }, ArchiveLayer.GIT_CACHE_IDLE_MS);
  }

  // 아카이브 폴더 보장 + .git 없으면 git init + README 최초 커밋. 로드 시 1회 호출.
  async ensureArchive(): Promise<void> {
    if (!this.archiveEnabled()) return;
    const dir = (this.settings.archivePath || "").trim();
    if (!dir) return;
    await this.runArchive(async () => {
      const fs = nodeReq("fs");
      const path = nodeReq("path");
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(path.join(dir, ".git"))) return;
      await git.init({ fs, dir, defaultBranch: "main" });
      const readme =
        "# nanalStamp local archive\n\n" +
        "This is an automatic **local git archive** created by the nanalStamp Obsidian plugin.\n" +
        "Every time a note's Bitcoin anchor is confirmed, its exact original text and proof are\n" +
        "committed here — so past versions survive even after you edit the note.\n\n" +
        "- `notes/` — original note content (the exact bytes that were hashed).\n" +
        "- `proofs/` — one `.nanalproof` per note: a self-verifying bundle (signature, Merkle path, OpenTimestamps proof, Bitcoin block, public key).\n" +
        "- `attachments/` — attachments. Large ones are stored as a `.nanalref` pointer plus the real bytes in `blobs/<sha256>`.\n" +
        "- `blobs/` — content-addressed storage for large attachments. **Not tracked by git** (git would load each file\n" +
        "  entirely into memory to make a blob — a 625MB attachment cost 2GB of RAM). The file name *is* its SHA-256,\n" +
        "  so a changed attachment simply becomes a new file and the old one stays — same semantics as git objects.\n\n" +
        "> **Moving this archive?** Copy the whole folder. `git clone` will NOT bring `blobs/` with it,\n" +
        "> and large attachments would be lost. The plugin's own \"change archive location\" copies everything.\n\n" +
        "## Restore a past version\n\n" +
        "`git log -- notes/<name>.md` then `git show <commit>:notes/<name>.md`.\n\n" +
        "## Verify (no nanalStamp servers required)\n\n" +
        "1. SHA-256 the file in `notes/` and compare it against the hash in the matching proof.\n" +
        "2. Verify the OpenTimestamps proof against Bitcoin: `ots verify` — or use the `np-verify` helper.\n\n" +
        "The trust anchor is Bitcoin, not nanalStamp. Even if nanalStamp disappears, these stand on their own.\n";
      fs.writeFileSync(path.join(dir, "README.md"), readme, "utf8");
      await git.add({ fs, dir, filepath: "README.md" });
      await git.commit({
        fs, dir,
        message: "nanalStamp: initialize local archive",
        author: { name: "nanalStamp", email: "archive@nanalstamp.local", timestamp: Math.floor(Date.now() / 1000), timezoneOffset: new Date().getTimezoneOffset() },
      });
    });
  }

  // 확정된 한 버전을 아카이브에 커밋: notes/<safe>.md = content, proofs/<safe>.nanalproof = proofBody.
  // 내용 변경이 있을 때만 커밋(같은 내용이면 스킵). throw 가능 — 호출부에서 삼킨다.
  /// content 로 `{ copyFrom }` 을 주면 **파일에서 직접** 넣는다(힙 경유 없음).
  /// 그중 ARCHIVE_INLINE_MAX 를 넘는 것은 git 에 넣지 않고 `blobs/<sha256>` 에 복사하고
  /// 이력에는 포인터(.nanalref)만 커밋한다 — isomorphic-git 의 add 가 파일을 통째로 힙에
  /// 올려 625MB 첨부 하나에 RSS 2GB 를 쓰기 때문이다(실측 2026-07-30).
  /// 읽는 쪽은 archiveReadBytes 가 포인터를 알아서 따라가므로 호출부는 달라지지 않는다.
  protected async archiveVersion(safe: string, notePath: string, content: string | ArrayBuffer | { copyFrom: string; size: number; hash: string }, proofBody: string, seq?: number, block?: number): Promise<void> {
    if (!this.archiveEnabled()) return;
    const dir = (this.settings.archivePath || "").trim();
    if (!dir) return;
    await this.runArchive(async () => {
      const fs = nodeReq("fs");
      const path = nodeReq("path");
      // .git이 없으면(사용자가 폴더 지웠거나 최초 호출 전) 먼저 초기화.
      if (!fs.existsSync(path.join(dir, ".git"))) {
        fs.mkdirSync(dir, { recursive: true });
        await git.init({ fs, dir, defaultBranch: "main" });
      }
      // .md는 notes/<safe>.md(텍스트), 첨부는 attachments/<safe>(원바이트, safe에 실제 확장자 포함).
      let ignoreAdded = false;
      const fromFile = typeof content === "object" && content !== null && "copyFrom" in content;
      const src = fromFile ? (content as { copyFrom: string; size: number; hash: string }) : null;
      const isBin = fromFile || typeof content !== "string";
      const asRef = !!src && src.size > ARCHIVE_INLINE_MAX;
      const contentRel = !isBin ? `notes/${safe}.md`
        : asRef ? `attachments/${safe}${ARCHIVE_REF_EXT}` : `attachments/${safe}`;
      const proofRel = `proofs/${safe}.nanalproof`;
      fs.mkdirSync(path.join(dir, path.dirname(contentRel)), { recursive: true });
      fs.mkdirSync(path.join(dir, "proofs"), { recursive: true });
      if (asRef && src) {
        // 내용주소 저장 — 같은 내용은 한 번만 둔다. 복사는 메모리를 경유하지 않는다.
        fs.mkdirSync(path.join(dir, "blobs"), { recursive: true });
        const casPath = path.join(dir, "blobs", src.hash);
        if (!fs.existsSync(casPath)) {
          fs.copyFileSync(src.copyFrom, casPath);
          // 읽기 전용으로 잠근다 — 실수로 덮어쓰는 경로를 물리적으로 막는다.
          // (의도적 변경은 못 막지만 그건 읽을 때 해시 대조가 잡는다. 두 층으로 충분하다.)
          try { fs.chmodSync(casPath, 0o444); } catch { /* 파일시스템이 권한을 지원하지 않을 수 있다 */ }
        }
        ignoreAdded = this.ensureArchiveIgnore(dir, fs, path);
        fs.writeFileSync(path.join(dir, contentRel),
          JSON.stringify({ v: 1, sha256: src.hash, size: src.size, name: safe }), "utf8");
      } else if (src) {
        fs.copyFileSync(src.copyFrom, path.join(dir, contentRel));
      } else if (isBin) fs.writeFileSync(path.join(dir, contentRel), new Uint8Array(content as ArrayBuffer));
      else fs.writeFileSync(path.join(dir, contentRel), content as string, "utf8");
      fs.writeFileSync(path.join(dir, proofRel), proofBody, "utf8");
      await git.add({ fs, dir, filepath: contentRel, cache: this.gitCache });
      await git.add({ fs, dir, filepath: proofRel, cache: this.gitCache });
      // .gitignore 도 이력에 담는다 — 폴더를 복사해 옮겼을 때 blobs/ 규칙이 함께 가야 한다.
      if (ignoreAdded) await git.add({ fs, dir, filepath: ".gitignore", cache: this.gitCache });
      // 변경 없으면(같은 내용) 커밋 스킵 — 두 파일 모두 unmodified면 새 커밋 불필요.
      const s1 = await git.status({ fs, dir, filepath: contentRel, cache: this.gitCache });
      const s2 = await git.status({ fs, dir, filepath: proofRel, cache: this.gitCache });
      if (s1 === "unmodified" && s2 === "unmodified") return;
      await git.commit({
        fs, dir,
        message: buildArchiveMsg(notePath, seq, block), // block undefined → 봉인 시점(pending, ₿# 미포함)
        author: { name: "nanalStamp", email: "archive@nanalstamp.local", timestamp: Math.floor(Date.now() / 1000), timezoneOffset: new Date().getTimezoneOffset() },
      });
      this.rewindLogCache = null; // 새 커밋 → 로그 캐시 무효(대시보드·버전 모달이 다음 조회에서 신선하게)
    });
  }

  // 설정에서 아카이브 경로 변경 적용(+ 필요 시 이관). 렌더 밖(버튼 onClick)에서만 호출.
  // 기존 .git이 있고 새 경로가 비어 있으면 .git 포함 전체 복사로 이력을 옮긴다.
  async applyArchivePath(rawNew: string): Promise<{ status: "migrated" | "exists" | "set" | "error" | "same" | "invault"; a?: string; b?: string }> {
    if (!Platform.isDesktopApp) return { status: "error" };
    const newPath = (rawNew || "").trim();
    if (!newPath) return { status: "error" };
    const oldPath = (this.settings.archivePath || "").trim();
    if (newPath === oldPath) return { status: "same" };
    try {
      const fs = nodeReq("fs");
      const path = nodeReq("path");
      // vault 안(동일·하위)이나 vault를 포함하는 경로는 금지 — 아카이브의 notes/*.md 사본이 다시 봉인
      // 대상이 되는 자기 순환(아카이브의 아카이브, 무한 증식)과 vault 오염을 원천 차단(2026-07-22 사용자 지적).
      const adapter = this.app.vault.adapter;
      const vaultBase = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : undefined;
      if (vaultBase) {
        const rNew = path.resolve(newPath), rVault = path.resolve(vaultBase);
        const within = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);
        if (within(rNew, rVault) || within(rVault, rNew)) return { status: "invault", b: newPath };
      }
      const oldHasGit = !!oldPath && fs.existsSync(path.join(oldPath, ".git"));
      const newExists = fs.existsSync(newPath);
      const newHasArchive = newExists && fs.existsSync(path.join(newPath, ".git"));
      const newIsEmpty = !newExists || fs.readdirSync(newPath).length === 0;
      let status: "migrated" | "exists" | "set" = "set";
      if (oldHasGit && !newHasArchive && newIsEmpty) {
        // 이력 보존: 기존 폴더 전체(.git 포함)를 새 경로로 재귀 복사. 원본은 백업으로 남김.
        fs.mkdirSync(path.dirname(newPath), { recursive: true });
        fs.cpSync(oldPath, newPath, { recursive: true });
        status = "migrated";
      } else if (newHasArchive) {
        status = "exists"; // 새 경로에 이미 아카이브 → 자동 복사 안 함(경고)
      }
      // 쓰기가능 검증: 폴더 생성 후 W_OK 확인.
      fs.mkdirSync(newPath, { recursive: true });
      try { fs.accessSync(newPath, fs.constants.W_OK); }
      catch { return { status: "error", b: newPath }; }
      this.settings.archivePath = newPath;
      await this.saveSettings();
      await this.ensureArchive(); // 새 경로가 비어 있으면 init + README
      return { status, a: oldPath, b: newPath };
    } catch (e) {
      console.error("[nanalstamp] archive path change error", e);
      return { status: "error", b: newPath };
    }
  }

  // 아카이브 전체 커밋 로그 → 확정 기록 목록. 커밋 메시지에 notePath가 있어 git.log 1회로
  // 전 노트 이력이 나온다(archiveVersions의 filepath log를 노트마다 도는 것보다 훨씬 싸다).
  async archiveLog(): Promise<ArchiveEntry[]> {
    if (!this.archiveEnabled()) return [];
    const dir = (this.settings.archivePath || "").trim();
    if (!dir) return [];
    return this.runArchive(async () => {
      const fs = nodeReq("fs");
      const path = nodeReq("path");
      if (!fs.existsSync(path.join(dir, ".git"))) return [];
      let commits: any[] = [];
      try { commits = await git.log({ fs, dir, cache: this.gitCache }); } catch { return []; }
      const out: ArchiveEntry[] = [];
      for (const c of commits) {
        // isomorphic-git timestamp는 초 → ms 변환
        const e = parseArchiveCommit(String(c.commit?.message || "").trim(), (c.commit?.author?.timestamp ?? 0) * 1000);
        if (e) out.push(e);
      }
      return out;
    });
  }

  async renameLineage(entries: RewindEntry[]): Promise<Record<string, string>> {
    if (this.lineageResult && this.lineageResult.log === entries) return this.lineageResult.map;
    const exists = (p: string) => this.app.vault.getAbstractFileByPath(p) instanceof TFile;
    const relOf = (p: string) => (isMarkdownPath(p) ? `notes/${safeName(p)}.md` : `attachments/${safeName(p)}`);
    const spans = pathSpans(entries);
    const detected: Record<string, string> = {};
    let scanNotice: Notice | null = null;   // 처음 도는 경로가 있을 때만 띄운다
    let dirty = false;
    for (const [p, sp] of spans) {
      if (exists(p) || !sp.lastOid) continue; // 살아있는 경로는 계보의 출발점이 아니다
      if (!this.dashInScope(p)) continue; // 복원 사본 등 범위 밖 경로는 계보 대상 아님
      const key = `${p}|${sp.lastOid}`;
      // 메모리 캐시 → 디스크 캐시 순으로 본다. 디스크에 있으면 그 답을 그대로 쓴다
      // (판정이 커밋 oid 로 고정돼 있어 뒤집히지 않는다).
      let cached: string | null | undefined = this.lineageCache.get(key);
      if (cached === undefined) {
        const saved = this.settings.lineageCacheMap?.[key];
        if (saved !== undefined) { cached = saved === "" ? null : saved; this.lineageCache.set(key, cached); }
      }
      if (cached !== undefined) { if (cached) detected[p] = cached; continue; }
      // 처음 도는 경로가 있으면 사람에게 말한다 — 실측 108초 동안 조용하면 고장으로 읽힌다.
      if (!scanNotice) { scanNotice = new Notice(t.lineageScanning, 0); }
      let found: string | null = null;
      const oldBytes = await this.archiveReadBytes(sp.lastOid, relOf(p));
      if (oldBytes) {
        // 소급 자동 판정은 "내용 정확 일치"만 — 유사도 추정은 서로 다른 노트를 합칠 이론적 위험이 있어
        // 배제(2026-07-22 사용자 결정). 수정이 겹친 개명은 삭제된 노트 카드의 수동 연결로 잇는다.
        const oldHash = await sha256HexBytes(oldBytes);
        for (const cand of successorCandidates(p, spans)) {
          if (!this.dashInScope(cand)) continue; // 복원 사본으로 잇지 않는다(내용이 같아 오인 위험)
          const csp = spans.get(cand);
          if (!csp?.firstOid) continue;
          const nb = await this.archiveReadBytes(csp.firstOid, relOf(cand));
          if (nb && (await sha256HexBytes(nb)) === oldHash) { found = cand; break; }
        }
      }
      this.lineageCache.set(key, found);
      this.settings.lineageCacheMap = this.settings.lineageCacheMap || {};
      this.settings.lineageCacheMap[key] = found ?? "";
      dirty = true;
      if (found) detected[p] = found;
    }
    // 이벤트 기록이 소급 판정보다 우선(내용 검증 불요·수정 겹침에도 확실) — 뒤에 spread.
    const merged = collapseRenames({ ...detected, ...this.settings.renameMap });
    const out: Record<string, string> = {};
    for (const [o, n] of Object.entries(merged)) if (!exists(o) && exists(n)) out[o] = n;
    this.lineageResult = { log: entries, map: out };
    scanNotice?.hide();
    if (dirty) await this.persist();         // 다음 실행부터는 즉시 끝난다
    return out;
  }

  // 계보(renameMap)를 아카이브 git에 lineage.json으로 영속(2026-07-22 사용자 승인) — data.json은 기기
  // 로컬이라 초기화·기기 이전 시 이벤트·수동 연결이 사라진다. 양방향 병합: 파일에만 있으면 설정으로
  // (기기 이전 복원), 설정에만 있으면 파일로(영속). 아카이브 폴더는 vault 밖 → 봉인·업로드 대상 아님.
  // 커밋 메시지는 봉인 커밋 규격(`nanalStamp: … · seq …`)과 다른 접두라 로그 파서들이 자연히 무시한다.
  async syncLineageFile(): Promise<void> {
    if (!this.archiveEnabled()) return;
    const dir = (this.settings.archivePath || "").trim();
    if (!dir) return;
    const stable = (m: Record<string, string>) => JSON.stringify(m, Object.keys(m).sort(), 2);
    await this.runArchive(async () => {
      const fs = nodeReq("fs");
      const path = nodeReq("path");
      if (!fs.existsSync(path.join(dir, ".git"))) return; // 아카이브는 첫 봉인 때 init — 그 전이면 다음 기회에
      const rel = "lineage.json";
      let fileMap: Record<string, string> = {};
      try { fileMap = JSON.parse(fs.readFileSync(path.join(dir, rel), "utf8")); } catch { /* 없음·손상 → 빈 것으로 */ }
      let settingsChanged = false;
      for (const [k, v] of Object.entries(fileMap)) {
        if (typeof v !== "string") continue;
        if (this.settings.renameMap[k] === undefined) { this.settings.renameMap[k] = v; settingsChanged = true; }
      }
      if (settingsChanged) { this.lineageResult = null; await this.persist(); }
      const next = stable(this.settings.renameMap);
      if (next === stable(fileMap)) return; // 변화 없음 — 커밋 안 함
      fs.writeFileSync(path.join(dir, rel), next, "utf8");
      await git.add({ fs, dir, filepath: rel, cache: this.gitCache });
      await git.commit({
        fs, dir,
        message: "nanalStamp-lineage: renameMap sync",
        author: { name: "nanalStamp", email: "archive@nanalstamp.local", timestamp: Math.floor(Date.now() / 1000), timezoneOffset: new Date().getTimezoneOffset() },
      });
    });
  }

  async rewindLog(): Promise<RewindEntry[]> {
    if (!this.archiveEnabled()) return [];
    const dir = (this.settings.archivePath || "").trim();
    if (!dir) return [];
    if (this.rewindLogCache && Date.now() - this.rewindLogCache.at < REWIND_LOG_TTL_MS) return this.rewindLogCache.entries;
    const entries = await this.runArchive(async () => {
      const fs = nodeReq("fs");
      const path = nodeReq("path");
      if (!fs.existsSync(path.join(dir, ".git"))) return [];
      let commits: any[] = [];
      try { commits = await git.log({ fs, dir, cache: this.gitCache }); } catch { return []; }
      const out: RewindEntry[] = [];
      for (const c of commits) {
        const e = parseRewindCommit(String(c.commit?.message || ""), (c.commit?.author?.timestamp ?? 0) * 1000);
        if (e) { e.oid = String(c.oid); e.tzo = c.commit?.author?.timezoneOffset ?? 0; out.push(e); }
      }
      return out;
    });
    this.rewindLogCache = { at: Date.now(), entries };
    return entries;
  }

  // 대시보드 카드 6 → P6 버전 모달 재사용. 그날로: 삭제된 노트는 TFile이 없으므로 경로 문자열을 받는다.
  // titleKey: 어디서 들어왔는지에 따라 모달 제목이 달라진다 — 그날로에서 온 흐름에 "특정 시점 증명서"가
  // 떠 있으면 무엇을 하는 창인지 어긋난다(2026-07-28).
  async openArchiveModalFor(notePath: string, title?: string, pick?: string): Promise<void> {
    if (!this.dashboardArchiveOn()) { new Notice(t.pitNoArchive); return; }
    const safe = safeName(notePath);
    // 버전 목록은 전체 로그 캐시(rewindLog)에서 파생 — 경로별 git 재순회(filepath log)는 커밋 수천 개에서
    // 초 단위라 모달이 "한참 뒤에" 떴다(2026-07-22 사용자 지적). 커밋 메시지가 경로를 담고 있어 동치다.
    const log = await this.rewindLog();
    const verOf = (p: string) => log
      .filter((e) => e.notePath === p && e.oid)
      .map((e) => ({ oid: e.oid as string, ts: Math.floor(e.ts / 1000), tzo: e.tzo ?? 0, seq: e.seq, block: e.block ?? "?" }));
    if (isMarkdownPath(notePath)) {
      const versions: Array<{ oid: string; ts: number; tzo: number; seq: string; block: string; safe?: string; srcPath?: string }> =
        verOf(notePath);
      // 개명 전 이력 합산: 이 경로로 이어지는 옛 경로들의 버전을 시간순으로 잇는다.
      // 옛 버전은 아카이브 안에서 옛 safe로 저장돼 있으므로 버전별 safe를 함께 넘긴다(열람·복원·내보내기 공용).
      const lineage = await this.renameLineage(log);
      for (const [oldP, newP] of Object.entries(lineage)) {
        if (newP !== notePath || !isMarkdownPath(oldP)) continue;
        const oldSafe = safeName(oldP);
        for (const v of verOf(oldP)) versions.push({ ...v, safe: oldSafe, srcPath: oldP });
      }
      versions.sort((a, b) => b.ts - a.ts);
      if (!versions.length) { new Notice(t.pitNoHistory(basenameOf(notePath))); return; }
      new ArchiveVersionModal(this.app, this as unknown as NanalStampPlugin, notePath, safe, versions, title, pick).open();
    } else {
      const rel = `attachments/${safe}`;
      const versions = verOf(notePath);
      if (!versions.length) { new Notice(t.pitNoHistory(basenameOf(notePath))); return; }
      new AttachmentVersionModal(this.app, this as unknown as NanalStampPlugin, notePath, safe, rel, versions, title, pick).open();
    }
  }

  // 이 노트가 아카이브에 남긴 확정 버전들(최신 → 과거). 커밋 메시지에서 seq·블록을 파싱해 표시용으로 곁들인다.
  async archiveVersions(safe: string): Promise<Array<{ oid: string; ts: number; tzo: number; seq: string; block: string }>> {
    return this.archiveVersionsOf(`notes/${safe}.md`);
  }

  // archiveVersions의 일반형: 임의의 아카이브 상대경로(notes/<safe>.md 또는 attachments/<safe>)의 커밋 이력.
  // 첨부(attachments/)도 동일 파이프라인으로 버전 목록을 얻기 위해 filepath를 매개변수화한다.
  async archiveVersionsOf(rel: string): Promise<Array<{ oid: string; ts: number; tzo: number; seq: string; block: string }>> {
    if (!this.archiveEnabled()) return [];
    const dir = (this.settings.archivePath || "").trim();
    if (!dir) return [];
    return this.runArchive(async () => {
      const fs = nodeReq("fs");
      const path = nodeReq("path");
      if (!fs.existsSync(path.join(dir, ".git"))) return [];
      let commits: any[] = [];
      try { commits = await git.log({ fs, dir, filepath: rel, cache: this.gitCache }); }
      catch { return []; } // 이 파일이 아카이브에 없으면 log가 throw → 버전 없음
      return commits.map((c) => {
        const p = parseArchiveMsg(String(c.commit?.message || ""));
        return {
          oid: String(c.oid),
          ts: c.commit?.author?.timestamp ?? 0,
          tzo: c.commit?.author?.timezoneOffset ?? 0,
          seq: p?.seq ?? "?",
          block: p?.block ?? "?", // 봉인 시점(미확정) 커밋은 block null → "?" (표시에서 pending 취급)
        };
      });
    });
  }

  // 특정 커밋 시점의 파일 내용을 읽는다(현재 워킹트리 불변). 없으면 null.
  protected async archiveReadBlob(oid: string, rel: string): Promise<string | null> {
    if (!Platform.isDesktopApp) return null; // 동기화된 뷰 상태로 모바일에서 호출될 수 있음 — nodeReq throw 방지
    const dir = (this.settings.archivePath || "").trim();
    if (!dir) return null;
    return this.runArchive(async () => {
      const fs = nodeReq("fs");
      try {
        const { blob } = await git.readBlob({ fs, dir, oid, filepath: rel, cache: this.gitCache });
        return new TextDecoder("utf-8").decode(blob);
      } catch { return null; }
    });
  }

  /// 아카이브 전체에서 **내용 해시로** 원본을 찾는다.
  ///
  /// 왜 해시로 찾나(2026-07-30): 지워진 노트는 vault 에 경로가 없어 경로 해시를 역산할 수
  /// 없다. 그래서 "경로를 안 다음에 아카이브를 본다"는 순서면 **지워진 것은 아예 못 찾는다** —
  /// 실측에서 누락 260건 중 226건이 아카이브에 멀쩡히 있는데도 그랬다.
  /// 봉인된 내용은 봉인 시점에 아카이브로 커밋되므로, 해시만 있으면 경로 없이도 찾을 수 있다.
  ///
  /// 파일이 아니라 **커밋 이력 전체**를 훑는다(지금 트리에 없는 옛 버전도 대상).
  /// 찾을 것을 다 찾으면 즉시 멈춘다 — 아카이브가 크면 전수 조회는 비싸다.
  /// 아카이브 블롭 인덱스: **원문해시 → blob oid**. `.git/` 안에 두어 커밋 대상이 되지 않는다.
  ///
  /// 왜 인덱스인가(실측, 2026-07-30): 260건을 찾는 데
  ///   - 이력 전체 순회        = 7.5초
  ///   - 경로별 `git.log` 조회 = 320초 (호출마다 이력을 되짚는다 — 최적화인 줄 알았으나 40배 느렸다)
  ///   - **인덱스 조회         = 40ms**
  /// 뒤지지 않고 **쓸 때 적어 둔다**. 최초 1회만 6.4초로 만들고, 그 뒤로는 새 커밋만 덧붙인다(1ms).
  private blobIndex: { head: string | null; map: Record<string, string> } | null = null;

  private async ensureBlobIndex(
    dir: string, fs: any, path: any, onProgress?: (done: number, total: number) => void,
  ): Promise<Record<string, string>> {
    const file = path.join(dir, ".git", "nanal-blobindex.json");
    if (!this.blobIndex) {
      try {
        const j = JSON.parse(fs.readFileSync(file, "utf8"));
        if (j && j.v === 1 && j.map) this.blobIndex = { head: j.head ?? null, map: j.map };
      } catch { /* 없거나 손상 — 새로 만든다 */ }
    }
    let idx = this.blobIndex ?? { head: null, map: {} };
    const cache = this.gitCache;   // 공유 캐시 — 위 주석 참조
    let commits: Array<{ oid: string; commit?: { message?: string } }> = [];
    try { commits = await git.log({ fs, dir, cache }) as any; } catch { return idx.map; }
    if (commits.length === 0) return idx.map;
    if (idx.head === commits[0].oid) return idx.map;   // 새 커밋 없음

    // 저장된 head 이후의 새 커밋만. head 를 못 찾으면(이력이 바뀜) 전부 다시 만든다.
    let fresh = commits;
    if (idx.head) {
      const at = commits.findIndex((c) => c.oid === idx.head);
      if (at >= 0) fresh = commits.slice(0, at);
      else idx = { head: null, map: {} };
    }
    const seen = new Set(Object.values(idx.map));
    // 진행 표시는 **50ms 에 한 번**만. 매 커밋 DOM 을 건드리면 갱신 1,539회가 레이아웃을 계속
    // 강제해 6초짜리 작업이 몇 배로 늘어난다(2026-07-30 실사용 지적).
    let lastTick = 0;
    for (let i = 0; i < fresh.length; i++) {
      const now = Date.now();
      if (now - lastTick > 50) { lastTick = now; onProgress?.(i, fresh.length); }
      const notePath = archiveNotePath(fresh[i].commit?.message ?? "");
      let rels: string[];
      if (notePath) {
        const safe = safeName(notePath);
        rels = [isMarkdownPath(notePath) ? `notes/${safe}.md` : `attachments/${safe}`];
      } else {
        try {
          rels = (await git.listFiles({ fs, dir, ref: fresh[i].oid, cache }) as string[])
            .filter((r) => r.startsWith("notes/") || r.startsWith("attachments/"));
        } catch { continue; }
      }
      for (const rel of rels) {
        let blob: Uint8Array; let oid: string;
        try {
          const r = await git.readBlob({ fs, dir, oid: fresh[i].oid, filepath: rel, cache });
          blob = r.blob as Uint8Array; oid = r.oid;
        } catch { continue; }
        if (rel.endsWith(ARCHIVE_REF_EXT)) continue;   // 포인터의 해시는 원본 해시가 아니다 — blobs/ 로 직접 찾는다
        if (seen.has(oid)) continue;
        seen.add(oid);
        idx.map[await sha256HexBytes(blob)] = oid;
      }
    }
    onProgress?.(fresh.length, fresh.length);
    idx.head = commits[0].oid;
    this.blobIndex = idx;
    try { fs.writeFileSync(file, JSON.stringify({ v: 1, head: idx.head, map: idx.map })); }
    catch (e) { console.error("[nanalstamp] blob index save", e); }   // 저장 실패해도 이번 조회는 유효
    return idx.map;
  }

  /// 찾는 해시들의 원본을 아카이브에서 꺼낸다(해시 → 바이트). **경로를 몰라도 된다.**
  /// onProgress 는 인덱스를 만드는 동안에만 온다 — 조회 자체는 즉시 끝난다.
  async findInArchiveByHashes(
    want: Set<string>, onProgress?: (done: number, total: number) => void,
  ): Promise<Map<string, Uint8Array>> {
    const found = new Map<string, Uint8Array>();
    if (!this.archiveEnabled() || want.size === 0) return found;
    const dir = (this.settings.archivePath || "").trim();
    if (!dir) return found;
    return this.runArchive(async () => {
      const fs = nodeReq("fs");
      const path = nodeReq("path");
      if (!fs.existsSync(path.join(dir, ".git"))) return found;
      const map = await this.ensureBlobIndex(dir, fs, path, onProgress);
      for (const h of want) {
        // 내용주소 저장소가 우선 — 파일명이 곧 해시라 인덱스를 거치지 않는다.
        const cas = path.join(dir, "blobs", h);
        if (fs.existsSync(cas)) {
          try {
            const b = new Uint8Array(fs.readFileSync(cas));
            if (await sha256HexBytes(b) === h) { found.set(h, b); continue; }   // 이름이 곧 해시 — 대조한다
            console.error("[nanalstamp] archive blob corrupted", h);
          } catch { /* 아래로 */ }
        }
        const oid = map[h];
        if (!oid) continue;
        try {
          const { blob } = await git.readBlob({ fs, dir, oid, cache: this.gitCache });
          found.set(h, blob as Uint8Array);
        } catch { /* 오브젝트가 사라졌다면 없는 것으로 */ }
      }
      return found;
    });
  }

  /// 내용주소 저장소에 그 해시의 원본이 있으면 **경로**를 돌려준다(바이트가 아니라).
  ///
  /// 왜 경로인가: 복구가 이걸 읽어 서버에 올리는데, 625MB 첨부를 바이트로 받으면 그 순간
  /// 힙에 통째로 올라간다 — 업로드를 스트리밍으로 만든 의미가 없어진다. 경로를 그대로
  /// 스트리밍 업로드에 넘기면 메모리가 상수로 유지된다(2026-07-30).
  casPathOf(hash: string): { path: string; size: number } | null {
    if (!this.archiveEnabled()) return null;
    const dir = (this.settings.archivePath || "").trim();
    if (!dir) return null;
    try {
      const fs = nodeReq("fs"); const path = nodeReq("path");
      const p = path.join(dir, "blobs", hash);
      const st = fs.statSync(p);
      return { path: p, size: st.size };
    } catch { return null; }
  }

  /// blobs/ 무결성 점검 — 파일 이름이 곧 해시이므로 대조하면 손상이 드러난다.
  /// git 은 이 폴더를 추적하지 않아 `git fsck` 가 봐 주지 않는다. 그래서 우리가 본다.
  async verifyArchiveBlobs(onProgress?: (done: number, total: number) => void): Promise<{ ok: number; bad: string[] }> {
    const bad: string[] = []; let ok = 0;
    if (!this.archiveEnabled()) return { ok, bad };
    const dir = (this.settings.archivePath || "").trim();
    if (!dir) return { ok, bad };
    return this.runArchive(async () => {
      const fs = nodeReq("fs"); const path = nodeReq("path");
      const base = path.join(dir, "blobs");
      let names: string[] = [];
      try { names = fs.readdirSync(base); } catch { return { ok, bad }; }
      for (let i = 0; i < names.length; i++) {
        onProgress?.(i, names.length);
        const h = names[i];
        if (!/^[0-9a-f]{64}$/.test(h)) continue;
        try {
          const bytes = new Uint8Array(fs.readFileSync(path.join(base, h)));
          if (await sha256HexBytes(bytes) === h) ok++; else bad.push(h);
        } catch { bad.push(h); }
      }
      onProgress?.(names.length, names.length);
      return { ok, bad };
    });
  }

  /// 아카이브가 아는 모든 노트 경로를 **경로해시 → 경로**로 돌려준다.
  ///
  /// 왜: 서버는 프라이버시 때문에 경로를 해시로만 갖고 있다. 되살리지 못한 기록을
  /// "seq 431" 이라고만 알리면 사람이 무엇을 잃었는지 알 수 없다 — 그 노트가 한 번이라도
  /// 아카이브에 커밋된 적이 있으면 여기서 이름을 되찾을 수 있다.
  /// 커밋 메시지만 읽으므로 블롭을 읽지 않는다(1,539커밋에 0.4초).
  async archivePathsByHash(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!this.archiveEnabled()) return out;
    const dir = (this.settings.archivePath || "").trim();
    if (!dir) return out;
    return this.runArchive(async () => {
      const fs = nodeReq("fs");
      const path = nodeReq("path");
      if (!fs.existsSync(path.join(dir, ".git"))) return out;
      let commits: Array<{ commit?: { message?: string } }> = [];
      try { commits = await git.log({ fs, dir, cache: this.gitCache }) as any; } catch { return out; }
      const paths = new Set<string>();
      for (const c of commits) {
        const np = archiveNotePath(c.commit?.message ?? "");
        if (np) paths.add(np);
      }
      for (const p of paths) out.set(await hashPath(p), p);
      return out;
    });
  }

  /// blobs/ 는 git 이 추적하지 않는다 — 내용주소 저장소이고, 커밋되는 것은 포인터뿐이다.
  /// 새로 쓰거나 고쳤으면 true — 호출부가 이 파일도 커밋에 담는다.
  protected ensureArchiveIgnore(dir: string, fs: any, path: any): boolean {
    const p = path.join(dir, ".gitignore");
    try {
      const cur = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
      if (/^blobs\/$/m.test(cur)) return false;
      fs.writeFileSync(p, cur + (cur.endsWith("\n") || cur === "" ? "" : "\n") + "blobs/\n", "utf8");
      return true;
    } catch { return false; }   // 없어도 동작한다(다음 커밋에 blobs가 섞일 뿐)
  }

  // archiveReadBlob의 바이너리 변형: 원바이트(Uint8Array)를 그대로 반환(첨부 미리보기/저장용). 없으면 null.
  // 대형 첨부는 이력에 포인터만 있으므로, 원래 경로가 없으면 <rel>.nanalref 를 따라 blobs/ 에서 읽는다.
  async archiveReadBytes(oid: string, rel: string): Promise<Uint8Array | null> {
    if (!Platform.isDesktopApp) return null; // 동기화된 뷰 상태로 모바일에서 호출될 수 있음 — nodeReq throw 방지
    const dir = (this.settings.archivePath || "").trim();
    if (!dir) return null;
    return this.runArchive(async () => {
      const fs = nodeReq("fs");
      const path = nodeReq("path");
      try {
        const { blob } = await git.readBlob({ fs, dir, oid, filepath: rel, cache: this.gitCache });
        return blob as Uint8Array;
      } catch { /* 포인터일 수 있다 */ }
      try {
        const { blob } = await git.readBlob({ fs, dir, oid, filepath: rel + ARCHIVE_REF_EXT, cache: this.gitCache });
        const ref = JSON.parse(new TextDecoder().decode(blob as Uint8Array));
        if (ref?.v !== 1 || !/^[0-9a-f]{64}$/.test(ref.sha256 ?? "")) return null;
        const bytes = new Uint8Array(fs.readFileSync(path.join(dir, "blobs", ref.sha256)));
        // **반드시 확인한다.** 포인터는 이력(커밋)이 지켜 주지만 blobs/ 는 git 밖의 평범한 파일이라
        // 누군가 같은 이름에 다른 내용을 덮어쓸 수 있다. 이름이 곧 해시이므로 대조하면 즉시 드러난다 —
        // 확인하지 않으면 바뀐 내용이 "그 시점 원본"인 척 조용히 통과한다(2026-07-30 사용자 지적).
        // 봉인 자체는 무사하다: 진위의 근거는 비트코인에 앵커된 해시이고, 여기서 걸리는 것은 사본 손상이다.
        if (await sha256HexBytes(bytes) !== ref.sha256) {
          console.error("[nanalstamp] archive blob corrupted", ref.sha256);
          return null;
        }
        return bytes;
      } catch { return null; }
    });
  }

  // 한 버전의 원문 + 증명을 아카이브에서 읽어온다. 둘 중 하나라도 없으면 null.
  async readArchivedVersion(oid: string, safe: string): Promise<{ note: string; proofRaw: string; proof: any } | null> {
    const note = await this.archiveReadBlob(oid, `notes/${safe}.md`);
    const proofRaw = await this.archiveReadBlob(oid, `proofs/${safe}.nanalproof`);
    if (note == null || proofRaw == null) return null;
    let proof: any = null;
    try { proof = JSON.parse(proofRaw); } catch { /* 손상된 proof여도 note 해시 표시는 가능 */ }
    return { note, proofRaw, proof };
  }

  // 소스: 로컬 아카이브(oid) 우선 → nanal 스토리지 폴백. GitHub 미러는 열람 전용(플러그인 밖이라 해시 검증 불가).
  // 어떤 소스든 바이트 해시 === expectedHash를 통과해야만 저장한다(신뢰 앵커는 해시).
  // mode=copy: nanalStamp/restored/ 사본. mode=inplace: 현재 내용 선봉인 성공 후에만 교체(증거 보전 > 편의),
  // 삭제된 노트는 원경로 재생성. 교체·재생성 직후 1회 봉인 — "그날로 돌아간 사실"도 이력에 남긴다.
  async restoreVersion(opts: { notePath: string; expectedHash: string; oid?: string; isMd: boolean; mode: "copy" | "inplace"; srcSafe?: string }): Promise<void> {
    const { notePath, expectedHash, oid, isMd, mode } = opts;
    // 개명 전 버전은 아카이브에 옛 safe로 저장 — 읽기 rel과 사본 이름 모두 그 버전의 정체(옛 이름)를 따른다.
    const safe = opts.srcSafe ?? safeName(notePath);
    // 1) 원문 획득 + 무결성 게이트
    let bytes: Uint8Array | null = null;
    if (oid) {
      const rel = isMd ? `notes/${safe}.md` : `attachments/${safe}`;
      const b = await this.archiveReadBytes(oid, rel);
      if (b && (await sha256HexBytes(b)) === expectedHash) bytes = b; // 손상·불일치면 nanal 폴백으로
    }
    if (!bytes && this.settings.apiKey) {
      const r = await this.nanalFetch(expectedHash, isMd ? "md" : blobExt(notePath), isMd); // 해시 검증 내장
      if (!("error" in r)) bytes = typeof r.data === "string" ? new TextEncoder().encode(r.data) : new Uint8Array(r.data);
    }
    if (!bytes) { new Notice(t.pitReadFail); return; } // 로컬 손상·부재 + 폴백 실패/불가
    const text = isMd ? new TextDecoder("utf-8").decode(bytes) : "";
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

    // 2-a) 사본 복원 — 해시 8자 태그 경로라 같은 경로 = 같은 내용(이미 있으면 그대로 연다)
    if (mode === "copy") {
      const dest = restoredPath(safe, expectedHash, isMd);
      await this.ensureVaultFolder(dest.slice(0, dest.lastIndexOf("/")));
      const existing = this.app.vault.getAbstractFileByPath(dest);
      const f = existing instanceof TFile ? existing
        : isMd ? await this.app.vault.create(dest, text)
        : await this.app.vault.createBinary(dest, buf);
      new Notice(t.nanalRestoreOk(dest));
      await this.app.workspace.getLeaf("tab").openFile(f);
      return;
    }

    // 2-b) 원위치 복원
    const existing = this.app.vault.getAbstractFileByPath(notePath);
    let target: TFile;
    if (existing instanceof TFile) {
      const cur = await this.hashOf(existing);
      if (cur !== expectedHash) {
        // 선봉인 — 현재 내용을 증거로 남긴 뒤에만 교체. flush 성공 판정은 sealedIndex/ledgerIndex로.
        await this.flush(existing, "restore");
        if (this.settings.sealedIndex[notePath] !== cur && this.settings.ledgerIndex[notePath] !== cur) {
          new Notice(t.rewindPreSealFail);
          return;
        }
      }
      if (isMd) await this.app.vault.modify(existing, text);
      else await this.app.vault.modifyBinary(existing, buf);
      target = existing;
    } else {
      const dir = notePath.includes("/") ? notePath.slice(0, notePath.lastIndexOf("/")) : "";
      if (dir) await this.ensureVaultFolder(dir);
      target = isMd ? await this.app.vault.create(notePath, text) : await this.app.vault.createBinary(notePath, buf);
    }
    new Notice(t.rewindRestoredInPlace(notePath));
    await this.app.workspace.getLeaf("tab").openFile(target);
    void this.flush(target, "restore"); // 복원 사실도 봉인 이력에(내용 무변경이면 flush가 no-op)
  }

  protected async mirrorToGithub(file: TFile, proofBody: string, seq?: number, block?: number, silent = false, original?: string | ArrayBuffer): Promise<boolean> {
    if (!this.mirrorActive()) return false;
    const team = this.settings.teamCustody;
    // 팀 custody가 아니면 개인 GitHub 연결(토큰·repo)이 있어야 한다. custody면 서버가 대행하므로 불필요.
    if (!team && (!this.settings.githubPat || !this.settings.githubRepo)) return false;
    try {
      const safe = safeName(file.path);
      if (original == null) original = this.isBinary(file) ? await this.app.vault.readBinary(file) : await this.app.vault.read(file);
      const msg = buildArchiveMsg(file.path, seq, block); // block undefined → 봉인 시점(pending) 미러 커밋
      // .md는 notes/<safe>.md, 첨부는 attachments/<safe>(로컬 아카이브와 동일 배치).
      // 5.2: digest 폴더 아래 .md는 조직 repo digests/<safe>로 라우팅(개인·custody 공통). proofs는 그대로.
      const contentPath = this.isBinary(file)
        ? `attachments/${safe}`
        : this.isDigestPath(file.path) ? `digests/${safe}.md` : `notes/${safe}.md`;
      const proofPath = `proofs/${safe}.nanalproof`;
      // 팀 custody 우선: 개인 GitHub 연결 여부와 무관하게 서버 프록시로 조직 repo에 미러.
      if (team) {
        const okNote = await this.proxyPut(contentPath, original);
        if (okNote !== true) return false; // false(재시도) 또는 오프보딩(proxyPut이 teamCustody 정리·중단)
        const okProof = await this.proxyPut(proofPath, proofBody);
        if (okProof !== true) return false;
        if (!silent) new Notice(t.mirrorOk(`${team.org}/${team.repo}`));
        return true;
      }
      await this.ensureGithubReadme();
      const okNote = await this.githubPut(contentPath, original, msg);
      const okProof = await this.githubPut(proofPath, proofBody, msg);
      if (okNote && okProof) { if (!silent) new Notice(t.mirrorOk(this.settings.githubRepo)); return true; }
      return false; // 부분 실패 → mirrorIndex 미갱신, 다음 sweep에서 재시도
    } catch (e: any) {
      new Notice(t.mirrorFail(e?.message ?? String(e)));
      console.error("[nanalstamp] github mirror error", file.path, e);
      return false;
    }
  }

}
