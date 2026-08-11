// views.ts — 워크스페이스 ItemView 4종(원문 열람·노트 브라우저·대시보드·업무함).
// main.ts에서 순수 이동(2026-07-26). 모달을 부르지만 반대는 없다(단방향).

import { ItemView, MarkdownRenderer, Notice, Platform, TFile, ViewStateResult, WorkspaceLeaf, setIcon } from "obsidian";
import { t } from "./i18n";
import { pad2, fmtDate, fmtDateTime } from "./fmtutil";
import { sha256Hex, sha256HexBytes, basenameOf, extOf, isExcalidrawNote, splitExcalidrawName } from "./pathutil";
import { ICON_ID, ARCHIVE_SOURCE_VIEW_TYPE, NOTE_BROWSER_VIEW_TYPE, DASHBOARD_VIEW_TYPE, DASH_HASH_CAP, DASH_GAP_ROWS, DASH_TL_ROWS, TASK_INBOX_VIEW_TYPE } from "./constants";
import { NanalHistoryModal, RenameLinkSuggestModal, RestoreConfirmModal, RestoreVaultModal, StoragePendingModal } from "./modals";
import type NanalStampPlugin from "./main";
import { Setting } from "obsidian";
import { blobExt, blobContentType } from "./storagecore";
import { isMarkdownPath } from "./sealscope";
import type { RewindEntry } from "./rewindcore";
import { rowDisplay } from "./notebrowsercore";
import type { NoteRow, VaultRow } from "./notebrowsercore";
import { ArchiveEntry, coverage, gaps, timeline, heatmapCounts, syncStatus, certCandidates, Gap } from "./dashcore";
import { deletedEntries } from "./rewindcore";
import { unifyTasks, unionTasks, tasksRenderKey, isOverdue, isUnread, dueKind, personDisplay, taskActionDefs } from "./taskcore";
import type { TaskItem, TaskReply, UnifiedTask, TaskType } from "./taskcore";
import { renderWorkInbox, closePopover, actionLabel, runAction } from "./taskview";
import type { WorkInboxActions } from "./taskview";
import { TaskComposeModal, TaskRequestModal, TaskDeclineModal, TaskDetailModal, TaskDoneModal, TaskEditModal, TaskReopenModal, FolderCreateModal } from "./taskmodals";

// 확정 버전의 원문 열람 뷰(팝업 아님) — 현재 노트와 같은 편집 영역 크기의 탭. 분할 배치 가능.
// 상태(oid·rel·safe·isMd·notePath·seq·block·ts)는 leaf state로 받아 스스로 아카이브에서 읽는다(runArchive 락 경유).
// 앱 재시작 시 stale 상태로 복원돼도 읽기 실패면 안내 문구만 — 현재 노트를 절대 건드리지 않는다.

export interface ArchiveSourceState {
  oid: string;
  rel: string;
  safe: string;
  isMd: boolean;
  notePath: string;
  seq: string;
  block: string;
  ts: number;
}

export class ArchiveSourceView extends ItemView {
  private st: ArchiveSourceState | null = null;
  private objectUrl: string | null = null;
  // render() 재진입 가드 — setState가 겹치면 오래된 호출이 새 DOM을 덮어쓰지 않도록.
  private renderGen = 0;

  constructor(leaf: WorkspaceLeaf, private plugin: NanalStampPlugin) { super(leaf); }

  getViewType(): string { return ARCHIVE_SOURCE_VIEW_TYPE; }
  getIcon(): string { return ICON_ID; }
  // 상태바용 — 이 탭이 활성일 때 "어느 노트의 봉인 사본인지"를 표시(다른 노트 상태 혼동 방지).
  displayBasename(): string | null { return this.st ? basenameOf(this.st.notePath) : null; }
  getDisplayText(): string {
    if (!this.st) return t.histSourceTitle;
    // nanal 소스는 seq를 모른다 — 경로·해시 없이 노트 이름만으로 깔끔한 탭 제목.
    if (this.st.oid.startsWith("nanal:")) return t.nanalViewTitle(basenameOf(this.st.notePath));
    return t.histTabTitle(basenameOf(this.st.notePath), this.st.seq);
  }

  // leaf state 왕복 — getState로 저장돼 앱 재시작 후 setState로 복원된다.
  getState(): Record<string, unknown> {
    return this.st ? { ...this.st } : {};
  }
  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const s = state as Partial<ArchiveSourceState> | null;
    if (s && typeof s.oid === "string" && typeof s.notePath === "string") {
      this.st = {
        oid: s.oid,
        rel: String(s.rel ?? ""),
        safe: String(s.safe ?? ""),
        isMd: !!s.isMd,
        notePath: s.notePath,
        seq: String(s.seq ?? "?"),
        block: String(s.block ?? "?"),
        ts: typeof s.ts === "number" ? s.ts : 0,
      };
    }
    await super.setState(state, result);
    void this.render();
  }

  async onOpen(): Promise<void> { await this.render(); }
  async onClose(): Promise<void> { this.releaseUrl(); this.contentEl.empty(); }

  private releaseUrl() {
    if (this.objectUrl) { URL.revokeObjectURL(this.objectUrl); this.objectUrl = null; }
    for (const u of this.embedUrls) URL.revokeObjectURL(u);
    this.embedUrls = [];
  }

  // 원래 노트 모습 재현 — Obsidian 인라인 제목(파일명)을 본문 위에 렌더. 테마 변수(--inline-title-*)를
  // 상속해 사용자의 테마와 동일하게 보이고, "인라인 제목 표시" 설정을 끈 사용자에겐 원래처럼 안 보인다.
  private addInlineTitle(md: HTMLElement, notePath: string) {
    const cfg = (this.app.vault as unknown as { getConfig?: (k: string) => unknown }).getConfig?.("showInlineTitle");
    if (cfg === false) return;
    md.createDiv({ text: basenameOf(notePath).replace(/\.md$/i, ""), cls: "inline-title" });
  }

  // S3-only 임베드 하이드레이션 — nanal 소스 열람의 원칙: 모든 첨부는 S3 봉인본에서만 가져온다.
  // vault에 같은 이름 파일이 있어도 무시(혼합 금지) — MarkdownRenderer가 로컬로 채운 임베드까지 전부 교체.
  // 버전은 노트 봉인 시각과 상관(sealedEmbedVersion), 봉인본이 없으면 정직하게 "없음" 표시(로컬 폴백 없음).
  // 형식: 이미지·오디오·비디오·md(1단계 트랜스클루전)·텍스트류 렌더, 그 외는 파일로 저장 버튼.
  private embedUrls: string[] = [];

  // 내부 링크를 봉인 세계 탐색으로 — 클릭 시 로컬 노트 대신 그 노트의 봉인본을 "별도 탭"으로 연다.
  // 버전은 이 탭의 봉인 시각 이하 최신(시점 일관 체인). 봉인 안 된 노트는 정직한 안내.
  // 탭 단위 탐색이라 깊이·순환 문제가 구조적으로 없다(각 탭은 독립 1단계 렌더 — 2026-07-22 사용자 설계).
  private hookSealedLinks(md: HTMLElement, st: ArchiveSourceState): void {
    for (const a of Array.from(md.querySelectorAll<HTMLElement>("a.internal-link"))) {
      const target = (a.getAttribute("data-href") ?? a.getAttribute("href") ?? "").split("#")[0].trim();
      if (!target) continue;
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        void this.openSealedByLink(target, st);
      }, { capture: true }); // Obsidian 기본 내부링크 핸들러보다 먼저
    }
  }

  private async openSealedByLink(link: string, st: ArchiveSourceState): Promise<void> {
    const m = await this.plugin.sealedEmbedVersion(link, st.ts);
    if (!m) { new Notice(t.embedNotSealed(link)); return; }
    await this.plugin.openNanalView(m.path, m.hash, m.path.toLowerCase().endsWith(".md"), m.receivedAt);
  }

  private async hydrateSealedEmbeds(md: HTMLElement, st: ArchiveSourceState, gen: number, depth = 0): Promise<void> {
    if (!this.plugin.settings.apiKey) return;
    const embeds = Array.from(md.querySelectorAll<HTMLElement>(".internal-embed[src]"));
    for (const emEl of embeds) {
      const raw = emEl.getAttribute("src") ?? "";
      const link = raw.split("#")[0].split("|")[0].trim().replace(/^\.\//, "");
      if (!link) continue;
      const m = await this.plugin.sealedEmbedVersion(link, st.ts);
      if (gen !== this.renderGen) return;
      emEl.empty();
      emEl.addClass("nanalstamp-embed-hydrated");
      if (!m) { emEl.createSpan({ text: t.embedNotSealed(link), cls: "nanalstamp-archive-note" }); continue; }
      const ext = blobExt(m.path);
      const r = await this.plugin.nanalFetch(m.hash, ext, ext === "md");
      if (gen !== this.renderGen) return;
      if ("error" in r) { emEl.createSpan({ text: r.error, cls: "nanalstamp-archive-note" }); continue; }
      await this.renderSealedEmbed(emEl, m, r.data, st, gen, depth);
    }
  }

  private async renderSealedEmbed(emEl: HTMLElement, m: { hash: string; path: string }, data: string | ArrayBuffer, st: ArchiveSourceState, gen: number, depth: number): Promise<void> {
    const ext = blobExt(m.path);
    const imgExts = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
    const audioExts = ["mp3", "wav", "m4a", "ogg", "oga", "flac", "3gp", "aac", "webm"];
    const videoExts = ["mp4", "ogv", "mov", "mkv"];
    const textExts = ["csv", "json", "canvas", "excalidraw", "txt"];
    const toUrl = (bytes: ArrayBuffer) => {
      const url = URL.createObjectURL(new Blob([bytes], { type: blobContentType(m.path) }));
      this.embedUrls.push(url);
      return url;
    };
    if (ext === "md") {
      // 트랜스클루전 — 봉인 md를 중첩 렌더. 중첩 임베드도 S3-only 원칙 유지, 순환 방지로 1단계까지만.
      const box = emEl.createDiv({ cls: "markdown-embed nanalstamp-archive-md markdown-rendered" });
      await MarkdownRenderer.render(this.app, data as string, box, m.path, this);
      this.hookSealedLinks(box, st); // 트랜스클루전 안의 링크도 봉인 탐색
      if (depth < 1) await this.hydrateSealedEmbeds(box, st, gen, depth + 1);
      else for (const nested of Array.from(box.querySelectorAll<HTMLElement>(".internal-embed[src]"))) {
        // 깊은 중첩은 인라인 대신 링크 — 클릭하면 별도 탭(탭 단위 탐색이라 깊이 제한이 체감되지 않음)
        const n = (nested.getAttribute("src") ?? "").split("#")[0].split("|")[0].trim();
        nested.empty();
        const lk = nested.createSpan({ text: n, cls: "nanalstamp-sealed-link" });
        lk.addEventListener("click", (ev) => { ev.stopPropagation(); void this.openSealedByLink(n, st); });
      }
    } else if (imgExts.includes(ext)) {
      const img = emEl.createEl("img", { cls: "nanalstamp-archive-img" });
      img.src = toUrl(data as ArrayBuffer);
      img.alt = m.path;
    } else if (audioExts.includes(ext)) {
      const audio = emEl.createEl("audio");
      audio.controls = true;
      audio.src = toUrl(data as ArrayBuffer);
    } else if (videoExts.includes(ext)) {
      const video = emEl.createEl("video", { cls: "nanalstamp-archive-img" });
      video.controls = true;
      video.src = toUrl(data as ArrayBuffer);
    } else if (textExts.includes(ext)) {
      const text = typeof data === "string" ? data : new TextDecoder("utf-8").decode(new Uint8Array(data));
      emEl.createEl("pre", { cls: "nanalstamp-source-view" }).createEl("code", { text });
    } else {
      // pdf/xlsx 등 인라인 미리보기 비대상 — renderAttachment와 동일하게 "파일로 저장"(클릭 시 임시 URL).
      const bytes = data as ArrayBuffer;
      new Setting(emEl).setName(basenameOf(m.path)).addButton((b) => b.setButtonText(t.histSaveFile).onClick(() => {
        const url = URL.createObjectURL(new Blob([bytes], { type: blobContentType(m.path) }));
        const a = createEl("a");
        a.href = url;
        a.download = basenameOf(m.path);
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }));
    }
  }

  private async render(): Promise<void> {
    const gen = ++this.renderGen;
    this.releaseUrl();
    const el = this.contentEl;
    el.empty();
    el.addClass("nanalstamp-archive-source");
    const st = this.st;
    if (!st) { el.createEl("p", { text: t.histSourceStale, cls: "nanalstamp-archive-note" }); return; }

    const nanalHash = st.oid.startsWith("nanal:") ? st.oid.slice("nanal:".length) : null;

    // 읽기 전용 배너 — 현재 노트와의 혼동 방지가 목적.
    const banner = el.createDiv({ cls: "nanalstamp-archive-banner" });
    if (nanalHash) {
      banner.setText(t.nanalViewBanner(basenameOf(st.notePath), nanalHash.slice(0, 8)));
    } else {
      const when = fmtDateTime(new Date(st.ts * 1000));
      banner.setText(t.histBanner(basenameOf(st.notePath), st.seq, st.block, when));
    }

    const host = el.createDiv({ cls: "nanalstamp-archive-body" });
    const loading = host.createEl("p", { text: t.pitReading, cls: "nanalstamp-archive-note" });

    // Excalidraw 사본 열기 버튼용 원문 텍스트(md 또는 텍스트형 첨부만 채워짐 — 채워져야 버튼을 낸다).
    let restoreText: string | null = null;
    // 그날로: 복원 버튼용 기대 해시 — 소스별로 신뢰 순서가 다르다.
    // nanal 소스 = 봉인 해시 그 자체 / 로컬 md = 커밋 동반 proof의 file_hash / 로컬 첨부 = 바이트 해시(태그·재검증용).
    // 로컬 md의 proof가 없거나 손상이면 자기 해시 폴백 — 이때 게이트는 아카이브 읽기 무결성만 확인(진본성 게이트 아님).
    let restoreHash: string | null = null;

    // B: nanal 스토리지 소스 — 뷰가 직접 내려받아 해시 재검증 후 렌더(첨부는 renderAttachment 재사용).
    if (nanalHash) {
      const r = await this.plugin.nanalFetch(nanalHash, st.rel, st.isMd);
      if (gen !== this.renderGen) return;
      loading.remove();
      if ("error" in r) { host.createEl("p", { text: r.error, cls: "nanalstamp-archive-note" }); return; }
      restoreHash = nanalHash;
      if (st.isMd) {
        restoreText = r.data as string;
        const md = host.createDiv({ cls: "nanalstamp-archive-md markdown-rendered" });
        this.addInlineTitle(md, st.notePath);
        await MarkdownRenderer.render(this.app, restoreText, md, st.notePath, this);
        this.hookSealedLinks(md, st); // 내부 링크 → 봉인본 별도 탭(로컬 노트로 새지 않음)
        await this.hydrateSealedEmbeds(md, st, gen); // S3-only: 로컬 파일 존재 여부와 무관하게 전 임베드 교체
        this.lockInputs(md);
      } else {
        const bytes = new Uint8Array(r.data as ArrayBuffer);
        if (isExcalidrawNote(st.notePath)) restoreText = new TextDecoder("utf-8").decode(bytes);
        this.renderAttachment(host, bytes, st);
      }
    } else if (st.isMd) {
      const read = await this.plugin.readArchivedVersion(st.oid, st.safe);
      if (gen !== this.renderGen) return; // 더 새로운 render가 시작됨
      loading.remove();
      if (!read) { host.createEl("p", { text: t.histSourceStale, cls: "nanalstamp-archive-note" }); return; }
      restoreText = read.note;
      restoreHash = String(read.proof?.file_hash || "") || (await sha256Hex(read.note));
      // 리딩뷰처럼 렌더 — pre보다 노트답게 보인다. 내부 링크는 무해하게 둔다(sourcePath로 상대경로 해석).
      const md = host.createDiv({ cls: "nanalstamp-archive-md markdown-rendered" });
      this.addInlineTitle(md, st.notePath);
      await MarkdownRenderer.render(this.app, restoreText, md, st.notePath, this);
      // 로컬 아카이브 소스는 로컬 전용 — S3 하이드레이션 없음(소스 분리 원칙). 임베드는 vault 해석 그대로.
      this.lockInputs(md);
    } else {
      const bytes = await this.plugin.archiveReadBytes(st.oid, st.rel);
      if (gen !== this.renderGen) return;
      loading.remove();
      if (!bytes) { host.createEl("p", { text: t.histSourceStale, cls: "nanalstamp-archive-note" }); return; }
      restoreHash = await sha256HexBytes(bytes);
      if (isExcalidrawNote(st.notePath)) restoreText = new TextDecoder("utf-8").decode(bytes);
      this.renderAttachment(host, bytes, st);
    }

    // MarkdownRenderer.render await 사이 새 render()가 시작됐을 수 있다 — 스테일 렌더가 라이브 el에
    // 버튼을 주입하지 않도록 재검사(위 fetch 후 가드와 같은 원칙).
    if (gen !== this.renderGen) return;

    // 그날로: 이 버전으로 복원 — 확인 모달에서 사본/원위치 선택. 로컬 소스는 oid로 재획득해 해시 게이트를 지난다.
    if (restoreHash) {
      const rh = restoreHash;
      new Setting(el).addButton((b) => b.setButtonText(t.rewindRestoreBtn).onClick(() => {
        new RestoreConfirmModal(this.app, this.plugin, {
          notePath: st.notePath,
          expectedHash: rh,
          oid: nanalHash ? undefined : st.oid,
          isMd: st.isMd,
          seq: st.seq,
          when: st.ts ? fmtDateTime(new Date(st.ts * 1000)) : "",
        }).open();
      }));
    }

    // Excalidraw 노트 — 압축 JSON+경고를 그대로 보여줘봐야 무의미하므로, vault 사본을 만들어
    // Excalidraw 플러그인이 설치돼 있으면 그림으로 열리도록 안내 버튼을 배너 아래에 추가한다.
    if (restoreText != null && isExcalidrawNote(st.notePath, restoreText)) {
      new Setting(el).addButton((b) =>
        b.setButtonText(t.excalidrawOpenCopy).setCta().onClick(async () => {
          try {
            const file = await this.writeExcalidrawCopy(st.notePath, restoreText);
            new Notice(t.excalidrawCopyNotice(file.path));
            await this.app.workspace.getLeaf("tab").openFile(file);
          } catch (e: unknown) {
            // vault.create 실패(권한·동시 생성 레이스 등) — 조용한 무반응 대신 실패를 알린다.
            new Notice(t.nanalRestoreFail(e instanceof Error ? e.message : String(e)));
          }
        })
      );
    }
  }

  // Excalidraw 사본을 nanalStamp/restore/<원본파일명>에 새 파일로 쓴다(동명 존재 시 타임스탬프 접미).
  // 원본·아카이브는 절대 건드리지 않는다 — 여기서 만드는 건 항상 새 파일.
  private async writeExcalidrawCopy(notePath: string, content: string): Promise<TFile> {
    const folder = "nanalStamp/restore";
    await this.plugin.ensureVaultFolder(folder);
    const fullName = notePath.split(/[\\/]/).pop() || notePath;
    const { base, ext } = splitExcalidrawName(fullName);
    let target = `${folder}/${fullName}`;
    if (this.app.vault.getAbstractFileByPath(target)) {
      const now = new Date();
      const stamp = `${fmtDate(now)} ${pad2(now.getHours())}${pad2(now.getMinutes())}`;
      target = `${folder}/${base} (${t.excalidrawCopySuffix} ${stamp})${ext}`;
    }
    return await this.app.vault.create(target, content);
  }

  // 렌더된 체크박스 등 입력 요소를 잠근다 — 클릭 토글이 보관본을 편집하는 듯한 착시 방지(저장은 원래 안 됨).
  private lockInputs(md: HTMLElement) {
    md.querySelectorAll("input").forEach((el) => { (el).disabled = true; });
  }

  // git.readBlob의 Uint8Array를 Blob이 받는 순수 ArrayBuffer로 복사(SharedArrayBuffer 유니온 회피).
  private toBlob(bytes: Uint8Array, type?: string): Blob {
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    return type ? new Blob([ab], { type }) : new Blob([ab]);
  }

  // 첨부 렌더: 이미지는 Blob URL <img>(가운데 정렬), 텍스트형은 디코딩해 <pre>, 그 외(pdf/xlsx 등)는 저장 버튼만.
  private renderAttachment(host: HTMLElement, bytes: Uint8Array, st: ArchiveSourceState) {
    const ext = (extOf(st.notePath) || "").toLowerCase();
    const imgExts = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
    const textExts = ["csv", "json", "canvas", "excalidraw", "txt", "md"];
    if (imgExts.includes(ext)) {
      const mime = ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      this.objectUrl = URL.createObjectURL(this.toBlob(bytes, mime));
      const img = host.createEl("img", { cls: "nanalstamp-archive-img" });
      img.src = this.objectUrl;
    } else if (textExts.includes(ext)) {
      const text = new TextDecoder("utf-8").decode(bytes);
      host.createEl("pre", { cls: "nanalstamp-source-view" }).createEl("code", { text });
    } else {
      // pdf/xlsx 등 미리보기 비대상 — "파일로 저장"만(임시 Blob URL은 클릭 직후 revoke).
      new Setting(host).setName(t.histSaveHint).addButton((b) => b.setButtonText(t.histSaveFile).setCta().onClick(() => {
        const url = URL.createObjectURL(this.toBlob(bytes));
        const a = createEl("a");
        a.href = url;
        a.download = basenameOf(st.notePath);
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }));
    }
  }
}

// ── 봉인 노트 브라우저 — 계정 원장 기반, 최신 봉인순. 열람은 openNanalView(S3 읽기 전용 탭) 재사용.
export class NoteBrowserView extends ItemView {
  private plugin: NanalStampPlugin;
  private rows: Array<{ row: NoteRow; name: string | null }> = [];
  private hasMore = false;
  private loading = false; // "더 보기" 연타 시 같은 커서로 중복 fetch 방지
  private vaults: Array<{ hash: string; name: string }> = []; // 필터 드롭다운(복호된 이름)
  private selectedVault = ""; // ""=모든 vault, 아니면 vault_hash

  constructor(leaf: WorkspaceLeaf, plugin: NanalStampPlugin) {
    super(leaf);
    this.plugin = plugin;
  }
  getViewType(): string { return NOTE_BROWSER_VIEW_TYPE; }
  getDisplayText(): string { return t.browserTitle; }
  getIcon(): string { return ICON_ID; } // 나날 아이콘 — 다른 nanalStamp 뷰(사본·대시보드)와 통일

  async onOpen(): Promise<void> {
    if (this.plugin.usageStale()) void this.plugin.fetchStorageUsage(); // 열람 게이트 판정 갱신(D1)
    // vault 목록 — 서버 distinct에서 바로. 복호 실패 항목은 해시 8자로 표기(정직한 폴백).
    // vault 는 **해시가 정체다**(수렴 계약: 해시가 이름을 유일 결정). 그런데 서버는
    // (vault_hash, enc_vault) 쌍으로 distinct 하므로, 같은 vault 라도 이름 암호문이 여러 개면
    // 여러 줄로 온다 — 계정을 옮겼거나 키가 바뀌면 그렇게 된다. 그대로 나열하면 사용자는
    // **같은 vault 를 세 번 본다**(2026-07-31 실측: 해시 하나가 옵션 3개 — "f9202009"·"nanalStamp"·"nanalStamp").
    //
    // 해시로 묶고, 그 아래 암호문을 **하나씩 풀어 본다.** 최신 것이 지금 키로 안 풀릴 수 있어
    // 하나만 시도하면 이름을 잃고 해시 8자로 떨어진다. 하나라도 풀리면 그것이 이 vault 의 이름이다.
    const vs = await this.plugin.fetchSealedVaults();
    const byHash = new Map<string, VaultRow[]>();
    for (const v of vs) {
      const cur = byHash.get(v.vaultHash);
      if (cur) cur.push(v); else byHash.set(v.vaultHash, [v]);
    }
    this.vaults = [];
    for (const [hash, rows] of byHash) {
      let name: string | null = null;
      for (const r of rows) {
        name = await this.plugin.decryptVaultName(r);
        if (name) break;
      }
      this.vaults.push({ hash, name: name ?? hash.slice(0, 8) });
    }
    this.vaults.sort((a, b) => a.name.localeCompare(b.name));
    if (this.selectedVault && !this.vaults.some((v) => v.hash === this.selectedVault)) this.selectedVault = "";
    this.rows = [];
    this.loadGen++; // 새로고침도 진행 중 로드를 무효화(구 결과가 초기화된 목록에 붙는 경합 방지)
    await this.loadPage();
  }

  // 세대 카운터: vault 필터 변경이 진행 중인 로드와 겹치면 구 vault 결과가 새 선택 아래 렌더되고
  // 새 vault는 loading 가드에 막혀 영영 안 실리던 경합 수정(2026-07-22 검증 결함). 구 세대 결과는 버리고
  // 마지막 요청 세대가 끝나면 스스로 재시작한다.
  private loadGen = 0;
  private async loadPage(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    const gen = this.loadGen;
    try {
      const before = this.rows.length ? this.rows[this.rows.length - 1].row.seq : undefined;
      const page = await this.plugin.fetchSealedNotes(before, this.selectedVault || undefined);
      if (gen !== this.loadGen) return; // 구 세대 응답 폐기 — finally가 새 세대로 재시작
      if (!page) { this.renderError(); return; }
      for (const row of page.rows) this.rows.push({ row, name: await this.plugin.decryptNoteName(row) });
      this.hasMore = page.hasMore;
      this.render();
    } finally {
      this.loading = false;
      if (gen !== this.loadGen) void this.loadPage(); // 로드 중 vault가 바뀌었다 — 새 조건으로 즉시 재조회
    }
  }

  private renderError(): void {
    const c = this.contentEl;
    c.empty();
    c.createEl("p", { text: t.browserLoadFail });
    c.createEl("button", { text: t.browserRetry }).addEventListener("click", () => void this.onOpen());
  }

  private render(): void {
    const c = this.contentEl;
    c.empty();
    // 헤더: 제목 + vault 필터 + 새로고침(목록 리셋 후 1페이지부터 재조회)
    const head = c.createDiv({ cls: "nanal-browser-head" });
    head.createEl("h3", { text: t.browserTitle });
    const controls = head.createDiv({ cls: "nanal-browser-controls" });
    if (this.vaults.length > 0) { // vault가 하나라도 등록되면 표시("모든 vault"에는 vault 미상 구 봉인도 포함되므로 1개여도 필터 의미 있음)
      const sel = controls.createEl("select", { cls: "dropdown" });
      sel.createEl("option", { text: t.browserVaultAll, value: "" });
      for (const v of this.vaults) sel.createEl("option", { text: v.name, value: v.hash });
      sel.value = this.selectedVault;
      sel.addEventListener("change", () => {
        this.selectedVault = sel.value;
        this.rows = [];
        this.loadGen++; // 진행 중 로드 무효화(구 vault 결과 폐기) — loadPage가 새 세대로 이어받는다
        void this.loadPage();
      });
    }
    const restore = controls.createEl("button", { text: t.restoreVaultTitle });
    restore.addEventListener("click", () => new RestoreVaultModal(this.app, this.plugin).open());
    const refresh = controls.createEl("button", { text: t.browserRefresh });
    refresh.addEventListener("click", () => void this.onOpen());
    if (!this.rows.length) { c.createEl("p", { text: t.browserEmpty }); return; }
    const list = c.createDiv({ cls: "nanal-browser-list" });
    for (const { row, name } of this.rows) {
      const d = rowDisplay(row, name);
      const item = list.createDiv({ cls: "nanal-browser-row" });
      const label = item.createDiv({ cls: "nanal-browser-label" });
      if (d.folder) label.createSpan({ text: d.folder + "/", cls: "nanal-browser-folder" });
      label.createSpan({ text: d.file });
      if (!d.canOpen) { label.addClass("is-unnamed"); label.setAttr("title", t.browserUnnamedHint); }
      item.createSpan({ text: new Date(row.receivedAt * 1000).toLocaleString(), cls: "nanal-browser-when" });
      item.createSpan({ text: row.block != null ? `₿ ${row.block}` : "…", cls: "nanal-browser-status" });
      if (d.canOpen) {
        // 봉인 버전 이력 — 노트당 최신 1행만 보이므로 과거 버전은 여기서(모바일 노트의 '그날로').
        const hist = item.createEl("button", { text: t.browserHistoryBtn, cls: "nanal-browser-hist" });
        hist.addEventListener("click", (ev) => {
          ev.stopPropagation(); // 행 클릭(최신본 열람)과 분리
          if (!this.plugin.hasStoragePlan()) { new Notice(t.browserNeedPlan); return; }
          new NanalHistoryModal(this.app, this.plugin, name as string, row.pathHash, d.isMd).open();
        });
        item.addClass("is-clickable");
        item.addEventListener("click", () => {
          void (async () => {
            // D1: usage 미조회(null)면 판정 전 1회 대기 — 세션 초기 유료 사용자 오탐 방지. 캐시 있으면 즉시.
            if (!this.plugin.hasStoragePlan() && this.plugin.lastUsage == null) await this.plugin.fetchStorageUsage();
            if (!this.plugin.hasStoragePlan()) { new Notice(t.browserNeedPlan); return; }
            await this.plugin.openNanalView(name as string, row.fileHash, d.isMd, row.receivedAt);
          })();
        });
      }
    }
    if (this.hasMore) {
      const more = c.createEl("button", { text: t.browserMore, cls: "nanal-browser-more" });
      more.addEventListener("click", () => void this.loadPage());
    }
  }
}

// ── 증빙 상태 대시보드(PRO) ──────────────────────────────────────────────────
// 원칙: (1) nanalStamp만 아는 데이터(원장·아카이브·앵커)만 (2) 전부 로컬 계산 — 서버 호출 없음
// (3) 점수·독려 없음("증거가 얼마나 단단한가"만). 스펙: docs/2026-07-09-pro-dashboard-v1-spec.md

export class DashboardView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private plugin: NanalStampPlugin) { super(leaf); }
  getViewType(): string { return DASHBOARD_VIEW_TYPE; }
  getDisplayText(): string { return t.dashTitle; }
  getIcon(): string { return ICON_ID; }

  // render() 재진입 가드 — refresh 클릭/reveal이 겹치면 오래된 호출이 새 DOM을 덮어쓰지 않도록.
  private renderGen = 0;

  async onOpen(): Promise<void> { await this.render(); }
  async onClose(): Promise<void> { this.contentEl.empty(); }

  // 카드 확대 상태 — 값이 있으면 그 카드만 전체 폭으로 렌더(행 수 상한도 늘어남)
  private zoom: "gaps" | "timeline" | "heat" | "cands" | null = null;

  private card(parent: HTMLElement, title: string, extraCls?: string, zoomKey?: "gaps" | "timeline" | "heat" | "cands"): HTMLElement {
    const zoomed = zoomKey != null && this.zoom === zoomKey;
    const cls = ["nanalstamp-card"];
    if (extraCls) cls.push(extraCls);
    if (zoomed) cls.push("span3", "is-zoom");
    const c = parent.createDiv({ cls: cls.join(" ") });
    const h = c.createEl("h3", { text: title });
    if (zoomKey) {
      const b = h.createEl("button", { cls: "nanalstamp-dash-zoombtn" });
      setIcon(b, zoomed ? "minimize-2" : "maximize-2");
      b.setAttr("aria-label", zoomed ? t.dashCollapse : t.dashExpand);
      b.setAttr("title", zoomed ? t.dashCollapse : t.dashExpand);
      b.onclick = () => { this.zoom = zoomed ? null : zoomKey; void this.render(false); };
    }
    return c;
  }

  // 링 게이지(SVG) — 값이 숫자(pct)뿐이라 innerHTML 대신 DOM API(createElementNS)로 직접 구성.
  // 링 = 스택 바와 동일한 조성·색(증명 완료=빨강, 확정 대기=파랑) — 같은 색이 다른 수치를 가리키던
  // 오독(링 100% 빨강 vs 바 빨강 74%) 제거(2026-07-22 사용자 지적). 합이 보호율, 색이 내역.
  private buildGauge(coveredPct: number, pendingPct: number): HTMLElement {
    const pct = Math.min(100, coveredPct + pendingPct);
    const wrap = createDiv();
    wrap.className = "nanalstamp-dash-gauge";
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 120 120");
    svg.setAttribute("width", "148");
    svg.setAttribute("height", "148");
    const track = document.createElementNS(ns, "circle");
    track.setAttribute("cx", "60"); track.setAttribute("cy", "60"); track.setAttribute("r", "50");
    track.setAttribute("fill", "none"); track.setAttribute("stroke", "var(--ns-empty)"); track.setAttribute("stroke-width", "11");
    svg.appendChild(track);
    const seg = (startPct: number, lenPct: number, color: string) => {
      if (lenPct <= 0) return;
      const a = document.createElementNS(ns, "circle");
      a.setAttribute("cx", "60"); a.setAttribute("cy", "60"); a.setAttribute("r", "50");
      a.setAttribute("fill", "none"); a.setAttribute("stroke", color); a.setAttribute("stroke-width", "11");
      a.setAttribute("stroke-dasharray", `${lenPct * 3.14} 314`);
      a.setAttribute("transform", `rotate(${-90 + startPct * 3.6} 60 60)`);
      svg.appendChild(a);
    };
    seg(0, coveredPct, "var(--ns-seal)");          // 증명 완료(빨강)
    seg(coveredPct, pendingPct, "var(--ns-info)"); // 확정 대기(파랑) — 진행 중
    wrap.appendChild(svg);
    const center = createDiv();
    center.className = "nanalstamp-dash-gauge-center";
    const pctEl = createDiv();
    pctEl.className = "nanalstamp-dash-gauge-pct num";
    pctEl.textContent = `${pct}%`;
    const lblEl = createDiv();
    lblEl.className = "nanalstamp-dash-gauge-lbl";
    lblEl.textContent = t.dashGaugeLabel;
    center.appendChild(pctEl);
    center.appendChild(lblEl);
    wrap.appendChild(center);
    return wrap;
  }

  // 즉시 툴팁 — setTooltip은 앱 전역 지연이 걸려 체감이 느렸다(2026-07-22). 자체 싱글턴 div로
  // mouseenter 즉시 표시(0ms 보장), \n 줄바꿈은 pre-line으로 문구에 정의된 대로 렌더.
  private static tipEl: HTMLElement | null = null;
  private showTipAt(el: HTMLElement, text: string): void {
    let tp = DashboardView.tipEl;
    if (!tp) {
      tp = document.body.createDiv({ cls: "nanalstamp-tip" });
      DashboardView.tipEl = tp;
    }
    tp.setText(text);
    tp.addClass("is-shown");
    const r = el.getBoundingClientRect();
    tp.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - tp.offsetWidth - 8))}px`;
    const below = r.bottom + 6;
    tp.style.top = below + tp.offsetHeight + 8 > window.innerHeight ? `${r.top - tp.offsetHeight - 6}px` : `${below}px`;
  }

  private hideTip(): void {
    if (DashboardView.tipEl) DashboardView.tipEl.removeClass("is-shown");
  }

  private tip(el: HTMLElement, text: string): void {
    el.addEventListener("mouseenter", () => this.showTipAt(el, text));
    el.addEventListener("mouseleave", () => this.hideTip());
  }

  private monthLabel(d: Date): string {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
  }

  // 확대/축소 토글용 데이터 캐시 — zoom은 레이아웃만 바뀌므로 해시·git log 재계산 금지(2026-07-22 성능 지적).
  private dashData: {
    cov: ReturnType<typeof coverage>; gapList: Gap[]; entries: ArchiveEntry[]; candEntries: ArchiveEntry[]; deleted: RewindEntry[];
    sync: ReturnType<typeof syncStatus>;
    store: { total: number; noteCnt: number; attCnt: number; archPend: string[]; mirPend: string[]; nanPend: string[]; nanDone: number; nanExcl: number };
    heatWeeks: ReturnType<typeof heatmapCounts>; skipped: number;
    pendingSeals: Set<string>; latePending: Set<string>; pendModified: number; pendUnsealed: number;
  } | null = null;

  async render(recompute = true): Promise<void> {
    const gen = ++this.renderGen;
    const el = this.contentEl;
    el.empty();
    el.addClass("nanalstamp-dash");
    const head = el.createDiv({ cls: "nanalstamp-dash-head" });
    const headText = head.createDiv();
    headText.createEl("p", { text: t.dashTitle, cls: "nanalstamp-dash-title" });
    headText.createEl("p", { text: t.dashSub, cls: "nanalstamp-dash-sub" });
    const refresh = head.createEl("button", { text: t.dashRefresh });
    refresh.onclick = () => void this.render();

    if (!recompute && this.dashData) {
      this.renderBody(el, this.dashData);
      return;
    }

    // ── 데이터 수집(전부 로컬) ────────────────────────────────────────────
    // 참조 첨부 집합을 **수집 시작 전에 한 번** 최신화한다. 이 렌더의 모든 판정(dashInScope →
    // inSealScope, sealablePath, nanalEligible)이 같은 스냅샷을 봐야 한다 — 중간에 재계산하면
    // 한 화면 안에서 분모(파이프라인 대상)와 분자(대기·완료 목록)가 다른 집합으로 계산돼
    // 합계가 어긋난다(대시보드 신뢰성 원칙: 합계는 분할되어야 하고 유령 주장이 없어야 한다).
    // 비용은 resolvedLinks 메모리 순회로 ms 단위 — 파일 I/O 없음.
    this.plugin.rebuildReferencedSet();
    const all = this.plugin.app.vault.getMarkdownFiles().filter((f) => this.plugin.dashInScope(f.path));
    const files = all.slice(0, DASH_HASH_CAP);
    const skipped = all.length - files.length;
    const hashes = new Map<string, string>();
    for (const f of files) {
      const h = await this.plugin.currentHashCached(f);
      if (h) hashes.set(f.path, h);
    }
    if (gen !== this.renderGen) return; // 재진입 가드 ① — 해시 계산 중 새 render()가 시작됐으면 중단
    const metas = files.map((f) => ({ path: f.path, mtime: f.stat.mtime }));
    const ledger = this.plugin.settings.ledgerIndex;
    const hashOf = (p: string) => hashes.get(p);
    const cov = coverage(metas, ledger, hashOf);
    const gapList = gaps(metas, ledger, hashOf);

    // 아카이브 로그는 pending 포함 1회만 순회(rewindLog) — 확정 전용 목록(entries)은 block 유무로 파생한다.
    // parseRewindCommit이 parseArchiveCommit의 상위집합이라 archiveLog를 따로 도는 건 같은 git.log 2회 순회였다(리뷰 지적).
    const rewindEntries = await this.plugin.rewindLog();
    if (gen !== this.renderGen) return; // 재진입 가드 ② — 아카이브 로그 조회 중 새 render()가 시작됐으면 중단
    const entries: ArchiveEntry[] = rewindEntries
      .filter((e): e is RewindEntry & { block: string } => e.block !== null)
      .map((e) => ({ notePath: e.notePath, seq: e.seq, block: e.block, ts: e.ts }));
    // ★ 개명 계보와 삭제 목록은 **여기서 기다리지 않는다**(2026-07-31).
    //
    //   실 vault(md 903건) 실측 — 화면이 비어 있는 동안 흐르는 시간이다:
    //     해시 903건 0.0초 · rewindLog 1.4초 · renameLineage 139.8초 · filterRenamed 35.7초
    //
    // 앞의 둘은 즉답인데 뒤의 둘 때문에 **3분간 머리글만 보였다.** 그런데 뒤의 둘이 필요한 것은
    // 「삭제된 노트」 카드와 이력 카드의 경로 보정뿐이고, 사용자가 보러 오는 것(보호율·앵커
    // 상태·동기화)은 이미 다 계산돼 있다. 다 끝나야 그린다는 규칙 하나 때문에 전부가 기다렸다.
    //
    // 그래서 지금 아는 것으로 먼저 그리고, 계보가 나오면 그 두 카드만 다시 그린다.
    // deleted 는 빈 목록으로 시작한다 — 없다고 단정하는 것이 아니라 **아직 모른다**는 뜻이고,
    // 그동안 카드 자리에 "찾는 중"을 세워 비어 있는 것과 구분한다.
    const deleted: RewindEntry[] = [];
    const candEntries = entries.slice();

    // rename/삭제된 노트의 원장 항목은 표시에서만 제외(원장 자체는 불변) — 아니면
    // 아카이브/미러가 따라잡을 수 없는 "대기 N건" 경고가 영구히 남는다.
    const ledgerLive: Record<string, string> = {};
    for (const [p, h] of Object.entries(ledger)) {
      if (this.plugin.app.vault.getAbstractFileByPath(p)) ledgerLive[p] = h;
    }
    const s = this.plugin.settings;
    // nanal 보관 축: 스토리지 켜짐일 때만 인덱스를 넘긴다(꺼짐=null → 카드 자체를 표시 안 함).
    // eligible: nanalBackfill=false면 nanalSince 이후 mtime 노트만 대상(삭제된 노트는 vault에 없어 false).
    const nanalOn = this.plugin.nanalActive();
    const nanalEligible = (p: string): boolean => {
      if (!this.plugin.dashInScope(p)) return false; // 봉인 범위 밖(복원 사본 등)은 업로드 대상 아님 — 영구 '대기' 좀비 방지
      if (s.nanalBackfill) return true; // 삭제된 노트(vault에 없음)도 backfill 켜짐이면 대상으로 취급
      const f = this.plugin.app.vault.getAbstractFileByPath(p);
      return f instanceof TFile && this.plugin.nanalEligibleFile(f);
    };
    const sync = syncStatus(ledgerLive, s.archiveIndex, s.mirrorIndex, entries, nanalOn ? s.nanalIndex : null, nanalEligible);
    // 보관 동기화는 "봉인된 최신 버전" 기준(확정과 무관) — 단, 봉인 전송본이 현재 내용과 일치할 때만.
    // 수정된 옛 전송(stale seal)은 재봉인 축 소관이라 여기 넣으면 영구 팬텀 대기가 된다(2026-07-22 실측 792건).
    const sealedBase: Record<string, string> = { ...ledgerLive };
    for (const [p2, h2] of Object.entries(s.sealedIndex)) {
      if (!this.plugin.app.vault.getAbstractFileByPath(p2)) continue;
      const cur = hashes.get(p2); // md는 이미 계산된 현재 해시로 검증(첨부는 비싸서 통과 — 사실상 불변)
      if (cur !== undefined && cur !== h2) continue;
      sealedBase[p2] = h2;
    }
    // 참조가 끊긴 첨부는 봉인 파이프라인 대상이 아니다(isSealable=false → 스윕·백필이 영원히 안 봄).
    // 유령 sealedIndex 주장(서버 초기화 잔재)까지 겹치면 '대기 N건'이 영구 고정된다(2026-07-22 실측 270건 전부 비참조 첨부).
    // 참조 집합은 이 렌더 진입부에서 이미 최신화됐다 — 여기서 다시 부르면 스냅샷이 둘로 갈린다.
    for (const p2 of Object.keys(sealedBase)) {
      if (!isMarkdownPath(p2) && !this.plugin.sealablePath(p2)) delete sealedBase[p2];
    }
    const archOn = this.plugin.dashboardArchiveOn();
    const mirOn = this.plugin.mirrorActive();
    const archPend: string[] = [], mirPend: string[] = [], nanPend: string[] = [];
    let nanDone = 0, nanExcl = 0;
    for (const [p2, h2] of Object.entries(sealedBase)) {
      if (archOn && s.archiveIndex[p2] !== h2) archPend.push(p2);
      if (mirOn && s.mirrorIndex[p2] !== h2) mirPend.push(p2);
      if (nanalOn) {
        if (!nanalEligible(p2)) nanExcl++;
        else if (s.nanalIndex[p2] === h2) nanDone++;
        else nanPend.push(p2);
      }
    }
    const baseKeys = Object.keys(sealedBase);
    const storeNoteCnt = baseKeys.filter((k) => isMarkdownPath(k)).length;
    const store = { total: baseKeys.length, noteCnt: storeNoteCnt, attCnt: baseKeys.length - storeNoteCnt, archPend, mirPend, nanPend, nanDone, nanExcl };
    // 히트맵 카운트: 신규 sealDayCounts 우선, 카운트 도입 전 날짜(sealDays)는 1건으로 보정
    const sealCounts: Record<string, number> = { ...s.sealDayCounts };
    for (const d of s.sealDays) if (!(d in sealCounts)) sealCounts[d] = 1;
    // 전체 이력 렌더(뷰포트는 카드가 제한, 과거는 드래그/스크롤) — 첫 기록일부터, 최소 12주·상한 10년.
    const dayKeys = Object.keys(sealCounts).sort();
    const firstDay = dayKeys[0];
    const histWeeks = firstDay
      ? Math.min(520, Math.max(12, Math.ceil((Date.now() - new Date(`${firstDay}T00:00:00`).getTime()) / (7 * 86_400_000)) + 1))
      : 12;
    const heatWeeks = heatmapCounts(sealCounts, fmtDate(new Date()), histWeeks);

    // 봉인 전송은 됐지만 아직 ₿ 확정 전인 노트 — 히어로·공백 목록에서 "확정 대기"로 구분 표시.
    // (히어로 미봉인/수정 수치와 "모두 봉인" 수가 안 맞아 보이는 혼동 방지: 959 = 대기 13 + 나머지 946)
    const pendingSeals = new Set<string>();
    const latePending = new Set<string>();
    let pendModified = 0, pendUnsealed = 0;
    // 확정 SLA: 봉인 시각의 "다음 자정 + 3h"까지 확정돼야 정상(서버 26h 스트래글러와 정합).
    // 시한을 넘긴 대기는 보호율에서 제외하고 '확정 지연'으로 경고 — 고장이 100%로 위장되지 않게(2026-07-22).
    const confirmDeadline = (sealedMs: number): number => {
      const d0 = new Date(sealedMs);
      return new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + 1, 0, 0, 0).getTime() + 3 * 3600_000;
    };
    let sealedAtDirty = false;
    for (const g of gapList) {
      const ph = this.plugin.pendingSealHash(g.path);
      if (ph && ph === hashes.get(g.path)) {
        pendingSeals.add(g.path);
        let at = s.sealedAt[g.path];
        if (!at) { at = Date.now(); s.sealedAt[g.path] = at; sealedAtDirty = true; } // 구봉인 유예 시작(부트스트랩)
        if (Date.now() > confirmDeadline(at)) latePending.add(g.path);
        else if (g.kind === "modified") pendModified++; else pendUnsealed++;
      }
    }
    if (sealedAtDirty) void this.plugin.saveSettings();

    const data = { cov, gapList, entries, candEntries, deleted, sync, store, heatWeeks, skipped, pendingSeals, latePending, pendModified, pendUnsealed };
    this.dashData = data;
    this.lineagePending = true;
    this.renderBody(el, data);

    // 2단계 — 느린 계보 계산. 끝나면 그 두 카드가 든 본문만 다시 그린다.
    // 실패해도 1차 화면은 그대로 산다(그날로 카드만 안 나온다).
    void (async () => {
      try {
        const lineage = await this.plugin.renameLineage(rewindEntries);
        if (gen !== this.renderGen) return;   // 그 사이 새 render() 가 시작됐으면 버린다
        const del = (await this.plugin.filterRenamed(
          deletedEntries(rewindEntries, (p) => !!this.plugin.app.vault.getAbstractFileByPath(p))))
          .filter((e) => !lineage[e.notePath]);
        if (gen !== this.renderGen) return;
        data.deleted = del;
        data.candEntries = entries.map((e) => (lineage[e.notePath] ? { ...e, notePath: lineage[e.notePath] } : e));
      } catch (e) {
        console.error("[nanalstamp] dashboard lineage", e);
      } finally {
        if (gen === this.renderGen) {
          this.lineagePending = false;
          void this.render(false);   // dashData 재사용 — 해시·git log 를 다시 돌지 않는다
        }
      }
    })();
  }

  /// 계보 계산이 아직 도는 중인가. 「삭제된 노트」 카드가 "없다"와 "아직 모른다"를 구분하는 근거다.
  private lineagePending = false;

  private renderBody(el: HTMLElement, data: NonNullable<DashboardView["dashData"]>): void {
    const { cov, gapList, entries, candEntries, deleted, sync, store, heatWeeks, skipped, pendingSeals, latePending, pendModified, pendUnsealed } = data;
    // 확대 모드: 선택한 카드 하나만 전체 폭으로 (히어로·다른 카드 생략, 헤더의 새로고침은 유지)
    if (this.zoom && this.plugin.isPro()) {
      const zgrid = el.createDiv({ cls: "nanalstamp-dash-grid3" });
      if (this.zoom === "gaps") this.renderGapsCard(zgrid, gapList, pendingSeals, latePending);
      else if (this.zoom === "timeline") this.renderTimelineCard(zgrid, entries);
      else if (this.zoom === "heat") this.renderHeatmapCard(zgrid, heatWeeks);
      else if (this.zoom === "cands") this.renderCandidatesCard(zgrid, candEntries);
      return;
    }

    this.renderHero(el, cov, sync, heatWeeks, skipped, pendModified, pendUnsealed, latePending.size);

    const grid = el.createDiv({ cls: "nanalstamp-dash-grid3" });
    if (this.plugin.isPro()) {
      this.renderGapsCard(grid, gapList, pendingSeals, latePending);
      this.renderFunnelCard(grid, {
        noteTotal: cov.total,
        covered: cov.covered,
        sealedPending: pendingSeals.size,
        late: latePending.size,
        preSeal: Math.max(0, cov.total - cov.covered - pendingSeals.size),
      }, store, sync.confirmed);
      // 잔디는 내용 폭(12주)에 딱 맞게, 타임라인이 그 줄의 남는 폭 전부 — 여백 없는 한 줄
      const row2 = grid.createDiv({ cls: "nanalstamp-dash-row2 span3" });
      this.renderHeatmapCard(row2, heatWeeks);
      this.renderTimelineCard(row2, entries);
      this.renderCandidatesCard(grid, candEntries);
      if (deleted.length) this.renderDeletedCard(grid, deleted);
      else if (this.lineagePending) this.renderDeletedPendingCard(grid);
    } else {
      // FREE 티저: 히어로(커버리지·KPI)는 그대로 보여주고, 카드 5장 자리는 잠금 + 상태 문장으로 훅.
      // 봉인·검증은 게이트하지 않는다 — 잠기는 건 '보기 좋은 집계'뿐(가격 철학과 일치).
      if (deleted.length) this.renderDeletedCard(grid, deleted);
      else if (this.lineagePending) this.renderDeletedPendingCard(grid);
      const locked = grid.createDiv({ cls: "nanalstamp-card is-locked" });
      locked.createEl("h3", { text: `${t.dashGaps} · ${t.dashTimeline} · ${t.dashCands}` });
      locked.createDiv({ cls: "nanalstamp-dash-warn", text: t.dashLockedGaps(gapList.length) });
      locked.createDiv({ cls: "nanalstamp-dash-mut", text: t.dashLockedDesc });
      const btn = locked.createEl("button", { cls: "mod-cta", text: t.dashBuyPro });
      btn.onclick = () => this.plugin.openExternal("/pricing");
    }
  }

  // 히어로 카드: 링 게이지 + KPI 4개 + 조성(스택) 바. FREE/PRO 공통으로 항상 보인다.
  private renderHero(
    el: HTMLElement,
    cov: ReturnType<typeof coverage>,
    sync: ReturnType<typeof syncStatus>,
    heatWeeks: ReturnType<typeof heatmapCounts>,
    skipped: number,
    pendModified: number,
    pendUnsealed: number,
    lateCount: number,
  ): void {
    const hero = el.createDiv({ cls: "nanalstamp-card nanalstamp-dash-hero" });
    // 보호율 = 봉인 기준(증명 완료 + 확정 대기) — 확정 대기는 파이프라인의 정상 진행이지 사용자의 공백이 아니다.
    // 정상 상태(전부 봉인)면 100%가 보인다(2026-07-22 사용자 지적: 자정 앵커 전 낮은 %는 신뢰를 깎는다).
    // 지연(late)은 보호로 치지 않는다 — SLA 안의 대기만 정상 진행으로 인정.
    const pendingCnt = pendModified + pendUnsealed;
    const coveredPct = cov.total > 0 ? Math.round((cov.covered / cov.total) * 100) : 100;
    const pendingPct = cov.total > 0 ? Math.round((pendingCnt / cov.total) * 100) : 0;
    hero.appendChild(this.buildGauge(coveredPct, pendingPct));

    const right = hero.createDiv({ cls: "nanalstamp-dash-hero-right" });
    const kpis = right.createDiv({ cls: "nanalstamp-dash-kpis" });

    // "확정 대기"(전송됨·미확정)를 수정/미봉인에서 분리해 표시 — 공백 총수와 "모두 봉인" 수가 눈으로 맞아떨어지게.
    const pending = pendModified + pendUnsealed;
    const modLeft = cov.modified - pendModified;
    const unsLeft = cov.unsealed - pendUnsealed;
    const kGap = kpis.createDiv({ cls: "nanalstamp-dash-kpi" });
    const kGapLbl = kGap.createDiv({ cls: "k", text: t.dashKpiAction });
    kGapLbl.createSpan({ cls: "nanalstamp-dash-info", text: " ⓘ" });
    this.tip(kGapLbl, t.dashKpiActionTip);
    // "주의 필요" = 자동으로 해결되지 않는 것만(2026-07-22 재정의 — 조치 없이 줄어드는 수는 조치가 아니다):
    //   확정 지연(SLA 초과) + (초기 백필이 꺼진 경우의) 미봉인. 수정됨·미봉인(백필 켜짐)은 자동 파이프라인 소관.
    const stuckUnsealed = this.plugin.settings.autoBackfill ? 0 : unsLeft;
    const attention = lateCount + stuckUnsealed;
    kGap.createDiv({ cls: `v num${attention > 0 ? " nanalstamp-dash-warn" : ""}`, text: `${attention}` });
    if (lateCount > 0) {
      const lateEl = kGap.createDiv({ cls: "d nanalstamp-dash-warn", text: `${t.dashLatePending} ${lateCount} ⓘ` });
      this.tip(lateEl, t.dashLateTip);
    } else if (stuckUnsealed > 0) {
      kGap.createDiv({ cls: "d", text: `${t.dashKindUnsealed} ${stuckUnsealed}` });
    } else {
      kGap.createDiv({ cls: "d", text: "—" });
    }

    // "자동 진행 중" = 파이프라인이 알아서 처리하는 것(재봉인 예정 + 확정 대기) — 노트 축 통일 유지.
    const autoReseal = modLeft + (this.plugin.settings.autoBackfill ? unsLeft : 0);
    const kPend = kpis.createDiv({ cls: "nanalstamp-dash-kpi" });
    const kPendLbl = kPend.createDiv({ cls: "k", text: t.dashKpiAuto });
    kPendLbl.createSpan({ cls: "nanalstamp-dash-info", text: " ⓘ" });
    this.tip(kPendLbl, `${t.dashPendTip}`);
    kPend.createDiv({ cls: "v num", text: `${autoReseal + pending}` });
    kPend.createDiv({ cls: "d", text: t.dashKpiAutoDesc(autoReseal, pending) });

    const kBlock = kpis.createDiv({ cls: "nanalstamp-dash-kpi" });
    kBlock.createDiv({ cls: "k", text: t.dashKpiLatestBlock });
    kBlock.createDiv({ cls: "v num", text: sync.latestBlock ? `#${sync.latestBlock}` : "—" });

    const flatDays = ([] as (typeof heatWeeks)[number]).concat(...heatWeeks).filter((c) => !c.future);
    const sealedDays = flatDays.filter((c) => c.count > 0).length;
    const kSeal = kpis.createDiv({ cls: "nanalstamp-dash-kpi" });
    kSeal.createDiv({ cls: "k", text: t.dashKpiSealDays });
    kSeal.createDiv({ cls: "v num", text: `${sealedDays}` });
    kSeal.createDiv({ cls: "d", text: t.dashDaysOf(sealedDays, flatDays.length) });

    const comp = right.createDiv({ cls: "nanalstamp-dash-comp" });
    const total = cov.total || 1;
    const c1 = comp.createDiv({ cls: "c1" }); c1.style.width = `${(cov.covered / total) * 100}%`;
    if (pending > 0) { const cp = comp.createDiv({ cls: "cp" }); cp.style.width = `${(pending / total) * 100}%`; }
    const c2 = comp.createDiv({ cls: "c2" }); c2.style.width = `${(modLeft / total) * 100}%`;
    const c3 = comp.createDiv({ cls: "c3" }); c3.style.width = `${(unsLeft / total) * 100}%`;

    const legend = right.createDiv({ cls: "nanalstamp-dash-comp-legend" });
    const addLegend = (color: string, label: string, n: number, tip?: string) => {
      const item = legend.createSpan({ cls: "nanalstamp-dash-legend-item" });
      if (tip) this.tip(item, tip); // 짧은 용어 + 즉시 hover 설명(2026-07-22 원칙)
      const sw = item.createSpan({ cls: "nanalstamp-dash-sw" });
      sw.style.background = color;
      item.createSpan({ text: `${label} ` });
      item.createEl("b", { cls: "num", text: `${n}` });
    };
    addLegend("var(--ns-seal)", t.dashLegendCovered, cov.covered, t.dashLegendCoveredTip);
    if (pending > 0) addLegend("var(--ns-info)", t.dashLegendPending, pending, t.dashLegendPendingTip);
    addLegend("var(--ns-warn)", t.dashLegendModified, modLeft, t.dashLegendModifiedTip);
    addLegend("var(--ns-empty)", t.dashLegendUnsealed, unsLeft, t.dashLegendUnsealedTip);

    if (skipped > 0) right.createDiv({ cls: "nanalstamp-dash-hero-skip", text: t.dashSkipped(skipped) });
  }

  // 그날로: 아카이브에만 남은 노트 — FREE에도 보인다(복원은 전 티어 로컬 기능, PRO 집계가 아니다).
  /// 아직 세는 중 — **비어 있는 것과 구분한다.** 여기서 아무것도 안 그리면 사용자는
  /// "삭제된 노트가 없다"고 읽는데, 사실은 아직 모르는 것이다. 이 제품에서 그 차이는 크다.
  private renderDeletedPendingCard(grid: HTMLElement): void {
    const c = this.card(grid, t.dashDeleted);
    c.createDiv({ cls: "nanalstamp-dash-mut", text: t.dashDeletedScanning });
  }

  private renderDeletedCard(grid: HTMLElement, deleted: RewindEntry[]): void {
    const c = this.card(grid, `${t.dashDeleted} (${deleted.length})`);
    for (const e of deleted.slice(0, DASH_GAP_ROWS)) {
      const r = c.createDiv({ cls: "nanalstamp-dash-gaprow" });
      const name = r.createSpan({ cls: "path", text: e.notePath });
      name.onclick = () => void this.plugin.openArchiveModalFor(e.notePath);
      // 수동 개명 연결 — 자동(이벤트·내용 정확 일치)이 못 잇는 잔재를 사용자가 확정(오인 0 원칙, 2026-07-22 결정).
      const link = r.createEl("button", { text: t.dashLinkBtn });
      this.tip(link, t.dashLinkTip);
      link.onclick = () => new RenameLinkSuggestModal(this.app, this.plugin, e.notePath, () => void this.render()).open();
    }
    if (deleted.length > DASH_GAP_ROWS) {
      const more = c.createEl("button", { text: t.rewindFindCmd });
      more.onclick = () => void this.plugin.findDeletedNotes();
    }
  }

  // 카드 1(span2) — 보호 공백: 수정됨 먼저, 미봉인 다음(gaps()가 이미 그 순서로 정렬).
  // pendingSeals: 봉인 전송은 됐지만 ₿ 확정 전 — "확정 대기"로 표시하고 일괄/개별 봉인 대상에서 제외.
  // "주의 필요" 카드(구 증명 미완 목록) — 자동으로 풀릴 것(확정 대기·백필 예정)은 잡음이라 표시하지 않는다
  // (2026-07-22 사용자 결정: 자정이면 사라질 목록은 의미 없음). KPI '주의 필요'와 동일 정의의 드릴다운.
  private renderGapsCard(grid: HTMLElement, gapList: Gap[], pendingSeals: Set<string>, latePending: Set<string>): void {
    const auto = this.plugin.settings.autoBackfill;
    type Item = { path: string; kind: "late" | "unsealed" | "modified"; mtime?: number };
    const items: Item[] = [];
    for (const p2 of latePending) items.push({ path: p2, kind: "late" });
    if (!auto) {
      for (const g of gapList) {
        if (pendingSeals.has(g.path)) continue;
        items.push({ path: g.path, kind: g.kind, mtime: g.mtime });
      }
    }
    const c = this.card(grid, `${t.dashKpiAction} (${items.length})`, this.zoom === "gaps" ? undefined : "span2", "gaps");
    const autoCount = gapList.length + latePending.size - items.length;
    if (items.length === 0) {
      c.createDiv({ cls: "nanalstamp-dash-mut", text: t.dashAttnEmpty });
      if (autoCount > 0) c.createDiv({ cls: "nanalstamp-dash-mut", text: t.dashAttnAuto(autoCount) });
      return;
    }
    if (autoCount > 0) c.createDiv({ cls: "nanalstamp-dash-mut", text: t.dashAttnAuto(autoCount) });
    const now = Date.now();
    const rowCap = this.zoom === "gaps" ? 100 : DASH_GAP_ROWS;
    for (const it of items.slice(0, rowCap)) {
      const r = c.createDiv({ cls: "nanalstamp-dash-gaprow" });
      r.createDiv({ cls: "nanalstamp-dash-stripe warn" });
      const name = r.createSpan({ cls: "path", text: it.path });
      name.onclick = () => {
        const f = this.plugin.app.vault.getAbstractFileByPath(it.path);
        if (f instanceof TFile) void this.plugin.app.workspace.getLeaf(false).openFile(f);
      };
      if (it.kind === "late") {
        const chip = r.createSpan({ cls: "nanalstamp-dash-chip warn", text: t.dashLatePending });
        this.tip(chip, t.dashLateTip);
        const btn = r.createEl("button", { text: t.anchorCmd });
        btn.onclick = () => { btn.disabled = true; void this.plugin.anchorNow().then(() => void this.render()); };
        continue;
      }
      const chip = r.createSpan({ cls: `nanalstamp-dash-chip ${it.kind === "modified" ? "warn" : "gray"}` });
      if (it.kind === "modified" && it.mtime) {
        const hrs = (now - it.mtime) / 3_600_000;
        chip.setText(hrs < 24 ? t.dashAgoHours(Math.max(1, Math.round(hrs))) : t.dashAgoDays(Math.round(hrs / 24)));
      } else {
        chip.setText(t.dashKindUnsealed);
      }
      const btn = r.createEl("button", { text: t.dashSealNow });
      btn.onclick = () => {
        // 선검사를 두지 않는다 — 미로그인·꺼짐·범위 밖 판정과 안내는 flush 의 manual 게이트가
        // 한 곳에서 한다(리본·명령·이 버튼이 같게 행동해야 한다). 여기서 또 검사하면 진입점마다
        // 문구와 다음 행동이 갈린다.
        const f = this.plugin.app.vault.getAbstractFileByPath(it.path);
        if (f instanceof TFile) {
          btn.disabled = true;
          void this.plugin.flush(f, "manual").then(() => void this.render());
        }
      };
    }
    if (items.length > rowCap) {
      c.createDiv({ cls: "nanalstamp-dash-mut", text: t.dashMore(items.length - rowCap) });
    }
  }

  // 카드 2 — 앵커 파이프라인: ₿ 확정 → 로컬 아카이브 → GitHub 미러.
  // 합계식 원칙(2026-07-22): 상태 숫자는 "분모가 보이는 완전 분할"로만 — 각 섹션 행의 합 = 머리글 분모.
  // 평생 카운터(누적 증명)는 상태 분할과 섞이면 반드시 헷갈리므로 하단 통계 줄로 격리.
  private renderFunnelCard(
    grid: HTMLElement,
    anchor: { noteTotal: number; covered: number; sealedPending: number; late: number; preSeal: number },
    store: { total: number; noteCnt: number; attCnt: number; archPend: string[]; mirPend: string[]; nanPend: string[]; nanDone: number; nanExcl: number },
    lifetime: number,
  ): void {
    const c = this.card(grid, t.dashSync, "nanalstamp-dash-funnel");
    const archiveOn = this.plugin.dashboardArchiveOn();
    const mirrorOn = this.plugin.mirrorActive();
    const nanalOn = this.plugin.nanalActive();
    const sec = (label: string, tip?: string) => {
      const h = c.createDiv({ cls: "fsec", text: label });
      if (tip) this.tip(h, tip);
    };
    // 행: 라벨 | 값(분수 표기 가능) | 우측 슬롯(대기 칩·부가). 대기 칩 클릭 → 목록 모달.
    const row = (label: string, done: number, denom: number | null, tip?: string, pendList?: string[], axis?: string, extra?: string) => {
      const fr = c.createDiv({ cls: "frow" });
      const lk = fr.createSpan({ cls: "fk", text: label });
      if (tip) this.tip(lk, tip);
      const fv = fr.createSpan({ cls: "fv num" });
      fv.createSpan({ text: `${done}` });
      if (denom != null) fv.createSpan({ cls: "fden", text: ` / ${denom}` });
      const slot = fr.createSpan({ cls: "fpend num" });
      if (pendList && pendList.length > 0) {
        const chip = slot.createSpan({ cls: "warn", text: t.dashPendShort(pendList.length) });
        chip.addClass("is-clickable");
        this.tip(chip, t.dashPendTip);
        chip.onclick = () => new StoragePendingModal(this.app, this.plugin, axis ?? label, pendList).open();
      }
      if (extra) slot.createSpan({ cls: "fextra", text: (pendList && pendList.length ? " · " : "") + extra });
    };

    // ── ₿ 앵커링: 노트 분할(완료 + 확정 대기 + 봉인 전 = 분모) — 히어로와 동일 숫자
    sec(t.dashSecAnchor(anchor.noteTotal), t.dashSecAnchorTip);
    row(t.dashLegendCovered, anchor.covered, null, t.dashLegendCoveredTip);
    {
      // 확정 대기(지연 포함 주석) — 클릭=지금 앵커(머클이 전량 커버, 개별 재시도 개념 없음)
      const fr = c.createDiv({ cls: "frow" });
      const lk = fr.createSpan({ cls: "fk", text: t.dashLegendPending });
      if (anchor.sealedPending > 0) lk.addClass("is-click");
      this.tip(lk, `${t.dashPendTip}\n${t.anchorRowClickTip}`);
      lk.onclick = () => { if (anchor.sealedPending > 0) void this.plugin.anchorNow(); };
      fr.createSpan({ cls: "fv num", text: `${anchor.sealedPending}` });
      const slot = fr.createSpan({ cls: "fpend num" });
      if (anchor.late > 0) {
        const lateEl = slot.createSpan({ cls: "warn", text: `${t.dashLatePending} ${anchor.late}` });
        this.tip(lateEl, t.dashLateTip);
      }
    }
    if (anchor.preSeal > 0) row(t.dashPreSeal, anchor.preSeal, null, t.dashPreSealTip);

    // ── 보관 동기화: 봉인본 분할(완료/분모 + 대기 [+ 대상 아님] = 분모)
    sec(t.dashSecStorage(store.total), t.dashSecStorageTip(store.noteCnt, store.attCnt));
    if (archiveOn) row(t.dashFunnelArchive, store.total - store.archPend.length, store.total, t.dashFunnelArchiveTip, store.archPend, t.dashFunnelArchive);
    else c.createDiv({ cls: "nanalstamp-dash-mut", text: t.dashNoArchive });
    if (mirrorOn) row(t.dashFunnelMirror, store.total - store.mirPend.length, store.total, undefined, store.mirPend, t.dashFunnelMirror);
    if (nanalOn) {
      row(t.dashFunnelNanal, store.nanDone, store.total, t.dashFunnelNanalTip, store.nanPend, "nanalStorage",
          store.nanExcl > 0 ? t.dashExclShort(store.nanExcl) : undefined);
    }

    // ── 평생 카운터(상태 아님) — 분할과 섞지 않는다
    const life = c.createDiv({ cls: "flife" });
    life.setText(t.dashLifetime(lifetime));
    this.tip(life, t.dashKpiConfirmedTip);
  }

  // 카드 3 — 폴더별 증명 시작일: "이 폴더 기록은 이날부터 비트코인으로 증명된다"를 리스트로.
  // (구 스팬 바는 사용 초기(짧은 기간)에 축이 붕괴해 읽히지 않았다 — 2026-07-22 사용자 지적으로 교체.)
  private renderTimelineCard(grid: HTMLElement, entries: ArchiveEntry[]): void {
    const c = this.card(grid, t.dashTimeline, undefined, "timeline");
    if (!this.plugin.dashboardArchiveOn()) { c.createDiv({ cls: "nanalstamp-dash-mut", text: t.dashNoArchive }); return; }
    if (!entries.length) { c.createDiv({ cls: "nanalstamp-dash-mut", text: t.dashEmpty }); return; }
    const all = timeline(entries);
    const rows = all.slice(0, this.zoom === "timeline" ? 24 : DASH_TL_ROWS);
    const tl = c.createDiv({ cls: "nanalstamp-dash-tl-list" });
    for (const row of rows) {
      const item = tl.createDiv({ cls: "row" });
      item.createSpan({ cls: "name", text: row.folder });
      item.createSpan({ cls: "since num", text: row.firstTs > 0 ? t.dashTlSince(fmtDate(new Date(row.firstTs)), row.firstBlock) : "—" });
      item.createSpan({ cls: "cnt num", text: t.dashTlCount(row.count) });
    }
    // 잘린 폴더 안내 — 보호 공백 카드의 "외 N건" 관례와 동일(확대 유도)
    if (all.length > rows.length) c.createDiv({ cls: "nanalstamp-dash-mut", text: t.dashMore(all.length - rows.length) });
  }

  // 카드 4 — 봉인 연속성 히트맵(이진: 그날 봉인 있었나), 좌측 요일 레일.
  // GitHub 잔디 스타일: 열=달력 주, 상단 월 라벨, 좌측 월/수/금 라벨, 5단계 농도 + 범례.
  private renderHeatmapCard(grid: HTMLElement, heatWeeks: ReturnType<typeof heatmapCounts>): void {
    const c = this.card(grid, t.dashHeatmap, this.zoom === "heat" ? undefined : "span2", "heat");
    const totalSeals = ([] as (typeof heatWeeks)[number]).concat(...heatWeeks).reduce((a, x) => a + x.count, 0);
    const recentSeals = ([] as (typeof heatWeeks)[number]).concat(...heatWeeks.slice(-12)).reduce((a, x) => a + x.count, 0);
    const sub = c.createDiv({ cls: "nanalstamp-dash-mut" });
    sub.setText(t.dashHeatTotal(totalSeals, recentSeals));
    if (heatWeeks.length > 12 && this.zoom !== "heat") sub.setText(`${t.dashHeatTotal(totalSeals, recentSeals)} · ${t.dashHeatDragHint}`);
    const wrap = c.createDiv({ cls: "nanalstamp-dash-heat-wrap" });
    const days = wrap.createDiv({ cls: "nanalstamp-dash-heat-days" });
    // 행 0/2/4(월·수·금)에만 라벨 — GitHub 방식
    for (let r = 0; r < 7; r++) days.createSpan({ text: r === 0 ? t.dashWeekdays[0] : r === 2 ? t.dashWeekdays[1] : r === 4 ? t.dashWeekdays[2] : "" });
    const right = wrap.createDiv({ cls: "nanalstamp-dash-heat-right" });
    // 드래그 팬 — 4px 이상 움직였을 때만(셀 hover·클릭과 충돌 방지). 트랙패드·터치는 네이티브 스크롤.
    let panStartX = 0, panStartScroll = 0, panning = false, panArmed = false;
    right.addEventListener("mousedown", (ev) => { panArmed = true; panning = false; panStartX = ev.clientX; panStartScroll = right.scrollLeft; });
    right.addEventListener("mousemove", (ev) => {
      if (!panArmed) return;
      const dx = ev.clientX - panStartX;
      if (!panning && Math.abs(dx) < 4) return;
      panning = true;
      right.scrollLeft = panStartScroll - dx;
      ev.preventDefault();
    });
    const endPan = () => { panArmed = false; panning = false; };
    right.addEventListener("mouseup", endPan);
    right.addEventListener("mouseleave", endPan); // 카드 밖으로 나가면 팬 종료 — window 리스너 누적(재렌더 누수) 회피
    const months = right.createDiv({ cls: "nanalstamp-dash-heat-months" });
    let prevMonth = "";
    for (const week of heatWeeks) {
      const m = week[0].date.slice(5, 7);
      const slot = months.createSpan();
      if (m !== prevMonth) { slot.setText(t.dashMonthLbl(parseInt(m, 10))); prevMonth = m; }
    }
    const heat = right.createDiv({ cls: "nanalstamp-dash-heat" });
    for (const week of heatWeeks) {
      const col = heat.createDiv({ cls: "wk" });
      for (const cell of week) {
        const d = col.createDiv({ cls: `cell l${cell.level}` + (cell.future ? " is-future" : "") });
        if (!cell.future) d.setAttr("data-tip", t.dashHeatCellTip(cell.date, cell.count));
      }
    }
    // 셀 툴팁은 자체 즉시 툴팁(0ms) — 네이티브 title은 OS 지연이 있다(2026-07-22 사용자 지적).
    // 셀이 수백~수천 개라 개별 리스너 대신 컨테이너 위임 1쌍으로 처리한다.
    heat.addEventListener("mouseover", (ev) => {
      const cellEl = (ev.target as HTMLElement).closest?.<HTMLElement>(".cell[data-tip]");
      if (cellEl) this.showTipAt(cellEl, cellEl.getAttr("data-tip") ?? "");
      else this.hideTip();
    });
    heat.addEventListener("mouseleave", () => this.hideTip());
    const legend = c.createDiv({ cls: "nanalstamp-dash-heat-legend" });
    legend.createSpan({ cls: "nanalstamp-dash-mut", text: t.dashHeatLess });
    for (let l = 0; l <= 4; l++) legend.createDiv({ cls: `cell l${l}` });
    legend.createSpan({ cls: "nanalstamp-dash-mut", text: t.dashHeatMore });
    // 초기 위치 = 오른쪽 끝(최신) — 레이아웃 측정 후
    window.requestAnimationFrame(() => { right.scrollLeft = right.scrollWidth; });
  }

  // 카드 5 — 증명서 후보(봉인 이력이 깊은 노트 → P6 버전 모달). 미니바는 최대 8칸.
  private renderCandidatesCard(grid: HTMLElement, entries: ArchiveEntry[]): void {
    const c = this.card(grid, t.dashCands, "nanalstamp-dash-cand span3", "cands");
    if (!this.plugin.dashboardArchiveOn()) { c.createDiv({ cls: "nanalstamp-dash-mut", text: t.dashNoArchive }); return; }
    const cands = certCandidates(entries, this.zoom === "cands" ? 20 : 5);
    if (!cands.length) { c.createDiv({ cls: "nanalstamp-dash-mut", text: t.dashEmpty }); return; }
    for (const cand of cands) {
      // 파일명을 앞세우고(경로는 툴팁·보조줄) 이력 요약을 곁들인다 — 긴 폴더 경로가 전부 같아 보이는 문제 방지.
      const base = cand.notePath.split("/").pop() ?? cand.notePath;
      const slash = cand.notePath.lastIndexOf("/");
      const folder = slash === -1 ? "(root)" : cand.notePath.slice(0, slash);
      const nm = c.createDiv({ cls: "nm" });
      nm.setAttr("title", cand.notePath);
      nm.createDiv({ text: base });
      nm.createDiv({ cls: "nanalstamp-dash-mut", text: `${folder} · ${t.dashCandDesc(cand.versions, cand.spanDays, cand.firstBlock)}` });
      const depth = c.createDiv({ cls: "depth" });
      const filled = Math.min(cand.versions, 8);
      for (let i = 0; i < 8; i++) {
        const dot = depth.createDiv();
        dot.setAttr("title", t.dashCandDesc(cand.versions, cand.spanDays, cand.firstBlock));
        if (i >= filled) dot.addClass("e");
      }
      const btn = c.createEl("button", { text: t.dashOpenVersions });
      btn.onclick = () => {
        const f = this.plugin.app.vault.getAbstractFileByPath(cand.notePath);
        if (f instanceof TFile) void this.plugin.openArchiveModalFor(f.path);
      };
    }
  }
}

// ── 업무 요청함 패널(§7b Work Inbox) ────────────────────────────────────────
// 전용 우측 사이드바 ItemView — 확정 목업 docs/design/request-inbox-panel-mockup.html:
// 탭(받은/보낸/내 업무) + 섹션(접수 대기 → 진행 중(마감 초과 상단) → 완료(접힘·지연 로드)).
// 서버 계약: routes/team_tasks.rs (GET /attest/team/tasks?view=…, POST 전이, replies, roster).
// 원칙: 사용자 입력은 전부 createEl/setText(DOM API) — innerHTML 금지. API 실패는 조용한
// 상태 문구 + 재시도 버튼(봉인 플로우 영향 0).

export class TaskInboxView extends ItemView {
  private plugin: NanalStampPlugin;
  private inbox: TaskItem[] = [];
  private mine: TaskItem[] = [];
  // §Task 7: 완료(done) 지연 로드 캐시 — hideDone=false일 때만 조회·병합(Task 6 회귀 복구). null=미조회.
  private doneInbox: TaskItem[] | null = null;
  private doneMine: TaskItem[] | null = null;
  private doneLoading = false;
  private loading = false;
  private loadFailed = false;
  private expanded = new Set<string>();               // 회신 스레드 펼친 카드 id
  private replies = new Map<string, TaskReply[]>();   // 카드별 회신 캐시 — 새로고침 시 무효
  private refreshGen = 0; // 구 세대 응답 폐기(NoteBrowserView 경합 수정 관례)
  private lastWide: boolean | null = null;            // 리프 위치(중앙/사이드) 교차 감지 — 바뀔 때만 재렌더(카드↔표)

  constructor(leaf: WorkspaceLeaf, plugin: NanalStampPlugin) {
    super(leaf);
    this.plugin = plugin;
  }
  getViewType(): string { return TASK_INBOX_VIEW_TYPE; }
  getDisplayText(): string { return t.taskInboxTitle; }
  getIcon(): string { return "inbox"; }

  async onOpen(): Promise<void> {
    await this.refresh(true);
  }
  async onClose(): Promise<void> {
    closePopover(); // 필터 팝오버 열린 채 leaf 닫힘 시 document capture 리스너(mousedown/keydown) 잔존 방지
    this.contentEl.empty();
  }
  // 사용자가 리프를 사이드바↔중앙으로 드래그 이동하면 Obsidian이 onResize를 부른다 — 위치가 바뀌어
  // wide 판정이 뒤집힌 경우에만 재렌더(카드↔표 전환). 폭 변화만으론 재렌더하지 않는다(§1: 폭 무관).
  onResize(): void {
    const w = this.isWide();
    if (this.lastWide !== null && w !== this.lastWide) this.render();
  }

  // 넓은 화면 = 리프가 중앙 편집 영역(rootSplit) 소속 && 데스크톱. 사이드 도크(좌/우)면 항상 카드,
  // 모바일이면 폭이 좁아 항상 카드. 폭(720)이 아니라 리프 위치로 판정(§1) — 중앙 탭은 좁아져도 표 유지.
  // openTaskInboxWide/Narrow가 detach+새 leaf라 render마다 getRoot()로 재판정하면 위치 변화가 즉시 반영된다.
  private isWide(): boolean { return this.leaf.getRoot() === this.app.workspace.rootSplit && !Platform.isMobile; }

  // 목록 재조회 + 렌더. reload=true면 회신 캐시도 버린다(패널 열기·수동 ↻·카드 액션 후).
  async refresh(reload = false): Promise<void> {
    const gen = ++this.refreshGen;
    this.doneInbox = null; this.doneMine = null; // §Task 7: refresh마다 완료 캐시 무효 — 재조회는 renderInner가 hideDone=false일 때 트리거
    if (reload) { this.replies.clear(); void this.plugin.refreshProjects(); } // §3: 수동 ↻·패널 열기 = 과제 목록도 갱신
    this.loading = true;
    this.render();
    const r = await this.plugin.pollTasks(true);
    if (gen !== this.refreshGen) return;
    this.loading = false;
    if (!r) {
      // 미소속(404)·미로그인·꺼짐은 render()가 각자 상태 문구로 안내 — 오류 표시는 그 외(네트워크 등)만.
      this.loadFailed = !this.plugin.taskNotMember && this.plugin.taskInboxOn();
      this.render();
      return;
    }
    this.loadFailed = false;
    this.inbox = r.inbox;
    this.mine = r.mine;
    this.render();
  }

  private today(): string { return fmtDate(new Date()); }

  // 폴링(5분 인터벌)·SSE(changed) 경유 새 데이터 수신 — 열려 있는 패널을 스스로 갱신한다
  // (수동 ↻ 없이는 안 바뀌던 버그 수정, 2026-07-23). 렌더 영향 필드가 그대로면 재렌더하지
  // 않고(입력·스크롤 보존), 바뀌면 회신 초안을 보존하며 재렌더한다.
  applyData(inbox: TaskItem[], mine: TaskItem[]): void {
    if (this.loading) return; // 진행 중인 refresh가 곧 최신본을 그린다(이중 렌더 방지)
    const changed = tasksRenderKey(inbox) + "|" + tasksRenderKey(mine)
      !== tasksRenderKey(this.inbox) + "|" + tasksRenderKey(this.mine);
    this.inbox = inbox;
    this.mine = mine;
    this.loadFailed = false;
    if (!changed) return;
    // 펼쳐둔 스레드의 회신이 늘었으면 캐시 무효 + 재조회(완료 시 스스로 재렌더).
    const all = unionTasks(inbox, mine);
    for (const id of this.expanded) {
      const now = all.find((x) => x.id === id);
      const cached = this.replies.get(id);
      if (now && cached && now.replyCount > cached.length) {
        this.replies.delete(id);
        void this.loadReplies(id);
      }
    }
    this.render();
  }

  /// 읽음 보고 직후 재렌더(reportTaskRead가 부른다) — 패널이 둘 이상(사이드바+중앙)이면
  /// 클릭한 쪽만 다시 그려져 다른 패널의 안읽음 점이 다음 폴링(5분)까지 남는다(2026-08-06 실사용 보고).
  /// applyData의 renderKey 비교는 같은 배열을 제자리에서 고친 경우를 감지하지 못해 별도 진입점이 필요하다.
  rerenderAfterRead(): void { this.render(); }

  private render(): void {
    const c = this.contentEl;
    // 재렌더 전에 회신 입력 초안(값·포커스·캐럿)을 걷어 두고 렌더 후 복원 — 자동 갱신이
    // 사용자가 쓰던 회신을 지우지 않게(§ 자동 재렌더 입력 보호).
    const drafts = new Map<string, { value: string; focused: boolean; selStart: number; selEnd: number }>();
    c.querySelectorAll<HTMLTextAreaElement>("textarea.nanalstamp-task-reply-input").forEach((el) => {
      const id = el.dataset.taskId;
      if (!id) return;
      if (el.value || document.activeElement === el) {
        drafts.set(id, {
          value: el.value, focused: document.activeElement === el,
          selStart: el.selectionStart ?? el.value.length, selEnd: el.selectionEnd ?? el.value.length,
        });
      }
    });
    try {
      this.renderInner(c);
    } finally {
      if (drafts.size) {
        c.querySelectorAll<HTMLTextAreaElement>("textarea.nanalstamp-task-reply-input").forEach((el) => {
          const d = el.dataset.taskId ? drafts.get(el.dataset.taskId) : undefined;
          if (!d) return;
          el.value = d.value;
          if (d.focused) {
            el.focus();
            try { el.setSelectionRange(d.selStart, d.selEnd); } catch { /* 무시 */ }
          }
        });
      }
    }
  }

  // 현재 사용자 uid 파생(§Task 9 보드 드래그 전이 권한용). 플러그인은 uid를 따로 보관하지 않으므로
  // 서버 필터 계약에서 역산한다: inbox=assignee_uid=uid, mine=creator_uid=uid(team_tasks.rs). 따라서
  // 어떤 inbox 업무의 assigneeUid 또는 어떤 mine 업무의 creatorUid가 곧 내 uid다(완료 캐시 포함).
  // 둘 다 비면 ""(빈 문자열) — dragTargetsFor가 taskType으로 근사한다.
  private taskSelfUid(): string {
    for (const t of this.inbox) if (t.assigneeUid) return t.assigneeUid;
    if (this.doneInbox) for (const t of this.doneInbox) if (t.assigneeUid) return t.assigneeUid;
    for (const t of this.mine) if (t.creatorUid) return t.creatorUid;
    if (this.doneMine) for (const t of this.doneMine) if (t.creatorUid) return t.creatorUid;
    return "";
  }

  // 얇은 셸 — 전제/로딩 상태만 여기서 처리하고, 정상 경로는 unifyTasks로 통합해 renderWorkInbox에 위임.
  // (3탭·partitionMine 분기 폐지 → 단일 통합 목록 + 유형 컬럼. 리프 위치 기준 카드↔표: 중앙=표, 사이드=카드.)
  private renderInner(c: HTMLElement): void {
    c.empty();
    c.addClass("nanalstamp-task-panel");
    const s = this.plugin.settings;

    // 전제 미충족·로딩 — 최소 헤더(제목) + 조용한 문구(봉인 플로우와 무관).
    const guard = (msg: string, retry = false): void => {
      const head = c.createDiv({ cls: "nanalstamp-task-head" });
      head.createSpan({ text: "📥" });
      head.createSpan({ cls: "nanalstamp-task-head-title", text: t.taskInboxTitle });
      c.createEl("p", { cls: "nanalstamp-task-state", text: msg });
      if (retry) c.createEl("button", { text: t.taskRetry }).addEventListener("click", () => void this.refresh(true));
    };
    if (!s.taskInboxEnabled) return guard(t.taskDisabled);
    if (!s.apiKey) return guard(t.apiKeyMissing);
    if (this.plugin.taskNotMember) return guard(t.taskNotMember, true);
    if (this.loadFailed) return guard(t.taskLoadFail, true);
    if (this.loading) return guard("…");

    // ── 정상 경로: 통합 목록을 renderWorkInbox에 위임 ──
    const today = this.today();
    // §Task 7 완료 로딩 복구: hideDone=false면 done도 병합(캐시 미조회면 loadDone 지연 트리거). hideDone=true면 open만.
    const showDone = !this.plugin.settings.taskViewPrefs.hideDone;
    let inboxAll = this.inbox, mineAll = this.mine;
    if (showDone) {
      if (this.doneInbox === null && !this.doneLoading) void this.loadDone();
      if (this.doneInbox) inboxAll = [...this.inbox, ...this.doneInbox];
      if (this.doneMine) mineAll = [...this.mine, ...this.doneMine];
    }
    const unified = unifyTasks(inboxAll, mineAll);
    const wide = this.isWide();
    this.lastWide = wide;

    // 부가 헤더 버튼(전제 충족 시): 통합 "폴더 만들기"(팀 표준 + 참여 과제 폴더 목록·상태·체크 생성, §3, 2026-07-25).
    // short=좁은 사이드바에서 아이콘 아래 짧은 캡션.
    // 이 조건은 "루트 설정 여부"가 아니라 "보여줄 가능성이 있는가"다(2026-07-25 루트 필수 재검토) —
    // settings.teamStructure는 parseTeamStructure가 root 없으면 null → "" 저장이므로 값이 있다는 것
    // 자체가 root 유효를 함의한다. kitProjects()만 있고 root가 아직 안 왔다면(수신 지연 등) 버튼은
    // 뜨지만 모달의 buildRows()가 teamRoot()===null로 빈 목록 + folderCreateNoRoot 안내를 띄운다 —
    // 숨기지 않고 안내하는 쪽이 발견성에 낫다(§4d). 조건 자체는 바꿀 필요 없음.
    const headerExtras: Array<{ label: string; short: string; onClick: () => void }> = [];
    if (this.plugin.settings.teamStructure || this.plugin.kitProjects().length)
      headerExtras.push({ label: t.folderCreateBtn, short: t.folderCreateShort, onClick: () => new FolderCreateModal(this.app, this.plugin).open() });
    // §Task 11: 넓게↔좁게 상호 토글(데스크톱). 좁은 사이드바 → "넓게 보기"(중앙 탭), 넓은 중앙 → "좁게 보기"(사이드바).
    if (!Platform.isMobile) {
      if (!wide) headerExtras.push({ label: t.taskWideBtn, short: t.taskWideShort, onClick: () => void this.plugin.openTaskInboxWide() });
      else headerExtras.push({ label: t.taskNarrowBtn, short: t.taskNarrowShort, onClick: () => void this.plugin.openTaskInboxNarrow() });
    }

    renderWorkInbox({
      app: this.app,
      host: c,
      unified,
      myUid: this.taskSelfUid(),
      today,
      wide,
      prefs: this.plugin.settings.taskViewPrefs,
      L: t,
      onPrefsChange: () => { void this.plugin.saveSettings(); this.render(); },
      savePrefs: () => { void this.plugin.saveSettings(); },
      invalidateDone: () => { this.doneInbox = null; this.doneMine = null; },
      actions: this.buildActions(),
      headerExtras,
      renderCards: (host, list) => this.renderCards(host, list, today),
    });

    // 푸터: 마지막 동기화 + ↻ (패널 flex 컬럼 하단 — renderWorkInbox가 채운 본문 뒤에 append).
    const foot = c.createDiv({ cls: "nanalstamp-task-foot" });
    const at = this.plugin.taskLastSyncAt;
    foot.createSpan({ text: at ? t.taskSyncAt(`${pad2(new Date(at).getHours())}:${pad2(new Date(at).getMinutes())}`) : "" });
    const rf = foot.createEl("a", { text: t.taskRefresh, href: "#" });
    rf.addEventListener("click", (e) => { e.preventDefault(); void this.refresh(true); });
  }

  // §Task 7: 완료(done) 지연 로드 — inbox·mine의 done을 병렬 조회해 캐시(open과 병합해 통합 목록에 노출).
  // 부분 성공(한쪽 실패=빈 배열)도 open 표시를 막지 않는다. 구 세대(그 사이 refresh) 결과는 폐기.
  private async loadDone(): Promise<void> {
    if (this.doneLoading) return;
    this.doneLoading = true;
    const gen = this.refreshGen;
    try {
      const [di, dm] = await Promise.all([
        this.plugin.fetchTasks("inbox", "done"),
        this.plugin.fetchTasks("mine", "done"),
      ]);
      if (gen === this.refreshGen) { this.doneInbox = di ?? []; this.doneMine = dm ?? []; }
    } finally {
      this.doneLoading = false;
      // 항상 재렌더 — 정상: 완료 병합 표시. 폐기(구 세대): doneInbox null 유지 → 새 렌더가 loadDone 재트리거(자가 치유).
      this.render();
    }
  }

  // 좁은 화면·모바일 카드 렌더 — 통합 목록(visible)을 유형 배지 포함 단일 흐름으로. 정렬·필터·완료숨김은
  // taskview.paint()가 이미 반영한 visible을 넘겨받는다(표와 동일 파이프라인 공유, §Task 10).
  private renderCards(host: HTMLElement, list: UnifiedTask[], today: string): void {
    for (const task of list) this.renderCard(host, task, today);
  }

  // 유형별 액션 콜백(모달·API 소유) — 각 액션 후 재조회. renderWorkInbox·표·카드가 공유.
  private buildActions(): WorkInboxActions {
    const openDone = (task: TaskItem, recall: boolean) =>
      new TaskDoneModal(this.app, this.plugin, task, recall, () => void this.refresh(true)).open();
    return {
      accept: (task) => {
        void this.plugin.taskPost(`/attest/team/tasks/${encodeURIComponent(task.id)}/accept`)
          .then((r) => { if (r) void this.refresh(true); });
      },
      decline: (task) => new TaskDeclineModal(this.app, this.plugin, task, () => void this.refresh(true)).open(),
      // 제목 클릭 — 표·컴팩트가 공유한다. 연결 노트 열기는 상세 안 버튼으로 넘겼다.
      openDetail: (task) => {
        // 상세를 여는 것 = 읽음(읽음 배지). 모달보다 먼저 보고해 목록의 빨간 점을 즉시 끈다.
        this.plugin.reportTaskRead(task);
        this.render();
        new TaskDetailModal(
          this.app, this.plugin, task, this.taskSelfUid(),
          (path) => { void this.app.workspace.openLinkText(path, "", false); },
          // 상세에서 바로 고칠 수 있게 — 표로 되돌아가 다시 찾게 하지 않는다.
          (tk) => new TaskEditModal(this.app, this.plugin, tk, () => void this.refresh(true)).open(),
        ).open();
      },
      edit: (task) => new TaskEditModal(this.app, this.plugin, task, () => void this.refresh(true)).open(),
      markDone: (task, recall) => openDone(task, recall),
      request: (task) => new TaskRequestModal(this.app, this.plugin, task, () => void this.refresh(true)).open(),
      cancel: (task) => {
        void this.plugin.taskPost(`/attest/team/tasks/${encodeURIComponent(task.id)}/cancel`)
          .then((r) => { if (r) void this.refresh(true); });
      },
      reopen: (task) => new TaskReopenModal(this.app, this.plugin, task, () => void this.refresh(true)).open(),
      openNote: (path) => { void this.app.workspace.openLinkText(path, "", false); },
      compose: () => new TaskComposeModal(this.app, this.plugin, () => void this.refresh(true)).open(),
      toggleThread: (task) => this.toggleExpand(task),
    };
  }

  // 유형 배지 라벨(받음/보냄/개인) — 표·보드와 동일 문구.
  private typeBadgeText(tt: TaskType): string {
    return tt === "received" ? t.taskTypeReceived : tt === "sent" ? t.taskTypeSent : t.taskTypePersonal;
  }

  // 요청 카드 — 목업 .req: 제목 / 메타(유형 배지·상대·마감·우선순위·상태) / 액션 / (펼침) 본문·회신 스레드.
  private renderCard(parent: HTMLElement, task: UnifiedTask, today: string): void {
    const overdue = isOverdue(task, today);
    const card = parent.createDiv({ cls: "nanalstamp-task-card" + (overdue ? " is-overdue" : "") });

    const titleEl = card.createDiv({ cls: "nanalstamp-task-title", text: task.title });
    // 안읽음 빨간 점(읽음 배지) — 네 렌더러(카드·표·컴팩트·보드)가 같은 판정(isUnread)을 쓴다.
    if (isUnread(task)) titleEl.prepend(titleEl.createSpan({ cls: "nanalstamp-unread-dot", attr: { "aria-label": t.taskUnread } }));
    // §3: 연결된 연구과제 — 제목 옆 회색 작은 태그(기존 pill 문법)
    if (task.projectName) titleEl.createSpan({ cls: "nanalstamp-task-proj", text: task.projectName });
    titleEl.addEventListener("click", () => this.toggleExpand(task));

    const meta = card.createDiv({ cls: "nanalstamp-task-meta" });
    // 유형 배지(§Task 10) — 표·보드와 동일 pill(받음=accent·보냄=amber·개인=muted, 테마 변수).
    meta.createSpan({ cls: "nanalstamp-tv-type is-" + task.taskType, text: this.typeBadgeText(task.taskType) });
    // 상대방: 받은 요청 = 요청자 →, 보낸 요청 = → 수신자, 내 업무 = 없음.
    // 별칭 우선 표시(없으면 이메일 전체) + 툴팁(title)에 이메일 — 별칭 중복 시 구분자.
    if (task.taskType === "received" && task.creatorEmail) {
      const sp = meta.createSpan({ text: t.taskFromWhom(personDisplay(task.creatorName, task.creatorEmail)) });
      sp.title = task.creatorEmail;
    }
    if (task.taskType === "sent" && task.assigneeEmail) {
      const sp = meta.createSpan({ text: t.taskToWhom(personDisplay(task.assigneeName, task.assigneeEmail)) });
      sp.title = task.assigneeEmail;
    }
    // 마감 라벨(초과=빨강·오늘=노랑)
    const due = this.dueLabel(task, today);
    meta.createSpan({ cls: `nanalstamp-task-due ${due.cls}`, text: due.text });
    // 우선순위 pill
    meta.createSpan({ cls: `nanalstamp-task-pill is-${task.priority}`, text: t.taskPriLabel[task.priority] ?? task.priority });
    // 상태 pill(보낸 요청·완료 목록에서 의미 — 접수 착시 제거)
    const st = this.statusPill(task);
    if (st) meta.createSpan({ cls: `nanalstamp-task-st ${st.cls}`, text: st.text });
    // 회신 수(펼침 어포던스)
    if (task.replyCount > 0) {
      const rc = meta.createSpan({ cls: "nanalstamp-task-replies", text: t.taskReplies(task.replyCount) });
      rc.addEventListener("click", () => this.toggleExpand(task));
    }
    if (task.declineReason) card.createDiv({ cls: "nanalstamp-task-declined", text: t.taskDeclinedLine(task.declineReason) });
    if (task.linkedNotePath) card.createDiv({ cls: "nanalstamp-task-note", text: `📄 ${task.linkedNotePath}` });

    this.renderActions(card, task);
    if (this.expanded.has(task.id)) this.renderThread(card, task);
  }

  private statusPill(task: TaskItem): { text: string; cls: string } | null {
    switch (task.status) {
      case "requested": return { text: t.taskStWait, cls: "is-wait" };
      case "accepted": return { text: t.taskStAcc, cls: "is-acc" };
      case "declined": return { text: t.taskStDeclined, cls: "is-declined" };
      case "done": return { text: t.taskStDone, cls: "is-done" };
      default: return null; // personal — 탭 자체가 라벨
    }
  }

  private dueLabel(task: TaskItem, today: string): { text: string; cls: string } {
    if (task.status === "done") {
      return { text: task.doneAt ? fmtDate(new Date(task.doneAt * 1000)) : "", cls: "is-ok" };
    }
    const k = dueKind(task.dueDate, today);
    if (k === "none") return { text: t.taskDueNone, cls: "is-ok" };
    if (k === "today") return { text: t.taskDueToday, cls: "is-today" };
    if (k === "future") return { text: t.taskDueOn(task.dueDate as string), cls: "is-ok" };
    const days = Math.max(1, Math.round((Date.parse(today) - Date.parse(task.dueDate as string)) / 86400000));
    return { text: t.taskDueOver(days), cls: "is-overdue" };
  }

  // 상태 전이 버튼(§1 상태 머신·§3 권한과 1:1) — 권한 매트릭스는 taskcore.taskActionDefs 단일 소스이며
  // 표·보드(taskview.renderRowActions)와 이 카드가 동일하게 파생한다(§Task 10, 중복 매트릭스 제거).
  // 라벨·실행은 taskview의 actionLabel·runAction으로 매핑하고, 실행은 buildActions()(모달·API 소유)를 재사용한다.
  private renderActions(card: HTMLElement, task: UnifiedTask): void {
    const defs = taskActionDefs(task, this.taskSelfUid());
    if (!defs.length) return;
    const a = this.buildActions();
    const acts = card.createDiv({ cls: "nanalstamp-task-acts" });
    for (const d of defs) {
      const cls = d.variant ? `nanalstamp-task-act is-${d.variant}` : "nanalstamp-task-act";
      const b = acts.createEl("button", { text: actionLabel(t, d.kind), cls });
      b.addEventListener("click", (e) => { e.stopPropagation(); runAction(a, d.kind, task); });
    }
  }

  private toggleExpand(task: TaskItem): void {
    if (this.expanded.has(task.id)) this.expanded.delete(task.id);
    else {
      this.expanded.add(task.id);
      if (!this.replies.has(task.id)) void this.loadReplies(task.id);
      this.plugin.reportTaskRead(task);   // 회신 스레드를 펼치는 것도 읽음이다(읽음 배지)
    }
    this.render();
  }

  private async loadReplies(id: string): Promise<void> {
    const rs = await this.plugin.fetchTaskReplies(id);
    if (rs) this.replies.set(id, rs);
    if (this.expanded.has(id)) this.render();
  }

  // 펼침 영역: 설명·비고 + 회신 스레드(지연 로드) + 입력(§7b — 이 패널의 뷰는 mine/inbox라 항상 당사자).
  private renderThread(card: HTMLElement, task: TaskItem): void {
    const box = card.createDiv({ cls: "nanalstamp-task-thread" });
    if (task.body) box.createDiv({ cls: "nanalstamp-task-body", text: task.body });
    if (task.memo) box.createDiv({ cls: "nanalstamp-task-body is-memo", text: task.memo });
    // 완료 코멘트·되돌림 이유(있으면) — 이력·증적.
    if (task.doneComment) box.createDiv({ cls: "nanalstamp-task-done-comment", text: t.taskDoneCommentLine(task.doneComment) });
    if (task.reopenReason) {
      const at = task.reopenedAt ? ` · ${fmtDateTime(new Date(task.reopenedAt * 1000))}` : "";
      box.createDiv({ cls: "nanalstamp-task-reopened", text: t.taskReopenedLine(task.reopenReason) + at });
    }
    const rs = this.replies.get(task.id);
    if (!rs) {
      box.createEl("p", { cls: "nanalstamp-task-state", text: "…" });
    } else {
      for (const r of rs) {
        const row = box.createDiv({ cls: "nanalstamp-task-reply" });
        const rm = row.createDiv({ cls: "nanalstamp-task-reply-meta", text: `${personDisplay(r.authorName, r.authorEmail)} · ${fmtDateTime(new Date(r.createdAt * 1000))}` });
        if (r.authorEmail) rm.title = r.authorEmail;
        row.createDiv({ cls: "nanalstamp-task-reply-body", text: r.body });
      }
    }
    // 입력(텍스트 전용·수정 불가 — §9 범위 가드)
    const form = box.createDiv({ cls: "nanalstamp-task-reply-form" });
    const ta = form.createEl("textarea", { cls: "nanalstamp-task-reply-input" });
    ta.dataset.taskId = task.id; // 자동 재렌더 시 초안(값·포커스) 복원 키
    ta.rows = 2;
    ta.placeholder = t.taskReplyPh;
    const send = form.createEl("button", { cls: "nanalstamp-task-act is-pri", text: t.taskReplySend });
    const submitReply = async () => {
      const body = ta.value.trim();
      if (!body) return;
      send.disabled = true;
      const r = await this.plugin.taskPost(`/attest/team/tasks/${encodeURIComponent(task.id)}/replies`, { body });
      send.disabled = false;
      if (!r) return;
      ta.value = "";
      this.replies.delete(task.id); // 서버 정본으로 재조회(작성자 이메일·시각 포함)
      task.replyCount += 1;
      await this.loadReplies(task.id);
    };
    send.addEventListener("click", () => void submitReply());
  }
}
