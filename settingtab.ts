// settingtab.ts — 플러그인 설정 탭. main.ts에서 순수 이동(2026-07-26).
// main.ts의 값은 참조하지 않는다 — 사전은 i18n, 경로·Node 접근은 pathutil, 상수는 constants,
// 모달은 modals(단방향). NanalStampPlugin은 생성자 인자 타입일 뿐이라 import type.

import { App, Modal, Notice, PluginSettingTab, Setting, TFolder } from "obsidian";
import { t } from "./i18n";
import { nodeReq, errMsg, defaultArchivePathSafe, parseFolders, basenameOf } from "./pathutil";
import { TASK_INBOX_VIEW_TYPE } from "./constants";
import { GitHubConnectModal, OnboardingScopeModal } from "./modals";
import { ConfirmModal } from "./modalbase";
import type { AttestSettings } from "./main";
import type NanalStampPlugin from "./main";
import { Platform } from "obsidian";
import { setLang } from "./i18n";
import { fmtDateTime } from "./fmtutil";
import { fmtBytes } from "./storagecore";

export class NanalStampSettingTab extends PluginSettingTab {
  private advOpen = false; // 고급 <details> 열림 상태 — 토글 변경 등으로 display()가 재실행돼도 유지
  constructor(app: App, private plugin: NanalStampPlugin) {
    super(app, plugin);
  }
  private text(parent: HTMLElement, name: string, desc: string, key: keyof AttestSettings) {
    new Setting(parent)
      .setName(name)
      .setDesc(desc)
      .addText((tx) =>
        tx.setValue(String(this.plugin.settings[key])).onChange(async (v) => {
          (this.plugin.settings as unknown as Record<string, unknown>)[key] = v.trim();
          await this.plugin.saveSettings();
        })
      );
  }


  // 2026-07 설정 2차: "가입·로그인만 하면 작동" — 미로그인은 시작 카드 하나,
  // 로그인 후는 계정·연동 카드 2장 + 접힌 고급(<details>)만 보여준다. 기본값이 곧 동작이다.
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("nanalstamp-settings"); // 카드·배지·고급 접기 스타일(styles.css)
    if (!Platform.isDesktopApp && !this.plugin.settings.mobileEntitled) {
      const warn = containerEl.createDiv({ cls: "nanalstamp-banner-warn" });
      warn.setText(t.mobileSealNeedPlan);
    }
    // 업데이트 배너 — **있을 때만** 맨 위에. 최신일 때 "최신입니다"를 상시 띄우면 소음이다.
    // 판정은 캐시로 즉시 그리고, 하루 1회 갱신이 결과를 바꿨을 때만 한 번 다시 그린다.
    const newer = this.plugin.updateAvailable();
    if (newer) {
      const up = containerEl.createDiv({ cls: "nanalstamp-banner-warn" });
      up.setText(t.updateBanner(newer) + " ");
      const openBtn = up.createEl("a", { text: t.updateOpenBtn });
      openBtn.onclick = () => {
        // Obsidian 의 커뮤니티 플러그인 화면이 곧 업데이트 화면이다 — 우리가 재구현하지 않는다.
        (this.app as unknown as { setting: { openTabById(id: string): void } })
          .setting.openTabById("community-plugins");
      };
    }
    void this.plugin.checkLatestVersion().then(() => {
      if (this.plugin.updateAvailable() !== newer) this.display();
    });
    // 키 거부(폐기·만료) — 정상 계정 카드를 그대로 두면 회복 경로가 없다(P-02).
    // 로그아웃을 강요하지 않는다: 시작 카드의 로그인이 성공하면 accountLogin→saveSettings가
    // apiKey를 교체하며 authFailed를 스스로 리셋한다(saveSettings의 lastApiKey 감지).
    if (this.plugin.settings.apiKey && this.plugin.authFailed) {
      const warn = containerEl.createDiv({ cls: "nanalstamp-banner-warn" });
      warn.setText(t.authFailedBanner(this.plugin.settings.accountEmail || ""));
      this.renderStartCard(containerEl, true); // 이메일/비밀번호 + [로그인] — 회복 톤으로 재사용
      this.renderVersionFooter(containerEl);
      return;
    }
    if (!this.plugin.settings.apiKey) {
      this.renderStartCard(containerEl); // (A) 미로그인 — 이 카드 외에는 아무것도 렌더하지 않는다(언어 포함)
      this.renderVersionFooter(containerEl);
      return;
    }
    this.renderAccountCard(containerEl);      // (B)-1 계정
    this.renderIntegrationsCard(containerEl); // (B)-2 연동(GitHub·팀)
    this.renderAdvanced(containerEl);         // (B)-3 고급 — 기본 닫힘
    this.renderVersionFooter(containerEl);    // 맨 아래 버전 줄 — 관례상 푸터
  }

  /// 하단 버전 줄 — `nanalStamp v1.5.5 · 최신`. "최신"은 실제로 확인된 날에만 붙인다
  /// (확인 전이거나 실패면 버전만 — 모르는 것을 아는 척하지 않는다).
  private renderVersionFooter(containerEl: HTMLElement) {
    const cur = this.plugin.manifest.version;
    const known = this.plugin.settings.latestKnownVersion;
    const upToDate = !!known && !this.plugin.updateAvailable();
    const foot = containerEl.createDiv({ cls: "setting-item-description" });
    foot.style.marginTop = "18px";
    foot.setText(t.versionLine(cur) + (upToDate ? ` · ${t.versionLatest}` : ""));
  }

  // (A) 시작 카드: 한 줄 소개 + 이메일/비밀번호 + [가입][로그인] + 재설정 텍스트 링크
  //
  // recovery=true 는 **키가 거부돼 다시 로그인하러 온** 사람이다(P-02). 처음 온 사람에게 하는
  // 환영 인사를 그대로 보여주면 "무엇을 하러 왔는지"와 화면이 어긋난다 — 제목·소개만 바꾼다.
  // [가입] 버튼은 남긴다: 계정 자체가 사라진 경우 그것이 유일한 탈출구다.
  private renderStartCard(containerEl: HTMLElement, recovery = false) {
    const card = containerEl.createDiv({ cls: "nanalstamp-card nanalstamp-start-card" });
    card.createDiv({ cls: "nanalstamp-card-title", text: recovery ? t.recoveryTitle : t.welcomeTitle });
    card.createEl("p", { text: recovery ? t.recoveryIntro : t.startIntro, cls: "nanalstamp-card-desc" });
    // 수동 API 키 입력칸은 없음 — 로그인이 키를 자동 발급한다(1차 개편 결정 유지).
    let loginEmail = "", loginPw = "";
    new Setting(card)
      // 입력 2 + 버튼 2 — 2단이면 라벨 컬럼이 짓눌린다(styles.css nanalstamp-stack).
      .setClass("nanalstamp-stack")
      .setName(t.loginName)
      .setDesc(t.loginDesc)
      .addText((tx) => tx.setPlaceholder(t.emailPlaceholder).onChange((v) => (loginEmail = v)))
      .addText((tx) => { tx.setPlaceholder(t.pwPlaceholder).onChange((v) => (loginPw = v)); (tx.inputEl).type = "password"; })
      .addButton((b) => b.setButtonText(t.registerBtn).onClick(async () => {
        try { await this.plugin.accountRegister(loginEmail, loginPw); new Notice(t.registerSent(loginEmail)); }
        catch (e) { new Notice(t.registerFail(errMsg(e))); }
      }))
      .addButton((b) => b.setButtonText(t.loginBtn).setCta().onClick(async () => {
        try {
          const tier = await this.plugin.accountLogin(loginEmail, loginPw);
          new Notice(t.loginOk(tier));
          this.display();
          // 로그인 직후 1회 — 기존에 이미 선택을 완료한 계정(다른 기기 등)이면 scopeChosen이 서버가 아닌
          // 로컬 값이라 재로그인 시에도 다시 뜰 수 있다(허용 — 과도한 알림보단 1회 더 보는 편이 안전).
          if (!this.plugin.settings.scopeChosen && !this.plugin.scopeModalOpen) new OnboardingScopeModal(this.app, this.plugin).open();
        }
        catch (e) { new Notice(t.loginFail(errMsg(e))); }
      }));
    // 비밀번호 재설정 — 작은 텍스트 링크: 이메일이 입력돼 있으면 재설정 메일 발송, 아니면 웹 재설정 페이지로.
    const reset = card.createEl("a", { text: t.resetName, cls: "nanalstamp-reset-link" });
    reset.onclick = async () => {
      if (loginEmail.trim()) {
        try { await this.plugin.accountResetRequest(loginEmail); new Notice(t.resetSent(loginEmail)); }
        catch (e) { new Notice(t.resetFail(errMsg(e))); }
      } else {
        this.plugin.openExternal("/reset");
      }
    };
  }

  // (B)-1 계정 카드: 이메일 · 티어 배지 · 크레딧 · (Pro) 사용량 바 + [요금제 보기][구독 관리][로그아웃]
  private renderAccountCard(containerEl: HTMLElement) {
    const s = this.plugin.settings;
    const card = containerEl.createDiv({ cls: "nanalstamp-card" });
    const titleRow = card.createDiv({ cls: "nanalstamp-card-title-row" });
    titleRow.createDiv({ cls: "nanalstamp-card-title", text: t.acctName });
    const badge = titleRow.createSpan({ cls: "nanalstamp-tier-badge", text: "…" });
    card.createEl("p", { text: s.accountEmail || t.acctConnected, cls: "nanalstamp-card-desc" });
    const creditsEl = card.createEl("p", { cls: "nanalstamp-card-desc", text: t.acctLoading });
    const showEnt = (e: { tier: string; cert_credits: number; is_pro: boolean; status?: string; user_id?: string } | null) => {
      if (!e) { badge.setText("—"); creditsEl.setText(t.acctConnected); return; }
      badge.setText(e.tier.toUpperCase());
      badge.toggleClass("is-pro", e.is_pro);
      creditsEl.setText(t.acctCreditsLabel(e.cert_credits) + (e.status === "past_due" ? " · " + t.pastDueBadge : ""));
      creditsEl.toggleClass("mod-warning", e.status === "past_due");
    };
    if (this.plugin.entitlement) showEnt(this.plugin.entitlement); // 캐시 즉시 표시

    // C1: 스토리지 사용량 바(Pro & nanal 스토리지 활성) — 캐시 즉시, 오래됐으면 백그라운드 재조회 후 재렌더.
    const teamNanal = s.teamStorage === "nanal";
    if (this.plugin.isPro() && (s.storageBackend === "nanal" || teamNanal)) {
      const u = this.plugin.lastUsage;
      const wrap = card.createDiv({ cls: "nanalstamp-usage" });
      const label = wrap.createDiv({ cls: "nanalstamp-usage-label" });
      // 어느 저장소의 값인지 밝힌다 — 팀 모드에서 이 숫자는 **팀 풀**이고, 개인 폴더 노트는
      // 여기에 안 잡힌다(2026-08-01 부터 갈렸다). 그냥 "스토리지 사용량"이면 vault 전체로 읽힌다.
      label.createSpan({ text: teamNanal ? t.storageUsageTeam : t.storageUsageSolo });
      label.createSpan({ cls: "v", text: u ? t.storageUsageVal(fmtBytes(u.used), u.quota > 0 ? fmtBytes(u.quota) : "—") : t.storageUsageLoading });
      const fill = wrap.createDiv({ cls: "nanalstamp-usage-bar" }).createDiv({ cls: "nanalstamp-usage-fill" });
      // 팀 모드라도 팀 폴더 밖 노트는 내 쿼터를 쓴다. 그 사실을 말하지 않으면 개인 구독이
      // 왜 필요한지 알 수 없다.
      if (teamNanal) wrap.createEl("p", { text: t.storageUsageSoloNote, cls: "nanalstamp-card-desc" });
      if (u && u.quota > 0) {
        fill.style.width = `${Math.min(100, Math.round((u.used / u.quota) * 100))}%`;
        if (u.used >= u.quota * 0.9) {
          fill.addClass("is-full");
          // C2: 팀 풀은 개인 PRO 구매로 안 늘어난다 — 팀 모드는 결제 CTA 대신 관리자 문의 안내.
          if (teamNanal) wrap.createEl("p", { text: t.teamPoolFullDesc, cls: "nanalstamp-card-desc" });
        }
      }
      if (this.plugin.usageStale()) {
        // 재렌더는 setTimeout+isConnected 가드 — 렌더 중 microtask 재진입 프리즈 방지(entitlement 갱신과 동일 패턴)
        void this.plugin.fetchStorageUsage().then(() => {
          window.setTimeout(() => { if (this.containerEl.isConnected) this.display(); }, 0);
        });
      }
    }

    // 버튼 행 — 구독 단일화 유지: 직접 결제 버튼 없음(요금제 SSOT는 웹 /pricing).
    new Setting(card)
      .setClass("nanalstamp-card-btns")
      .addButton((b) => b.setButtonText(t.pricingCmd).setCta().onClick(() => this.plugin.openExternal("/pricing")))
      .addButton((b) => b.setButtonText(t.manageSubBtn).onClick(() => this.plugin.openExternal("/account")))
      // 로그아웃 = 저장된 API 키 삭제(파괴적) — 오클릭 방지 확인 창 필수(1차 개편 결정 유지).
      .addButton((b) => b.setButtonText(t.logoutBtn).setWarning().onClick(() => {
        // 네이티브 confirm() 을 쓰면 Electron 대화상자가 렌더러를 통째로 세운다(2026-07-31 실측).
        new ConfirmModal(this.app, {
          title: t.logoutBtn, body: t.logoutConfirm,
          confirmText: t.logoutBtn, cancelText: t.confirmCancel, warning: true,
        }, () => void (async () => {
          this.plugin.settings.apiKey = "";
          this.plugin.settings.accountEmail = "";
          await this.plugin.saveSettings();
          this.display();
        })()).open();
      }));

    // 최신값 갱신: .then 콜백(마이크로태스크)에서 DOM을 만지면 Obsidian 설정 렌더와 재진입해 UI가
    // 멈추는 문제가 있었다. 매크로태스크(setTimeout 0)로 미루고, 탭이 닫혔으면 스킵한다(기존 패턴).
    void this.plugin.refreshEntitlement().then(() => {
      window.setTimeout(() => {
        if (!this.containerEl.isConnected) return;
        showEnt(this.plugin.entitlement);
      }, 0);
    });
  }

  // (B)-2 연동 카드: GitHub 백업(연결 상태 + 클릭 몇 번 연결) · 팀(소속일 때만 한 줄 + 새로고침)
  private renderIntegrationsCard(containerEl: HTMLElement) {
    const s = this.plugin.settings;
    const card = containerEl.createDiv({ cls: "nanalstamp-card" });
    card.createDiv({ cls: "nanalstamp-card-title", text: t.integrationsHead });

    // GitHub 백업 — 연결/해제만 카드에. 토글·수동 PAT 등 부속 옵션은 전부 고급으로 내렸다.
    // Device Flow 모달이 성공 시 githubExport까지 켜므로 여기서 연결만 하면 백업이 동작한다.
    if (!this.plugin.isPro()) {
      new Setting(card)
        .setName(t.githubRowName)
        .setDesc(t.githubLocked)
        .addButton((b) => b.setButtonText(t.pricingCmd).onClick(() => this.plugin.openExternal("/pricing")));
    } else if (!s.githubPat) {
      new Setting(card)
        .setName(t.githubRowName)
        .setDesc(t.githubConnectDesc)
        .addButton((b) =>
          b.setButtonText(t.githubConnectBtn).setCta().onClick(() => {
            new GitHubConnectModal(this.app, this.plugin, () => this.display()).open();
          })
        );
    } else {
      new Setting(card)
        .setName(t.githubRowName)
        .setDesc(t.githubConnectedDesc(s.githubUser || "?", s.githubRepo || "?"))
        .addButton((b) =>
          b.setButtonText(t.githubDisconnectBtn).setWarning().onClick(async () => {
            s.githubPat = "";
            s.githubUser = "";
            await this.plugin.saveSettings();
            this.display();
          })
        );
    }

    // 팀 — custody·팀 스토리지·프로파일 수신 흔적이 하나도 없으면(=팀 미소속) 행 자체를 숨긴다.
    const custody = s.teamCustody;
    if (custody || s.teamStorage === "nanal" || s.teamProfileUpdatedAt > 0) {
      const desc = custody
        ? t.teamCustodyActive(custody.org, custody.repo)
        : s.teamStorage === "nanal"
          ? t.teamStorageForced
          : t.teamProfileLastReceived(fmtDateTime(new Date(s.teamProfileUpdatedAt)));
      const row = new Setting(card).setName(t.teamRowName).setDesc(desc);

      // 팀 키가 거부된 상태 — 개인 봉인은 계속되므로 배너로 화면을 갈아끼우지 않고, 무엇이
      // 멈췄고 어디서 고치는지만 이 자리에서 말한다(P-02).
      if (this.plugin.teamKeyRejected()) {
        card.createEl("p", { text: t.teamAuthFailedHint, cls: "nanalstamp-card-desc mod-warning" });
      }
      // 팀 계정을 따로 쓰는 경우 — 회사 메일과 개인 메일이 다르면 팀 폴더의 기록은
      // 회사 계정으로 가야 소유·회수·과금이 갈린다. **비워 두면 개인 키가 양쪽에 쓰인다**
      // (개인과 팀이 같은 계정인 사람은 아무것도 하지 않아도 된다).
      // 개인 계정과 **같은 방식**으로 연결한다 — 키를 직접 붙여넣게 하면 그것을 어디서
      // 구하는지 모르는 사람은 쓸 수 없다. 로그인이 키를 발급받아 넣는다.
      if (s.teamApiKey) {
        new Setting(card)
          .setName(t.teamKeyName)
          .setDesc(t.teamKeySet(s.teamAccountEmail || "—"))
          .addButton((b) => b.setButtonText(t.teamKeyUnlink).setWarning().onClick(async () => {
            await this.plugin.teamAccountLogout();
            new Notice(t.teamKeyUnlinked);
            this.display();
          }));
      }
      // 거부된 상태에서는 **다시 연결하는 칸도 함께** 낸다. 연결 해제 버튼만 있으면 위 안내가
      // 가리킬 곳이 없어(해제부터 해야 폼이 나온다) 개인 카드와 같은 결함이 팀 쪽에 남는다.
      // 재연결이 성공하면 teamAccountLogin→resetTeamKeyCaches가 teamAuthFailed를 내린다.
      if (!s.teamApiKey || this.plugin.teamKeyRejected()) {
        let te = "", tp = "";
        new Setting(card)
          // 로그인 행과 같은 구성(입력 2 + 버튼 1)에 설명까지 길다 — 라벨을 전폭으로 올린다.
          .setClass("nanalstamp-stack")
          // 거부 상태에서는 위의 연결 해제 행과 나란히 서므로 같은 이름이면 둘을 구분할 수 없다.
          .setName(this.plugin.teamKeyRejected() ? t.teamKeyReconnectName : t.teamKeyName)
          .setDesc(t.teamKeyDesc)
          .addText((tx) => tx.setPlaceholder(t.emailPlaceholder).onChange((v) => (te = v)))
          .addText((tx) => { tx.setPlaceholder(t.pwPlaceholder).onChange((v) => (tp = v));
                             (tx.inputEl).type = "password"; })
          .addButton((b) => b.setButtonText(t.teamKeyLink).setCta().onClick(async () => {
            try {
              await this.plugin.teamAccountLogin(te, tp);
              new Notice(t.teamKeyLinked(te.trim()));
              this.display();
            } catch (e) { new Notice(t.loginFail(errMsg(e))); }
          }));
      }
      // 자동 적용이 꺼져 있으면 수동 재수신 버튼도 숨긴다(끈 상태에서는 트래픽 없음 — 기존 결정 유지).
      if (s.teamProfileEnabled) {
        row.addButton((b) =>
          b.setButtonText(t.dashRefresh).onClick(async () => {
            const r = await this.plugin.fetchTeamProfile();
            // 4.3: 같은 버튼에서 custody 미러 정보도 갱신(연결·오프보딩 반영).
            const c = await this.plugin.fetchTeamMirrorInfo();
            if (r === "applied") new Notice(t.teamProfileApplied);
            else if (r === "not-member") new Notice(t.teamProfileNotMember);
            else if (r === "no-key") new Notice(t.apiKeyMissing);
            else new Notice(t.teamProfileFail);
            if (c === "enabled") new Notice(t.teamCustodyOn);
            else if (c === "disabled" || c === "not-member") new Notice(t.teamCustodyOff);
            this.display(); // 마지막 수신 시각·custody 상태 갱신
          })
        );
      }
    }
  }

  // (B)-3 고급 설정 — 기본 닫힘 <details>. 기본값이 곧 권장값이라 대부분 열 일이 없다.
  private renderAdvanced(containerEl: HTMLElement) {
    const s = this.plugin.settings;
    const det = containerEl.createEl("details", { cls: "nanalstamp-advanced" });
    det.open = this.advOpen;
    det.addEventListener("toggle", () => { this.advOpen = det.open; });
    det.createEl("summary", { text: t.advancedSummary });
    const body = det.createDiv({ cls: "nanalstamp-advanced-body" });
    body.createEl("p", { text: t.settIntro, cls: "setting-item-description" });

    // ── 봉인 범위(기본: 전체 볼트) + 첨부 봉인(기본 켜짐) ─────────────────
    new Setting(body).setName(t.sealScopeHead).setHeading();
    // 팀 최상위 루트(2026-07-25): 루트가 있으면 로컬 필터는 미사용 — 명시 안내. 루트 미설정인데
    // 프로파일 적용은 켜져 있으면 경고 톤으로 안내(관리자가 아직 팀 이름을 저장하지 않은 상태).
    const teamRoot = this.plugin.teamRoot();
    // 루트 미설정 + 포함 폴더 비어 있음 = inScope가 전부 true(1985~) → 개인 노트까지 봉인 범위다.
    // "로컬 설정이 적용됩니다"는 그 결과를 축소해 말하는 것이어서, 실제 상태를 그대로 알린다.
    const localWholeVault = parseFolders(s.includeFolders).length === 0;
    // 팀 문구는 **팀 소속일 때만**. teamProfileEnabled는 "팀 정책을 자동 적용할지"라 기본값이 true여서,
    // 팀에 속한 적도 없는 개인 사용자에게 "팀 관리자가 …"라는 붉은 경고가 떴다(2026-07-28 발견).
    // 팀 프로파일을 한 번이라도 받은 적이 있어야(=멤버) 팀을 말한다. 개인 사용자의 범위 미설정은
    // 리본 배지·상태바·시작 범위 모달이 이미 경고하므로 여기서 또 말하지 않는다.
    const inTeam = s.teamProfileUpdatedAt > 0;
    const scopeNote = teamRoot ? t.scopeTeamRoot(teamRoot)
      : (inTeam && s.teamProfileEnabled ? (localWholeVault ? t.scopeTeamRootMissingAll : t.scopeTeamRootMissing) : "");
    if (scopeNote) {
      const note = body.createDiv();
      // 경고 톤(붉은 배경)에서는 색을 상속시킨다 — muted를 얹으면 테마에 따라 대비가 떨어진다
      // (main.ts:5557 모바일 미구독 경고와 같은 방식).
      const bg = teamRoot ? "var(--background-modifier-hover)" : "var(--background-modifier-error-hover)";
      const fg = teamRoot ? "color:var(--text-muted)" : "";
      note.style.cssText = `padding:8px 10px;margin:4px 0 8px;border-radius:6px;font-size:12px;background:${bg};${fg}`;
      note.setText(scopeNote);
    }
    // 폴더는 하나의 트리에서 고른다(2026-07-27). 예전에는 "포함 폴더"·"제외 폴더" 두 목록을
    // 사용자가 직접 관리했는데, 제외는 **"고른 폴더 안에서 일부를 뺀다"를 저장하는 방법**일 뿐
    // 사용자가 알아야 할 개념이 아니다. 트리에서 체크·해제하면 두 목록이 자동으로 만들어진다.
    const scopeSetting = new Setting(body).setName(t.sealFoldersName);
    // 저장된 항목 **수**가 아니라 실제 효과를 쓴다. "폴더 1곳 봉인"은 그 아래 전부가 봉인된다는
    // 사실을 숨긴다(2026-07-27 지적). 고른 폴더 이름을 그대로 보여주고 "아래 전부"라고 말한다.
    const scopeDesc = () => {
      const inc = parseFolders(this.plugin.settings.includeFolders);
      const exc = parseFolders(this.plugin.settings.excludeFolders);
      const root = this.plugin.teamRoot();
      const names = (root ? [root] : []).concat(inc);
      const base = names.length === 0 ? t.scopeAllVault : t.scopeUnderFolders(names.join(", "));
      return exc.length > 0 ? `${base} · ${t.scopeMinus(exc.length)}` : base;
    };
    scopeSetting.setDesc(`${scopeDesc()} · ${t.sealFoldersDesc}`);
    scopeSetting.addButton((b) =>
      b.setButtonText(t.folderPick).setCta().onClick(() => {
        new FolderTreeModal(
          this.app,
          parseFolders(this.plugin.settings.includeFolders),
          parseFolders(this.plugin.settings.excludeFolders),
          this.plugin.teamRoot(),
          async (inc, exc) => {
            this.plugin.settings.includeFolders = inc.join("\n");
            this.plugin.settings.excludeFolders = exc.join("\n");
            await this.plugin.saveSettings();
            scopeSetting.setDesc(`${scopeDesc()} · ${t.sealFoldersDesc}`);
            new Notice(t.folderTreeSaved(inc.length));
            this.plugin.updateTaskRibbon();
            void this.plugin.updateActiveStatus();
          },
          this.plugin.settings.sealWholeVault,
        ).open();
      })
    );
    new Setting(body)
      .setName(t.attachName)
      .setDesc(t.attachDesc)
      .addToggle((tg) =>
        tg.setValue(s.sealAttachments).onChange(async (v) => {
          s.sealAttachments = v;
          await this.plugin.saveSettings();
          this.display(); // 하위 경고(크기 초과 스킵) 표시/숨김 갱신
        })
      );
    if (s.sealAttachments) {
      // 업로드 한도(팀 정책 또는 5GB 하드캡) 초과로 클라우드 보관에서 제외된 첨부는 경고로 노출(침묵 누락 방지).
      if (s.attachSkipped.length > 0) {
        new Setting(body)
          .setName(t.attachSkippedWarn(s.attachSkipped.length, this.plugin.uploadLimitMB(), this.plugin.uploadSkipByTeam()))
          .setDesc(s.attachSkipped.join(", "))
          .setClass("mod-warning");
      }
    }

    // 봉인하지 못한 노트 — **조용한 실패를 막는 자리.** 첨부가 상한을 넘거나 보관 용량이
    // 차면 봉인을 하지 않는데, 알림 한 번만으로 끝내면 사용자는 봉인된 줄 안다.
    // 원인이 풀리면 스스로 봉인되고 이 목록에서 사라진다.
    {
      const holds = Object.entries(s.sealHolds || {});
      if (holds.length > 0) {
        new Setting(body).setName(t.holdsTitle(holds.length)).setHeading();
        const box = body.createDiv({ cls: "nanalstamp-pkg-preview" });
        box.createDiv({ text: t.holdsDesc, cls: "setting-item-description" });
        for (const [notePath, h] of holds) {
          const row = box.createDiv({ cls: "setting-item-description" });
          row.setText(t.holdDetailLine(
            notePath, h.kind, basenameOf(h.path), Math.ceil(h.size / (1024 * 1024)), h.limitMB));
        }
      }
      // 지금 적용 중인 상한을 늘 보이게 — 막힌 뒤에야 알게 되면 늦다.
      const lim = this.plugin.settings.attachmentMaxMb;
      new Setting(body)
        .setName(t.attachLimitName)
        .setDesc(t.attachLimitDesc(lim, this.plugin.settings.teamAttachmentMaxMB));
    }

    // ── 업무 요청함(§7b) — 사용 토글 + 시스템 알림(데스크톱 전용) ──────────
    // ── 봉인 범위 이력 ────────────────────────────────────────────────────
    //
    // 왜 화면에 있어야 하나: 범위 스냅샷을 사슬에 봉인해 두어도 **볼 수 없으면 없는 것과 같다.**
    // 감사에서 "왜 이 노트는 봉인이 안 됐냐"를 물으면 그 자리에서 꺼내 보여줄 수 있어야 한다.
    // 문서는 이 기기의 DEK 로만 열린다 — 서버는 암호문만 갖고 있다.
    new Setting(body).setName(t.scopeHistHead).setHeading();
    const histBox = body.createDiv();
    histBox.createDiv({ text: t.scopeHistLoading, cls: "setting-item-description" });
    void this.plugin.scopeHistory().then((rows) => {
      histBox.empty();
      if (!rows.length) {
        histBox.createDiv({ text: t.scopeHistEmpty, cls: "setting-item-description" });
        return;
      }
      histBox.createDiv({ text: t.scopeHistDesc, cls: "setting-item-description" });
      const tbl = histBox.createEl("table", { cls: "nanalstamp-hist-table" });
      const head = tbl.createEl("tr");
      for (const h of [t.scopeHistN, t.scopeHistWhen, t.scopeHistProof, t.scopeHistScope]) {
        head.createEl("th", { text: h });
      }
      // 설정 화면은 "지금 어떤가"용이다 — 최근 3건만 보이고, 전체 표는 웹으로 보낸다
      // (2026-08-15 지적: 수백 건짜리 표가 설정 안에 있을 자리가 아니다).
      const RECENT = 3;
      // 최신이 위로 — 사람은 "지금 어떤가"를 먼저 본다.
      for (const r of rows.slice(-RECENT).reverse()) {
        const tr = tbl.createEl("tr");
        const td = (txt: string) => {
          return tr.createEl("td", { text: txt });
        };
        td(String(r.n));
        td(new Date(r.at * 1000).toLocaleString("ko-KR"));
        // 확정 블록이 있으면 그것이 증거다. 없으면 아직 앵커 전 — 숨기지 않고 그대로 말한다.
        td(r.block ? t.scopeHistBlock(r.block) : t.scopeHistPending);
        const cell = td("");
        if (!r.doc) {
          // 복호 실패해도 "그때 범위가 바뀌었다"는 사실은 사슬에 남아 있다 — 그 말을 해준다.
          cell.setText(t.scopeHistLocked);
          continue;
        }
        const b = r.doc["본문"] ?? {};
        const inc: string[] = b["포함_폴더"] ?? [];
        const exc: string[] = b["제외_폴더"] ?? [];
        cell.createDiv({ text: inc.length ? inc.join(" · ") : t.scopeHistWhole });
        if (exc.length) cell.createDiv({ text: t.scopeHistExclude(exc.join(" · ")), cls: "setting-item-description" });
        const link = cell.createEl("a", { text: t.scopeHistOpen, cls: "nanalstamp-hist-open" });
        link.onclick = () => {
          const m = new Modal(this.app);
          m.titleEl.setText(t.scopeHistDocTitle(r.n));
          const pre = m.contentEl.createEl("pre", { cls: "nanalstamp-doc-pre" });
          pre.setText(JSON.stringify(r.doc, null, 2));
          m.contentEl.createDiv({ text: t.scopeHistDocNote(r.docHash), cls: "setting-item-description" });
          m.open();
        };
      }
      const foot = histBox.createDiv({ cls: "setting-item-description" });
      foot.setText(t.scopeHistRecent(Math.min(3, rows.length), rows.length) + " ");
      const webLink = foot.createEl("a", { text: t.scopeHistWebBtn });
      webLink.onclick = () => this.plugin.openExternal("/account#scope-history");
    }).catch(() => {
      histBox.empty();
      histBox.createDiv({ text: t.scopeHistFail, cls: "setting-item-description" });
    });

    new Setting(body).setName(t.taskHead).setHeading();
    new Setting(body)
      .setName(t.taskInboxEnableName)
      .setDesc(t.taskInboxEnableDesc)
      .addToggle((tg) =>
        tg.setValue(s.taskInboxEnabled).onChange(async (v) => {
          s.taskInboxEnabled = v;
          await this.plugin.saveSettings();
          this.plugin.updateTaskRibbon(); // 리본 표시/숨김 즉시 반영
          if (v) {
            void this.plugin.pollTasks(true); // 켜는 즉시 1회 동기화(배지 복원)
            this.plugin.startTaskSse();       // SSE 준실시간 구독 재개(데스크톱)
          } else {
            this.plugin.stopTaskSse();        // OFF면 SSE도 중단(§7 — 폴링과 동일 원칙)
            this.app.workspace.detachLeavesOfType(TASK_INBOX_VIEW_TYPE); // 끄면 열린 패널도 정리
          }
          this.display(); // 하위 시스템 알림 토글 표시/숨김
        })
      );
    if (s.taskInboxEnabled && Platform.isDesktopApp) {
      // 시스템 알림은 데스크톱 전용(§7b) — 모바일은 배지·패널만이라 토글 자체를 숨긴다.
      new Setting(body)
        .setName(t.taskSysNotifyName)
        .setDesc(t.taskSysNotifyDesc)
        .addToggle((tg) =>
          tg.setValue(s.taskSystemNotify).onChange(async (v) => {
            s.taskSystemNotify = v;
            await this.plugin.saveSettings();
          })
        );
      // OS 알림은 자동 설정이 불가(macOS 보안 정책) — 자가진단 버튼으로 권한·스타일 문제를 즉석 확인.
      new Setting(body)
        .setName(t.taskSysNotifyTest)
        .setDesc(t.taskSysNotifyTestDesc)
        .addButton((b) =>
          b.setButtonText(t.taskSysNotifyTest).onClick(() => {
            try { new Notification("nanalStamp", { body: t.taskSysNotifyTestSent }); } catch { /* 무시 */ }
            new Notice(t.taskSysNotifyTestSent);
          })
        );
    }

    // ── 보관·백업: 오프사이트 스토리지(B·C1) + 로컬 git 아카이브(P1.5, 기본 켜짐) ──
    new Setting(body).setName(t.storageHead).setHeading();
    if (!this.plugin.isPro()) {
      // 비-Pro: 잠금 안내만(결제 CTA는 계정 카드에 이미 있다)
      new Setting(body).setName(t.githubLocked).setDesc(t.storageProNote);
    } else {
      // C2: 팀 custody 스토리지가 nanal이면 멤버의 개인 선택과 무관하게 강제 활성 — 드롭다운 잠금 + 안내로 대체.
      const teamNanal = s.teamStorage === "nanal";
      const backendSetting = new Setting(body)
        .setName(t.storageBackendName)
        .setDesc(teamNanal ? t.teamStorageForced : t.storageBackendDesc)
        .addToggle((tg) => {
          // off|nanal 이지선다라 드롭다운일 이유가 없다 — on/off 토글로.
          tg.setValue(teamNanal || s.storageBackend === "nanal").onChange(async (v) => {
            s.storageBackend = v ? "nanal" : "off";
            await this.plugin.saveSettings();
            this.display(); // 하위 설명 + 계정 카드 사용량 바 표시/숨김
          });
          tg.setDisabled(teamNanal);
        });
      if (s.storageBackend === "nanal" || teamNanal) {
        // 켜짐 상세는 같은 항목의 설명 두 번째 문단으로 — 별도 Setting 블록(위쪽 공백) 금지(2026-07-22 사용자 지적).
        const extra = backendSetting.descEl.createDiv({ cls: "nanalstamp-desc-extra" });
        extra.setText(t.storageNanalDesc);
      }
    }

    // P1.5: 로컬 git 아카이브(전 티어, 데스크탑만) — 렌더는 전부 동기(프리즈 방지). 폴더선택/이관/git은 버튼 onClick에서만.
    if (!Platform.isDesktopApp) {
      new Setting(body).setName(t.archiveName).setDesc(t.archiveMobile);
    } else {
      // 토글 없음 — 끌 수 있는 기능이 아니다(archiveEnabled 주석 참조). 위치만 고른다.
      new Setting(body).setName(t.archiveName).setDesc(t.archiveAlways);
      // 경로칸(기본값 채워 표시) + "폴더 선택" 버튼. 텍스트 입력은 draft에만 담고
      // 실제 적용(이관 포함)은 버튼 onClick에서 applyArchivePath로만 한다.
      let draftPath = s.archivePath;
      new Setting(body)
        .setName(t.archivePathName)
        .setDesc(t.archivePathDesc)
        .addText((tx) => {
          tx.setValue(s.archivePath).setPlaceholder(defaultArchivePathSafe(this.app.vault.getName()));
          tx.onChange((v) => (draftPath = v));
        })
        .addButton((b) =>
          b.setButtonText(t.archivePickBtn).onClick(async () => {
            // 네이티브 폴더 다이얼로그 best-effort → 실패/없으면 경로칸 직접입력 폴백.
            let chosen = "";
            try {
              const remote = nodeReq("@electron/remote");
              const r = await remote?.dialog?.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
              if (r && !r.canceled && r.filePaths?.[0]) chosen = r.filePaths[0];
            } catch { /* 폴백: 아래 draftPath 사용 */ }
            const target = chosen || draftPath;
            const res = await this.plugin.applyArchivePath(target);
            if (res.status === "migrated") new Notice(t.archiveMigrated(res.a || "", res.b || ""));
            else if (res.status === "exists") new Notice(t.archiveExists);
            else if (res.status === "set") new Notice(t.archiveSet(res.b || ""));
            else if (res.status === "invault") new Notice(t.archiveInVault);
            else if (res.status === "error") new Notice(t.archiveNotWritable(res.b || target));
            this.display(); // 경로칸 갱신
          })
        );
    }

    // ── P1: 증명 원장(로컬, 전 티어, 기본 켜짐) + 백필 + 증명서 크레딧 ────
    new Setting(body).setName(t.ledgerHead).setHeading();
    // 토글 없음 — 증명 저장도 끌 수 있는 기능이 아니다(로컬 아카이브와 같은 이유). 폴더만 고른다.
    new Setting(body).setName(t.ledgerName).setDesc(t.ledgerDesc);
    this.text(body, t.ledgerFolderName, t.ledgerFolderDesc, "ledgerFolder");
    new Setting(body)
      .setName(t.backfillName)
      .setDesc(t.backfillDesc)
      .addToggle((tg) =>
        tg.setValue(s.autoBackfill).onChange(async (v) => {
          s.autoBackfill = v;
          await this.plugin.saveSettings();
          if (v) this.plugin.startBackfill(); // 재활성화 = 1회성 배수 다시 시작(소진되면 스스로 종료)
        })
      );
    // 원문 소급 보관 — 스토리지가 켜져 있을 때만 의미가 있다(시작 범위 모달의 섹션 B와 같은 설정).
    if (this.plugin.nanalActive()) {
      new Setting(body)
        .setName(t.nanalBackfillName)
        .setDesc(t.nanalBackfillDesc)
        .addToggle((tg) =>
          tg.setValue(s.nanalBackfill).onChange(async (v) => {
            s.nanalBackfill = v;
            if (!v) s.nanalSince = Date.now(); // 끄는 순간 기준시각 기록 — 이후 ledgerSweep이 이 시각 이후 노트만 소급 대상으로
            await this.plugin.saveSettings(); // 켜면 값 유지만으로 소급 재개(다음 ledgerSweep이 다시 전부 대상으로 봄)
          })
        );
    }
    // 제출 패키지 크레딧 구매 — zip 한 번 만들 때 1건씩 쓰는 단건 크레딧(구독과 별개로 유지).
    // 종전 이름은 '증명서 크레딧'이었다 — 건당 증명서를 접고 제출 패키지가 그것을 흡수하면서
    // 이 크레딧이 사는 대상도 바뀌었다(2026-08-05).
    new Setting(body)
      .setName(t.buyCreditCmd)
      .setDesc(t.buyCreditDesc)
      .addButton((b) => b.setButtonText(t.buyCreditCmd).onClick(() => this.plugin.startCheckout("cert_single")));

    // ── C1 고급: GitHub 내보내기 세부(토글·수동 repo/PAT) — 연결/해제 자체는 연동 카드에 ──
    if (this.plugin.isPro()) {
      new Setting(body).setName(t.storageAdvHead).setHeading();
      // 4.3: 팀 custody 활성이면 개인 GitHub 설정은 쓰이지 않음을 안내.
      if (s.teamCustody) new Setting(body).setDesc(t.teamCustodyPersonalUnused);
      new Setting(body)
        .setName(t.githubExportName)
        .setDesc(t.githubExportDesc)
        .addToggle((tg) =>
          tg.setValue(s.githubExport).onChange(async (v) => {
            s.githubExport = v;
            await this.plugin.saveSettings();
            this.display();
          })
        );
      if (s.githubExport) {
        // 고급(수동 PAT) — 파워 유저용 repo칸 + PAT칸(보조)
        new Setting(body).setName(t.githubAdvancedName).setDesc(t.githubAdvancedDesc);
        this.text(body, t.githubRepoName, t.githubRepoDesc, "githubRepo");
        new Setting(body)
          .setName(t.githubPatName)
          .setDesc(t.githubPatDesc)
          .addText((tx) => {
            tx.setValue(s.githubPat).onChange(async (v) => {
              s.githubPat = v.trim();
              await this.plugin.saveSettings();
            });
            (tx.inputEl).type = "password";
          });
      }
    }

    // ── 팀 프로파일 자동 적용(기본 켜짐) — 상태·재수신은 연동 카드에 ──────
    new Setting(body).setName(t.teamProfileHead).setHeading();
    // 팀 소속이면 **잠근다**(2026-08-05). 팀 정책 자동 적용을 끄면 teamRoot()가 null이 되어
    // 팀 폴더 노트가 개인 사슬로 떨어진다 — 조직이 강제해야 할 것을 팀원이 끄는 경로다.
    // 판정은 teamApiKey 단독이 아니라 teamRole과 합쳐 본다 — teamApiKey는 팀 계정을 따로
    // 쓰는(회사 메일 ≠ 개인 메일) 소수만 채워지고(main.ts teamAccountLogin), 대다수 팀원은
    // 같은 계정을 그대로 쓰므로 teamApiKey가 끝까지 비어 있다(main.ts keyFor 주석 참조).
    // teamRole은 fetchTeamProfile이 매 수신마다 갱신하고 팀을 떠나면 404 분기에서 정리되므로
    // 대다수 경로를 커버하고 탈퇴 후 자동으로 풀린다. teamApiKey는 "팀 계정 로그인 직후,
    // 첫 수신이 아직 안 온" 좁은 창(그 사이 설정 탭을 열어 끄는 경우)만 추가로 덮는다.
    const teamLocked = !!s.teamApiKey || s.teamRole !== "";
    if (teamLocked && !s.teamProfileEnabled) {
      // 이미 꺼 둔 사람은 되돌린다(1회 교정). 기동 시점 교정은 main.ts(onLayoutReady)에도 있다 —
      // 여기 것은 설정 탭을 여는 순간에도 한 번 더 잡아 주는 보험(그 경로를 놓쳐도 여기서 걸린다).
      s.teamProfileEnabled = true;
      void this.plugin.saveSettings();
    }
    new Setting(body)
      .setName(t.teamProfileEnableName)
      .setDesc(teamLocked ? t.teamProfileLockedDesc : t.teamProfileEnableDesc)
      .addToggle((tg) =>
        tg.setValue(s.teamProfileEnabled).setDisabled(teamLocked).onChange(async (v) => {
          s.teamProfileEnabled = v;
          await this.plugin.saveSettings();
          this.display(); // 연동 카드의 재수신 버튼 노출 여부 갱신
        })
      );

    // ── 기타(템플릿·언어) ────────────────────────────────────────────────
    new Setting(body).setName(t.miscHead).setHeading();
    // 개발노트 템플릿 토글·폴더는 잠정 회수(2026-08-14) — 템플릿 원고가 아직 없는 상태에서
    // 설정만 노출되면 "켰는데 아무것도 없다"가 된다. loadSettings 의 강제 false 와 세트.
    // digest 등록부는 팀 기능(team_digests) — 개인 계정에는 뜻이 없어 팀 소속일 때만 보인다.
    if (s.teamProfileUpdatedAt > 0) {
      this.text(body, t.digestFolderName, t.digestFolderDesc, "digestFolder");
    }
    new Setting(body)
      .setName(t.langName)
      .setDesc(t.langDesc)
      .addDropdown((d) =>
        d
          // 기본은 Auto(= Obsidian 설정 → 일반 → 언어를 따름). 무엇을 따르는지 라벨에 적는다 —
          // "Auto"만 보면 무엇 기준인지 알 수 없다(2026-07-28 지적).
          .addOption("auto", t.langAutoOpt)
          .addOption("en", "English")
          .addOption("ko", "한국어")
          .setValue(s.lang)
          .onChange(async (v) => {
            s.lang = v as AttestSettings["lang"];
            await this.plugin.saveSettings();
            setLang(s.lang);
            new Notice(t.langReload);
            this.display();
          })
      );
  }
}


// 봉인 폴더 트리(2026-07-27) — **화면은 트리 하나, 저장은 포함/제외 두 목록**.
//
// 왜 합쳤나: 제외 폴더는 "고른 폴더 안에서 일부를 뺀다"를 저장하는 방법일 뿐, 사용자가 알아야
// 할 개념이 아니다. 두 목록을 직접 관리하게 하면 같은 것을 두 곳에서 말하게 되고 어긋난다.
// 트리에서 체크·해제하면 두 목록이 자동으로 만들어진다.
//
// 규칙(파일 탐색기의 상식 그대로):
//   - 상위를 체크하면 하위는 전부 봉인된다
//   - 그 하위 중 일부를 해제할 수 있다 → 그게 제외 목록이 된다
//   - 하위 일부만 체크된 상위는 중간 상태(네모)
//
// 저장 형태: include = 체크한 폴더 중 조상이 체크되지 않은 것(최소 집합),
//            exclude = 덮인 상태에서 명시적으로 해제한 것(최소 집합).
export class FolderTreeModal extends Modal {
  private inc: Set<string>;
  private exc: Set<string>;
  private open_: Set<string> = new Set();
  private filter = "";
  private resetScroll = false;   // 검색어 변경 등 목록이 통째로 바뀌는 렌더에서만 true

  constructor(
    app: App,
    include: string[],
    exclude: string[],
    private teamRoot: string | null,
    private onDone: (include: string[], exclude: string[]) => void | Promise<void>,
    private wholeVault = false,
  ) {
    super(app);
    this.inc = new Set(include);
    this.exc = new Set(exclude);
    for (const f of [...include, ...exclude]) {
      const parts = f.split("/");
      for (let i = 1; i < parts.length; i++) this.open_.add(parts.slice(0, i).join("/"));
    }
  }

  private allFolders(): string[] {
    const out: string[] = [];
    for (const f of this.app.vault.getAllLoadedFiles()) {
      if (f instanceof TFolder && f.path && f.path !== "/") out.push(f.path);
    }
    return out.sort((a, b) => a.localeCompare(b, "ko"));
  }

  /// 이 경로가 봉인 대상인가 — main.ts inFolderScopePure와 **같은 규칙**이어야 한다.
  /// 가장 가까운 조상(자기 자신 포함)의 판정을 따른다: 제외가 더 가까우면 제외, 포함이면 포함.
  private sealed(path: string): boolean {
    let cur: string | null = path;
    while (cur) {
      if (this.exc.has(cur)) return false;
      if (this.inc.has(cur)) return true;
      if (this.teamRoot && cur === this.teamRoot) return true;
      const i = cur.lastIndexOf("/");
      cur = i === -1 ? null : cur.slice(0, i);
    }
    // 아무 규칙에도 안 걸림: 포함 목록이 비었고 팀도 없으면 — **전체 봉인을 명시적으로 켰을 때만** 대상이다
    // (2026-07-28). 예전에는 무조건 전체였고, 그래서 아무것도 안 고른 상태인데 트리는 "전부 봉인"으로
    // 보였다. 화면이 실제 동작과 갈리면 사용자는 화면을 믿는다.
    return this.inc.size === 0 && !this.teamRoot && this.wholeVault;
  }

  /// 트리 체크박스의 3상태 — 파일 탐색기의 상식 그대로.
  ///   checked       = 자신과 하위 **전부** 봉인
  ///   indeterminate = 일부만 봉인(자신은 봉인인데 하위 일부가 빠진 경우도 포함)
  ///   unchecked     = 자신도 하위도 봉인 아님
  /// 자신만 보고 판단하면 "상위는 체크인데 하위 하나가 빠진" 상태를 표현할 수 없다.
  private triState(path: string, all: string[]): { checked: boolean; partial: boolean } {
    const self = this.sealed(path);
    const kids = all.filter((f) => f.startsWith(path + "/"));
    const allOn = self && kids.every((f) => this.sealed(f));
    const anyOn = self || kids.some((f) => this.sealed(f));
    return { checked: allOn, partial: !allOn && anyOn };
  }

  /// 상태 전환 — 하위에 남은 규칙은 지운다(상위가 새로 정했으므로 하위 예외는 무효).
  private setState(path: string, on: boolean): void {
    // 팀 폴더는 잠겨 있다 — UI가 막지만 규칙 쪽에서도 한 번 더 막는다(둘 중 하나만 고치면 갈린다).
    if (this.teamRoot && (path === this.teamRoot || path.startsWith(this.teamRoot + "/"))) return;
    for (const set of [this.inc, this.exc]) {
      for (const c of Array.from(set)) if (c.startsWith(path + "/")) set.delete(c);
    }
    this.inc.delete(path);
    this.exc.delete(path);
    // 상위(또는 팀 루트)가 이미 원하는 상태를 만들어 주면 규칙을 더하지 않는다 — 목록을 최소로.
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
    const inherited = parent ? this.sealed(parent)
                             : (this.inc.size === 0 && !this.teamRoot && this.wholeVault);
    if (on !== inherited) (on ? this.inc : this.exc).add(path);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: t.folderTreeTitle });
    contentEl.createDiv({ text: t.folderTreeHelp2, cls: "ns-ft-help" });
    const search = contentEl.createEl("input", { type: "text", placeholder: t.folderPickPh, cls: "ns-ft-search" });
    const treeEl = contentEl.createDiv({ cls: "ns-ft-tree" });
    search.addEventListener("input", () => {
      this.filter = search.value.trim().toLowerCase();
      this.resetScroll = true;
      this.renderTree(treeEl);
    });
    this.renderTree(treeEl);

    const foot = contentEl.createDiv({ cls: "ns-ft-foot" });
    const count = foot.createSpan({ cls: "ns-ft-count" });
    const sync = () => {
      const all = this.allFolders();
      count.setText(t.folderTreeSealedCount(all.filter((f) => this.sealed(f)).length, all.length));
    };
    sync();
    treeEl.addEventListener("change", sync);
    const btns = foot.createDiv({ cls: "ns-ft-btns" });
    btns.createEl("button", { text: t.folderTreeCancel }).addEventListener("click", () => this.close());
    btns.createEl("button", { text: t.folderTreeApply, cls: "mod-cta" }).addEventListener("click", () => {
      const cmp = (a: string, b: string) => a.localeCompare(b, "ko");
      void this.onDone(Array.from(this.inc).sort(cmp), Array.from(this.exc).sort(cmp));
      this.close();
    });
  }

  private renderTree(host: HTMLElement): void {
    // 체크 하나 바꿀 때마다 트리를 다시 그리는데, empty()가 스크롤을 0으로 되돌린다 —
    // 아래쪽 폴더를 만지면 화면이 맨 위로 튄다(2026-07-27 지적). 위치를 보존한다.
    // 단, 검색어가 바뀌어 목록이 통째로 달라질 때는 맨 위가 맞다(보존하면 빈 곳을 보게 된다).
    const keepScroll = this.resetScroll ? 0 : host.scrollTop;
    this.resetScroll = false;
    host.empty();
    const all = this.allFolders();
    if (this.filter) {
      const hit = all.filter((f) => f.toLowerCase().includes(this.filter));
      if (!hit.length) { host.createDiv({ text: t.folderTreeNoHit, cls: "ns-ft-empty" }); return; }
      for (const f of hit) this.row(host, all, f, f, 0, false);
      host.scrollTop = keepScroll;
      return;
    }
    const children = (parent: string) =>
      all.filter((f) => (parent === "" ? !f.includes("/")
                                       : f.startsWith(parent + "/") && !f.slice(parent.length + 1).includes("/")));
    const walk = (parent: string, depth: number) => {
      for (const f of children(parent)) {
        const kids = children(f);
        this.row(host, all, f, f.split("/").pop() || f, depth, kids.length > 0);
        if (kids.length && this.open_.has(f)) walk(f, depth + 1);
      }
    };
    walk("", 0);
    host.scrollTop = keepScroll;
  }

  private row(host: HTMLElement, all: string[], path: string, label: string, depth: number, hasKids: boolean): void {
    const row = host.createDiv({ cls: "ns-ft-row" });
    row.style.paddingLeft = `${depth * 18}px`;
    if (hasKids && this.open_.has(path)) row.addClass("is-open");
    const tri = row.createSpan({ cls: "ns-ft-tri" });
    if (hasKids) {
      tri.addClass("is-clickable");
      tri.setAttr("aria-label", this.open_.has(path) ? t.folderTreeCollapse : t.folderTreeExpand);
      tri.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this.open_.has(path)) this.open_.delete(path); else this.open_.add(path);
        this.renderTree(host);
      });
    }
    // 팀 폴더는 팀이 정하는 범위다 — 개인이 끄지 못하게 잠근다(2026-07-27).
    const underTeam = !!this.teamRoot && (path === this.teamRoot || path.startsWith(this.teamRoot + "/"));
    const { checked, partial } = this.triState(path, all);
    const cb = row.createEl("input", { type: "checkbox" });
    cb.checked = underTeam || checked;
    cb.indeterminate = !underTeam && partial;
    cb.disabled = underTeam;
    cb.addEventListener("change", () => {
      this.setState(path, cb.checked);
      this.renderTree(host);
      host.dispatchEvent(new Event("change", { bubbles: true }));
    });
    row.createSpan({ text: label, cls: "ns-ft-name" });
    if (underTeam) row.createSpan({ text: t.folderTreeTeamCovered, cls: "ns-ft-tag" });
    row.addEventListener("click", (e) => {
      if (e.target === cb || cb.disabled) return;
      // 중간 상태에서 누르면 "전부 켜기"가 자연스럽다(부분 → 전체).
      cb.checked = partial ? true : !cb.checked;
      cb.dispatchEvent(new Event("change"));
    });
  }

  onClose(): void { this.contentEl.empty(); }
}
