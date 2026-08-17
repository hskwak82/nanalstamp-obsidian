// taskmodals.ts — 업무·폴더 관련 모달 8종(§7b~). main.ts에서 순수 이동(2026-07-26).
// TaskComposeModal · TaskRequestModal · TaskDeclineModal · TaskDetailModal ·
// TaskDoneModal · TaskReopenModal · FolderRenameModal · FolderCreateModal
//
// 값 순환 참조 회피: main.ts의 값은 하나도 참조하지 않는다(t는 i18n, 날짜는 fmtutil,
// 나머지는 taskcore·obsidian). NanalStampPlugin은 생성자 인자 타입일 뿐이라
// import type으로만 받는다 — 타입 참조는 빌드 시 소거되므로 순환이 생기지 않는다.
import { App, FuzzySuggestModal, Notice, Setting, TFile } from "obsidian";
import { NanalModal } from "./modalbase";
import { isMarkdownPath } from "./sealscope";
import type { TaskItem, TaskReply, RosterMember, FolderRename, FanoutOutcome, FolderStatus, FolderTarget } from "./taskcore";
import { canEditTask, rosterLabel, folderStatus, buildTaskCreatePayloads, summarizeFanout, conflictRenameSuggestion } from "./taskcore";
import { t } from "./i18n";
import { fmtDate, fmtDateTime } from "./fmtutil";
import type NanalStampPlugin from "./main";

// ── 새 요청 모달(§7b) — 제목·설명·수신자(roster)·마감·우선순위. 수신자 없으면 personal 보관 안내 ──
export class TaskComposeModal extends NanalModal {
  private title = "";
  private body = "";
  private memo = ""; // "" = 없음(§비고)
  private assignees = new Set<string>(); // 비었음 = 없음(내 업무) — 다중 선택(인별 복제 fan-out)
  private assigneeLabels = new Map<string, string>(); // uid → roster 표시 라벨(부분 실패 Notice용)
  private startDate = ""; // onOpen에서 오늘로 프리필(§시작일 디폴트)
  private due = ""; // 마감기한은 항상 필수(2026-07-24) — 의식적 선택을 유도하기 위해 디폴트는 빈칸.
  private priority = "week";
  private projectId = ""; // "" = 과제 없음(§3) — active 전부 노출해도 무해(서버가 참여·상태 검증)
  constructor(app: App, private plugin: NanalStampPlugin, private onDone: () => void) {
    super(app);
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: t.taskNewTitle });
    const today = fmtDate(new Date());
    this.startDate = today; // §시작일 디폴트 = 오늘(폼 열릴 때, 로컬 날짜)
    new Setting(contentEl).setName(t.taskFieldTitle).addText((tx) => {
      tx.setPlaceholder(t.taskTitlePlaceholder);
      tx.onChange((v) => (this.title = v));
      tx.inputEl.addClass("nanalstamp-input-full");
    });
    new Setting(contentEl).setName(t.taskFieldBody).addTextArea((ta) => ta.onChange((v) => (this.body = v)))
      .settingEl.addClass("nanalstamp-m-stack");
    // §3 연구과제 — 캐시 즉시 채움 + 갱신 후 신규분 추가(roster 지연 로드 관례).
    new Setting(contentEl).setName(t.taskFieldProject).addDropdown((dd) => {
      dd.addOption("", t.taskProjectNone);
      const added = new Set<string>();
      const fill = () => {
        for (const p of this.plugin.teamProjects) {
          if (added.has(p.id)) continue;
          added.add(p.id);
          dd.addOption(p.id, p.code ? `${p.name} (${p.code})` : p.name);
        }
      };
      fill();
      dd.onChange((v) => (this.projectId = v));
      void this.plugin.refreshProjects().then(fill);
    });
    // 우선순위 변경은 마감에 더 이상 영향을 주지 않는다(2026-07-24 결정 — 연동 제거).
    new Setting(contentEl).setName(t.taskFieldPriority).addDropdown((dd) => {
      for (const p of ["now", "week", "ref"]) dd.addOption(p, t.taskPriLabel[p]);
      dd.setValue(this.priority);
      dd.onChange((v) => { this.priority = v; });
    });
    new Setting(contentEl).setName(t.taskFieldStart).addText((tx) => {
      (tx.inputEl).type = "date";
      tx.setValue(this.startDate);
      tx.onChange((v) => (this.startDate = v));
    });
    new Setting(contentEl).setName(t.taskFieldDue).addText((tx) => {
      (tx.inputEl).type = "date";
      tx.setValue(this.due);
      tx.onChange((v) => { this.due = v; });
    });
    new Setting(contentEl).setName(t.taskFieldMemo).addText((tx) => {
      tx.setPlaceholder(t.taskMemoPlaceholder);
      tx.onChange((v) => (this.memo = v));
      tx.inputEl.addClass("nanalstamp-input-full");
    });
    // 수신자 — 체크박스 다중 선택(멤버 ≤10 가정, §fan-out). roster 지연 로드(실패 시 목록이
    // 비어 있어도 personal 생성은 항상 가능 = 오프라인/비팀 안전). setDesc는 "체크 안 하면
    // 내 업무로 보관"이라는 기존 안내문을 그대로 재사용.
    new Setting(contentEl).setName(t.taskFieldAssignee).setDesc(t.taskAssigneeNone);
    const assigneeBox = contentEl.createDiv({ cls: "nanalstamp-task-assignee-list" });
    const renderRoster = (ms: RosterMember[]) => {
      assigneeBox.empty();
      this.assigneeLabels.clear();
      if (!ms.length) {
        assigneeBox.createEl("p", { cls: "setting-item-description", text: t.taskAssigneeEmpty });
        return;
      }
      for (const m of ms) {
        const label = rosterLabel(m);
        this.assigneeLabels.set(m.userId, label);
        const row = assigneeBox.createEl("label", { cls: "nanalstamp-task-assignee-row" });
        const cb = row.createEl("input", { type: "checkbox" });
        cb.checked = this.assignees.has(m.userId);
        cb.addEventListener("change", () => {
          if (cb.checked) this.assignees.add(m.userId);
          else this.assignees.delete(m.userId);
        });
        row.createSpan({ text: " " + label });
      }
    };
    void this.plugin.fetchTaskRoster().then((ms) => renderRoster(ms ?? []));
    const cBtns = new Setting(contentEl).addButton((b) =>
      b.setButtonText(t.taskCreateBtn).setCta().onClick(() => void this.submit()));
    cBtns.settingEl.addClass("nanalstamp-m-actions");
  }
  private async submit(): Promise<void> {
    const title = this.title.trim();
    if (!title) { new Notice(t.taskNeedTitle); return; }
    if (!this.due) { new Notice(t.taskNeedDue); return; } // 마감기한은 항상 필수(2026-07-24)
    const assignees = Array.from(this.assignees);
    const fields = {
      title, body: this.body, memo: this.memo, priority: this.priority,
      startDate: this.startDate, due: this.due, projectId: this.projectId,
    };
    const payloads = buildTaskCreatePayloads(fields, assignees);
    if (assignees.length === 0) {
      const r = await this.plugin.taskPost("/attest/team/tasks", payloads[0]);
      if (!r) return;
      new Notice(t.taskCreatedPersonal);
      this.close();
      this.onDone();
      return;
    }
    // 인별 복제(웹과 동일 동작) — 순차 POST, 실패해도 계속(성공분은 유지). 개별 실패의 자동
    // Notice는 억제하고(silent) 아래서 결과를 모아 요약 Notice 하나로 보여준다.
    const outcomes: FanoutOutcome[] = [];
    for (let i = 0; i < assignees.length; i++) {
      const uid = assignees[i];
      const r = await this.plugin.taskPost("/attest/team/tasks", payloads[i], { silent: true });
      outcomes.push({ assignee: uid, label: this.assigneeLabels.get(uid) ?? uid, ok: !!r });
    }
    const { okCount, failed } = summarizeFanout(outcomes);
    new Notice(failed.length === 0 ? t.taskCreatedRequestedN(okCount) : t.taskCreatedRequestedPartial(okCount, failed));
    this.close();
    this.onDone();
  }
  onClose() { this.contentEl.empty(); }
}

// ── 요청/재요청 모달 — personal·declined → requested (수신자·마감 필수, §3 /request) ──
export class TaskRequestModal extends NanalModal {
  private assignee: string;
  private due: string;
  constructor(app: App, private plugin: NanalStampPlugin, private task: TaskItem, private onDone: () => void) {
    super(app);
    this.assignee = task.assigneeUid ?? ""; // 재요청은 기존 수신자·마감 프리필
    this.due = task.dueDate ?? "";
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: t.taskRequestTitle });
    contentEl.createEl("p", { cls: "nanalstamp-m-subject", text: this.task.title });
    new Setting(contentEl).setName(t.taskFieldAssignee).addDropdown((dd) => {
      dd.onChange((v) => (this.assignee = v));
      void this.plugin.fetchTaskRoster().then((ms) => {
        for (const m of ms ?? []) dd.addOption(m.userId, rosterLabel(m));
        if (this.assignee) dd.setValue(this.assignee);
        else this.assignee = dd.getValue(); // 첫 항목이 기본 선택값
      });
    });
    new Setting(contentEl).setName(t.taskFieldDue).addText((tx) => {
      (tx.inputEl).type = "date";
      tx.setValue(this.due);
      tx.onChange((v) => (this.due = v));
    });
    new Setting(contentEl).addButton((b) => b.setButtonText(t.taskBtnRequest.replace("…", "")).setCta().onClick(() => void this.submit()));
  }
  private async submit(): Promise<void> {
    if (!this.due) { new Notice(t.taskNeedDue); return; }
    if (!this.assignee) { new Notice(t.taskLoadFail); return; } // roster 미수신 — 재시도 유도
    const r = await this.plugin.taskPost(`/attest/team/tasks/${encodeURIComponent(this.task.id)}/request`,
      { assignee_uid: this.assignee, due_date: this.due });
    if (!r) return;
    new Notice(t.taskCreatedRequested);
    this.close();
    this.onDone();
  }
  onClose() { this.contentEl.empty(); }
}

// ── 반려 모달 — 사유 필수(200자, 서버가 최종 검증 §3 /decline) ──
export class TaskDeclineModal extends NanalModal {
  private reason = "";
  constructor(app: App, private plugin: NanalStampPlugin, private task: TaskItem, private onDone: () => void) {
    super(app);
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: t.taskDeclineTitle });
    contentEl.createEl("p", { cls: "nanalstamp-m-subject", text: this.task.title });
    new Setting(contentEl)
      .setName(t.taskDeclineReasonName)
      .setDesc(t.taskDeclineReasonDesc)
      .addTextArea((ta) => {
        ta.setPlaceholder(t.taskDeclineReasonPh);
        ta.onChange((v) => (this.reason = v));
        ta.inputEl.rows = 4;
      }).settingEl.addClass("nanalstamp-m-stack");
    const dBtns = new Setting(contentEl).addButton((b) =>
      b.setButtonText(t.taskBtnDecline).setDestructive().onClick(() => void this.submit()));
    dBtns.settingEl.addClass("nanalstamp-m-actions");
  }
  private async submit(): Promise<void> {
    const reason = this.reason.trim();
    if (!reason) { new Notice(t.taskDeclineReasonPh); return; }
    const r = await this.plugin.taskPost(`/attest/team/tasks/${encodeURIComponent(this.task.id)}/decline`, { reason });
    if (!r) return;
    this.close();
    this.onDone();
  }
  onClose() { this.contentEl.empty(); }
}

// ── 완료 모달 — 코멘트 선택(≤2KB, 서버 §done). 확인 절차(봉인 고지) + recall이면 회수 종결 고지 ──
/// 업무 상세 — 표·컴팩트 어디서든 제목을 누르면 열린다(2026-07-26).
/// 표에는 담을 수 없는 것들을 한곳에 모은다: **설명(body)**, 상태 **이력**(등록·요청·접수·완료·
/// 거절·되돌림 시각), **완료 보고(doneComment)**, **회신 스레드**, 비고. 그전에는 완료 보고를
/// 적어도 어디에서도 다시 볼 수 없었고 요청 본문도 마찬가지였다 — 데이터는 목록 응답에 이미
/// 내려오고 있었으므로 표시만의 문제였다.
export class TaskDetailModal extends NanalModal {
  private replies: TaskReply[] | null = null;
  private repliesFailed = false;
  private replyBody = ""; // 회신 입력 상태
  private roster: RosterMember[] = [];        // 멘션 후보(지연 로드)
  private mentioned = new Map<string, string>(); // uid → 삽입한 라벨. 전송 시 본문에 남아 있는 것만 인정
  constructor(
    app: App, private plugin: NanalStampPlugin, private task: TaskItem,
    private currentUserUid: string,
    private onOpenNote: (path: string) => void,
    private onEdit?: (task: TaskItem) => void,
  ) { super(app); }

  onOpen(): void {
    this.render();
    void this.loadReplies();
  }
  onClose(): void { this.contentEl.empty(); }

  private async loadReplies(): Promise<void> {
    // 0건이면 조회를 건너뛴다. 다만 **다시 그려야 한다** — 첫 render는 replies===null이라
    // "불러오는 중…"을 그려 놓았고, 여기서 그냥 return하면 그 문구가 영영 남는다(2026-07-26 실측).
    if (this.task.replyCount <= 0) { this.replies = []; this.render(); return; }
    const rs = await this.plugin.fetchTaskReplies(this.task.id);
    // 서버가 준 실제 개수로 정정한다 — 헤더의 "회신 N"이 목록 길이와 어긋나지 않게(내가 쓴 1건만
    // 낙관적으로 더하면, 그 사이 상대가 남긴 회신이 목록에는 보이는데 개수에는 빠진다).
    if (rs) { this.replies = rs; this.task.replyCount = rs.length; } else this.repliesFailed = true;
    this.render(); // 회신은 뒤늦게 도착 — 도착하면 그 부분만이 아니라 통째로 다시 그린다(상태가 단순)
  }

  /// 사람 이름 — 별칭 > 이메일 > uid 뒷자리. uid만 남는 경우는 탈퇴·미가입 계정이다.
  private who(uid: string | null, name: string | null, email: string | null): string {
    if (name) return name;
    if (email) return email;
    return uid ? uid.slice(0, 8) : "—";
  }
  /// 완료·되돌림 처리자 uid를 아는 이름으로 되돌린다(요청자/담당자 둘 중 하나가 대부분).
  private actorName(uid: string | null): string {
    if (!uid) return "";
    if (uid === this.task.assigneeUid) return this.who(uid, this.task.assigneeName, this.task.assigneeEmail);
    if (uid === this.task.creatorUid) return this.who(uid, this.task.creatorName, this.task.creatorEmail);
    return uid.slice(0, 8);
  }
  private stamp(epochSec: number | null): string {
    return epochSec ? fmtDateTime(new Date(epochSec * 1000)) : "";
  }

  /// 다음 렌더에서 본문을 맨 아래로 보낼지 — 회신을 보낸 직후 **방금 쓴 것이 보이게** 한다.
  ///
  /// 회신을 보내면 loadReplies 가 통째로 다시 그린다. 그러면 스크롤이 맨 위로 돌아가서,
  /// 사용자는 자기가 쓴 회신을 보려고 또 내려야 했다(2026-08-06 지적).
  /// 보낸 직후 한 번만 켜지고, 렌더가 소비하면 꺼진다 — 그러지 않으면 사용자가 위로
  /// 올려 읽는 중에 폴링이 다시 그릴 때마다 아래로 튕긴다.
  private stickToBottom = false;

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("nanalstamp-task-detail");
    const task = this.task;

    // 헤더 / 스크롤 본문 / 고정 푸터 3단(2026-08-06 지적).
    // 종전에는 전부 contentEl 에 평평하게 쌓아 **모달 전체가 스크롤**됐다 — 회신이 쌓이면
    // 닫기(X)가 위로 밀려 사라지고, 스크롤바가 둥근 모서리 밖으로 삐져나왔다.
    // Obsidian 의 .modal-close-button 은 .modal 기준 절대배치라, 스크롤을 안쪽으로 옮겨야 고정된다.
    const head = contentEl.createDiv({ cls: "nanalstamp-td-head" });
    const scroll = contentEl.createDiv({ cls: "nanalstamp-td-scroll" });

    head.createEl("h3", { text: t.taskDetailTitle });
    head.createDiv({ cls: "nanalstamp-td-title", text: task.title });

    // 상태·우선순위 뱃지 — 표에서 보던 것과 같은 클래스를 써 시각을 일치시킨다.
    const pills = head.createDiv({ cls: "nanalstamp-td-pills" });
    // 카드·표와 같은 상태 pill 규칙(personal은 pill 없음 — 상태가 아니라 분류라서).
    const st = task.status === "requested" ? { text: t.taskStWait, cls: "is-wait" }
      : task.status === "accepted" ? { text: t.taskStAcc, cls: "is-acc" }
      : task.status === "declined" ? { text: t.taskStDeclined, cls: "is-declined" }
      : task.status === "done" ? { text: t.taskStDone, cls: "is-done" } : null;
    if (st) pills.createSpan({ cls: "nanalstamp-task-st " + st.cls, text: st.text });
    pills.createSpan({ cls: "nanalstamp-task-pill is-" + (task.priority || "week"),
      text: t.taskPriLabel[task.priority] ?? task.priority });
    // [업무 수정]은 **여기**에 둔다. 하단 회신 입력창 아래에 두었더니 "회신을 수정"하는 것처럼
    // 읽혔다(2026-07-29 지적). 이 버튼은 업무 전체에 대한 것이라 제목·상태 옆이 제자리다.
    if (this.onEdit && canEditTask(task, this.currentUserUid)) {
      const b = pills.createEl("button", { cls: "nanalstamp-td-edit", text: t.taskEditBtn });
      b.onclick = () => { this.close(); this.onEdit!(task); };
    }

    // 메타 — 요청자/담당/과제/기간
    const meta = scroll.createDiv({ cls: "nanalstamp-td-meta" });
    const row = (label: string, value: string): void => {
      const r = meta.createDiv({ cls: "nanalstamp-td-row" });
      r.createSpan({ cls: "nanalstamp-td-label", text: label });
      r.createSpan({ cls: "nanalstamp-td-value", text: value });
    };
    row(t.taskDetailCreator, this.who(task.creatorUid, task.creatorName, task.creatorEmail));
    row(t.taskDetailAssignee, task.assigneeUid ? this.who(task.assigneeUid, task.assigneeName, task.assigneeEmail) : "—");
    row(t.taskDetailProject, task.projectName || "—");
    row(t.taskDetailPeriod, `${task.startDate || "—"} ~ ${task.dueDate || "—"}`);

    // 설명
    scroll.createEl("h4", { text: t.taskDetailDesc });
    scroll.createDiv({ cls: "nanalstamp-td-body" + (task.body ? "" : " is-empty"),
      text: task.body || t.taskDetailNoDesc });

    // 이력 — 있는 것만, 시간 순서대로
    scroll.createEl("h4", { text: t.taskDetailHistory });
    const hist = scroll.createDiv({ cls: "nanalstamp-td-hist" });
    const ev = (label: string, at: number | null, extra?: string): void => {
      if (!at) return;
      const r = hist.createDiv({ cls: "nanalstamp-td-row" });
      r.createSpan({ cls: "nanalstamp-td-label", text: label });
      r.createSpan({ cls: "nanalstamp-td-value", text: this.stamp(at) + (extra ? ` · ${extra}` : "") });
    };
    ev(t.taskDetailCreated, task.createdAt);
    ev(t.taskDetailRequested, task.requestedAt);
    ev(t.taskDetailAccepted, task.acceptedAt);
    ev(t.taskDetailDoneAt, task.doneAt, this.actorName(task.doneBy));
    ev(t.taskDetailReopened, task.reopenedAt, this.actorName(task.reopenedBy));
    if (task.declineReason) {
      const r = hist.createDiv({ cls: "nanalstamp-td-row" });
      r.createSpan({ cls: "nanalstamp-td-label", text: t.taskDetailDeclined });
      r.createSpan({ cls: "nanalstamp-td-value", text: task.declineReason });
    }
    if (task.reopenReason) {
      const r = hist.createDiv({ cls: "nanalstamp-td-row" });
      r.createSpan({ cls: "nanalstamp-td-label", text: t.taskDetailReopened });
      r.createSpan({ cls: "nanalstamp-td-value", text: task.reopenReason });
    }

    // 완료 보고 — 완료된 업무에서만(아직 진행 중인데 "없습니다"를 보여줄 이유가 없다)
    if (task.status === "done" || task.doneAt) {
      scroll.createEl("h4", { text: t.taskDetailDoneReport });
      scroll.createDiv({ cls: "nanalstamp-td-body" + (task.doneComment ? "" : " is-empty"),
        text: task.doneComment || t.taskDetailNoDoneReport });
    }

    if (task.memo) {
      scroll.createEl("h4", { text: t.taskDetailMemo });
      scroll.createDiv({ cls: "nanalstamp-td-body", text: task.memo });
    }

    // 회신 — 개수는 목록 응답에 있으므로 헤더는 즉시, 본문은 도착 후
    scroll.createEl("h4", { text: t.taskDetailRepliesN(task.replyCount) });
    const rep = scroll.createDiv({ cls: "nanalstamp-td-replies" });
    if (this.repliesFailed) {
      rep.createDiv({ cls: "nanalstamp-td-body is-empty", text: t.taskReplyLoadFail });
    } else if (this.replies === null) {
      rep.createDiv({ cls: "nanalstamp-td-body is-empty", text: t.folderCreateLoading });
    } else if (!this.replies.length) {
      rep.createDiv({ cls: "nanalstamp-td-body is-empty", text: t.taskDetailNoReplies });
    } else {
      for (const r of this.replies) {
        const item = rep.createDiv({ cls: "nanalstamp-td-reply" });
        const head = item.createDiv({ cls: "nanalstamp-td-reply-head" });
        head.createSpan({ cls: "nanalstamp-td-reply-who", text: this.who(r.authorUid, r.authorName, r.authorEmail) });
        head.createSpan({ cls: "nanalstamp-td-reply-at", text: this.stamp(r.createdAt) });
        item.createDiv({ cls: "nanalstamp-td-reply-body", text: r.body });
      }
    }

    // 회신 작성 입력 — 요청자·담당자만 가능(포털 renderThread와 동일 판정).
    // uid가 빈 문자열이면 **권한 없음**으로 본다. taskSelfUid()는 목록에서 역산하므로 ""를 돌려줄 수
    // 있고(주석 참조), TaskItem.creatorUid도 파싱 실패 시 ""가 된다(taskcore.ts str(...) ?? ""). 빈
    // 문자열끼리 비교하면 아무나 회신할 수 있게 되므로 me가 비면 먼저 막는다.
    const me = this.currentUserUid;
    const canReply = !!me && (task.creatorUid === me || task.assigneeUid === me);
    if (canReply) {
      const form = contentEl.createDiv({ cls: "nanalstamp-td-reply-form" });  // 푸터 — 스크롤 밖
      const ta = form.createEl("textarea", { cls: "nanalstamp-td-reply-input" });
      ta.placeholder = t.taskReplyPh;
      ta.rows = 2;
      ta.value = this.replyBody; // 입력 상태 복원
      // input이어야 한다 — change는 포커스가 빠질 때만 발생하므로, 입력 중에 회신 목록이 도착해
      // loadReplies가 통째로 다시 그리면(render) 마지막 blur 이후 친 내용이 사라진다.
      // 멘션 — `@`를 치면 팀원 목록이 뜨고, 고른 사람만 알림을 받는다(2026-07-26).
      // 서버는 본문을 파싱하지 않는다: 고른 uid를 함께 보내야 알림이 간다. 그래서 그냥 타이핑한
      // `@홍길동`은 알림이 가지 않고, 목록에서 고른 것만 간다 — 규칙이 예측 가능해야 한다.
      const picker = form.createDiv({ cls: "nanalstamp-td-mention" });
      picker.hide();
      const closePicker = () => { picker.hide(); picker.empty(); };
      const openPicker = (frag: string) => {
        const q = frag.toLowerCase();
        const hits = this.roster.filter((m) => rosterLabel(m).toLowerCase().includes(q)).slice(0, 6);
        picker.empty();
        if (!hits.length) { closePicker(); return; }
        for (const m of hits) {
          const row = picker.createDiv({ cls: "nanalstamp-td-mention-row", text: rosterLabel(m) });
          row.addEventListener("mousedown", (ev) => {
            ev.preventDefault(); // blur보다 먼저 — textarea 포커스를 유지한다
            const v = ta.value;
            const at = v.lastIndexOf("@", ta.selectionStart - 1);
            if (at < 0) return;
            const label = rosterLabel(m);
            ta.value = v.slice(0, at) + "@" + label + " " + v.slice(ta.selectionStart);
            this.replyBody = ta.value;
            this.mentioned.set(m.userId, label);
            closePicker();
            ta.focus();
          });
        }
        picker.show();
      };
      ta.addEventListener("input", (e) => {
        const el = e.target as HTMLTextAreaElement;
        this.replyBody = el.value;
        const upto = el.value.slice(0, el.selectionStart);
        const at = upto.lastIndexOf("@");
        // `@` 이후 공백이 없을 때만 후보를 띄운다(문장 중간의 이메일 등에 반응하지 않게).
        if (at >= 0 && !/\s/.test(upto.slice(at + 1))) openPicker(upto.slice(at + 1));
        else closePicker();
      });
      ta.addEventListener("blur", () => window.setTimeout(closePicker, 120));
      void this.plugin.fetchTaskRoster().then((ms) => { this.roster = ms ?? []; });
      const send = form.createEl("button", { cls: "nanalstamp-task-act is-pri", text: t.taskReplySend });
      // 빈 회신은 어차피 무시된다 — 누를 수 있게 두면 "눌렀는데 아무 일도 안 난다"가 된다.
      // 입력이 생기면 켜고, 비면 끈다(공백만 있는 것도 빈 것으로 본다).
      const syncSend = () => { send.disabled = !ta.value.trim(); };
      syncSend();
      ta.addEventListener("input", syncSend);
      const submitReply = async () => {
        const body = ta.value.trim();
        if (!body) return; // 빈 본문 무시
        send.disabled = true;
        // 본문에 남아 있는 라벨만 실제 멘션으로 인정 — 골랐다가 지운 사람에게 알림이 가면 안 된다.
        const mentions = [...this.mentioned.entries()]
          .filter(([, label]) => body.includes("@" + label)).map(([uid]) => uid);
        const r = await this.plugin.taskPost(`/attest/team/tasks/${encodeURIComponent(task.id)}/replies`,
          mentions.length ? { body, mentions } : { body });
        send.disabled = false;
        if (!r) return;
        ta.value = ""; // 입력 비우기
        syncSend();    // 비웠으니 다시 비활성
        this.replyBody = "";
        this.mentioned.clear();
        // 먼저 올려야 loadReplies가 조회를 한다 — replyCount가 0이면 조회를 건너뛰도록 돼 있어서,
        // 첫 회신은 이 한 줄이 없으면 화면에 나타나지 않는다. 실제 개수는 loadReplies가 정정한다.
        task.replyCount += 1;
        void this.plugin.refreshTaskSealSummary(); // 방금 봉인이 늘었다 — 상태바가 따라오게
        this.stickToBottom = true;   // 이번 렌더는 맨 아래로(새 회신은 목록 끝에 붙는다)
        await this.loadReplies(); // 목록 새로고침 → render()
      };
      send.addEventListener("click", () => void submitReply());
    } else {
      // 권한 없음 — 읽기전용 안내
      const notice = contentEl.createDiv({ cls: "nanalstamp-td-reply-notice" });  // 푸터 — 스크롤 밖
      notice.createEl("p", { cls: "setting-item-description", text: t.taskDetailNoReplyPermission });
    }

    // 닫기 버튼을 걷어냈으므로(X로 닫는다) 아무 버튼도 없으면 이 줄 자체를 만들지 않는다 —
    // 무조건 만들면 버튼 없는 빈 칸과 구분선만 남는다.
    // 수정은 위(제목 옆)로 올렸다 — 회신 입력창 아래에 두면 회신을 고치는 것처럼 읽힌다.
    if (task.linkedNotePath) {
      const path = task.linkedNotePath;
      const row = new Setting(contentEl).addButton((b) =>
        b.setButtonText(t.taskDetailOpenNote).onClick(() => { this.close(); this.onOpenNote(path); }));
      row.settingEl.addClass("nanalstamp-m-actions");
    }

    // 회신을 막 보냈으면 맨 아래로 — 방금 쓴 것이 보여야 한다. 플래그는 여기서 소비한다
    // (계속 켜 두면 사용자가 위로 올려 읽는 중에 폴링 렌더가 아래로 튕긴다).
    if (this.stickToBottom) {
      this.stickToBottom = false;
      // 레이아웃이 끝난 프레임에 — 같은 tick 에는 scrollHeight 가 아직 확정되지 않는다.
      window.requestAnimationFrame(() => {
        const sc = this.contentEl.querySelector<HTMLElement>(".nanalstamp-td-scroll");
        if (sc) sc.scrollTop = sc.scrollHeight;
      });
    }
  }
}

export class TaskDoneModal extends NanalModal {
  private comment = "";
  private resultNote = ""; // 이 업무의 산출물 노트(선택) — 완료와 함께 서버에 저장·봉인·과제 귀속
  constructor(app: App, private plugin: NanalStampPlugin, private task: TaskItem, private recall: boolean, private onDone: () => void) {
    super(app);
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: this.recall ? t.taskRecallTitle : t.taskDoneTitle });
    // 무엇을 완료하는지가 안내문과 같은 회색이면 대상이 눈에 안 들어온다.
    contentEl.createEl("p", { cls: "nanalstamp-m-subject", text: this.task.title });
    const note = t.taskDoneConfirmNote + (this.recall ? " " + t.taskRecallNote : "");
    contentEl.createEl("p", { cls: "nanalstamp-m-note", text: note });
    // 완료 보고 — 감사 리포트에 남는 기록이다. 라벨 없이 우측 좁은 칸에 두면 무엇을 적는
    // 자리인지도, 얼마나 적어도 되는지도 알 수 없다(2026-07-29 지적).
    new Setting(contentEl)
      .setName(t.taskDoneCommentName)
      .setDesc(t.taskDoneCommentDesc)
      .addTextArea((ta) => {
        ta.setPlaceholder(t.taskDoneCommentPh);
        ta.onChange((v) => (this.comment = v));
        ta.inputEl.rows = 5;
      }).settingEl.addClass("nanalstamp-m-stack");
    // 결과 노트(선택) — 업무함이 증거 파이프라인의 입구가 되는 지점. 고르면 완료와 함께
    // (1) 서버에 경로 저장 (2) 그 노트를 즉시 봉인 (3) 업무에 과제가 있으면 그 과제에 귀속.
    // 자동으로 찾아 붙이지 않는다(§6) — 무엇이 산출물인지는 수행자만 안다.
    // 고른 경로가 길어 우측 칸에서 글자 단위로 쪼개졌다 — 라벨·설명 아래 전폭으로 내린다.
    const pick = new Setting(contentEl)
      .setName(t.taskResultName)
      .setDesc(t.taskResultDesc);
    pick.settingEl.addClass("nanalstamp-m-stack");
    // 버튼을 먼저 만들고 상태를 그 **옆에** 붙인다 — 상태를 왼쪽 끝에 두면 버튼과의 사이가
    // 텅 비어 둘이 한 쌍으로 읽히지 않는다.
    pick.addButton((b) => b.setButtonText(t.taskResultPick).onClick(() => {
      new ResultNoteSuggestModal(this.app, this.plugin, (path) => {
        this.resultNote = path;
        paint();
      }).open();
    }));
    const row = pick.controlEl.createDiv({ cls: "nanalstamp-td-pickrow" });
    const shown = row.createSpan({ cls: "nanalstamp-td-result", text: t.taskResultNone });
    const clearBtn = row.createEl("button", { cls: "nanalstamp-td-clear", text: t.taskResultClear });
    const paint = () => {
      const has = !!this.resultNote;
      shown.setText(has ? this.resultNote : t.taskResultNone);
      shown.toggleClass("is-empty", !has);
      clearBtn.toggle(has); // 고르지 않았는데 지우기 버튼이 떠 있을 이유가 없다
    };
    clearBtn.onclick = () => { this.resultNote = ""; paint(); };
    paint();
    const actions = new Setting(contentEl).addButton((b) =>
      b.setButtonText(this.recall ? t.taskBtnRecall : t.taskBtnDone).setCta().onClick(() => void this.submit()));
    actions.settingEl.addClass("nanalstamp-m-actions");
  }
  private async submit(): Promise<void> {
    const c = this.comment.trim();
    const rn = this.resultNote.trim();
    // 코멘트·결과 노트 둘 다 선택 — 아무것도 없으면 본문 없이 POST(서버 하위 호환).
    const body: Record<string, string> = {};
    if (c) body.comment = c;
    if (rn) body.result_note_path = rn;
    const r = await this.plugin.taskPost(
      `/attest/team/tasks/${encodeURIComponent(this.task.id)}/done`,
      Object.keys(body).length ? body : undefined);
    if (!r) return;
    this.close();
    // 완료가 성공한 뒤에만 봉인·귀속을 시도한다. 여기서 실패해도 완료는 이미 확정이므로
    // 되돌리지 않고 알림만 남긴다 — 봉인은 파일 변경 시 다시 걸린다(재시도 큐).
    if (rn) void this.plugin.sealResultNote(rn, this.task.projectId ?? null);
    this.onDone();
  }
  onClose() { this.contentEl.empty(); }
}


// ── 결과 노트 선택 — 완료 모달에서 "이 업무의 산출물"을 vault에서 고른다(2026-07-26) ──
// 봉인 범위(dashInScope) 안의 노트만 후보로 둔다. 범위 밖 노트를 고르면 연결은 되지만
// 봉인이 안 돼 증적이 반쪽이 되므로, 애초에 고를 수 없게 하는 편이 오해가 없다.
export class ResultNoteSuggestModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private plugin: NanalStampPlugin, private onPick: (path: string) => void) {
    super(app);
    this.setPlaceholder(t.taskResultPickPh);
  }
  getItems(): TFile[] {
    return this.app.vault.getFiles().filter((f) => isMarkdownPath(f.path) && this.plugin.dashInScope(f.path));
  }
  getItemText(f: TFile): string { return f.path; }
  onChooseItem(f: TFile): void { this.onPick(f.path); }
}

// ── 되돌리기 모달 — 이유 필수(≤200자, 서버 §reopen). 확인 절차(증적 보존 봉인 고지) ──
export class TaskReopenModal extends NanalModal {
  private reason = "";
  constructor(app: App, private plugin: NanalStampPlugin, private task: TaskItem, private onDone: () => void) {
    super(app);
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: t.taskReopenTitle });
    contentEl.createEl("p", { cls: "nanalstamp-m-subject", text: this.task.title });
    contentEl.createEl("p", { cls: "nanalstamp-m-note", text: t.taskReopenConfirmNote });
    new Setting(contentEl)
      .setName(t.taskReopenReasonName)
      .setDesc(t.taskReopenReasonDesc)
      .addTextArea((ta) => {
        ta.setPlaceholder(t.taskReopenReasonPh);
        ta.onChange((v) => (this.reason = v));
        ta.inputEl.rows = 4;
      }).settingEl.addClass("nanalstamp-m-stack");
    const rBtns = new Setting(contentEl).addButton((b) =>
      b.setButtonText(t.taskReopenBtn).setDestructive().onClick(() => void this.submit()));
    rBtns.settingEl.addClass("nanalstamp-m-actions");
  }
  private async submit(): Promise<void> {
    const reason = this.reason.trim();
    if (!reason) { new Notice(t.taskNeedReopenReason); return; }
    const r = await this.plugin.taskPost(`/attest/team/tasks/${encodeURIComponent(this.task.id)}/reopen`, { reason });
    if (!r) return;
    this.close();
    this.onDone();
  }
  onClose() { this.contentEl.empty(); }
}

// ── §3 통합 폴더 만들기 모달(2026-07-25) — 팀 표준 폴더 + 참여 과제 폴더를 목록으로 띄워
//     각 생성 상태(완료/부분/없음)를 보여주고, 체크한 항목의 미존재분만 "만들기"로 생성(덮어쓰기 절대 없음).
//     ProjectKitSuggestModal(FuzzySuggestModal)·KitConfirmModal(단건 확인)을 대체.
//     대상 계산(무엇을 어디에 만들 것인가)은 plugin.teamFolderTargets 한 곳에 있다 — 자동 적용과
//     같은 함수를 본다. 여기 행은 그 대상에 **이 시점의** 상태와 화면 요소만 얹은 것이다.
export interface FolderRow extends FolderTarget {
  status: FolderStatus;
  checkEl?: HTMLInputElement;
  badgeEl?: HTMLElement;
}

/// 팀 폴더 이름이 바뀌었을 때 이동을 묻는 모달(2026-07-26).
/// 결정은 단 한 번만 콜백으로 나간다 — ESC·바깥 클릭으로 닫는 것도 "나중에"와 같게 다룬다
/// (닫았는데 아무 일도 안 일어나면 사용자는 무엇이 선택됐는지 알 수 없다).
export class FolderRenameModal extends NanalModal {
  private decided = false;
  constructor(app: App, private list: FolderRename[], private done: (ok: boolean) => void | Promise<void>) { super(app); }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("nanalstamp-folder-rename");
    contentEl.createEl("h3", { text: t.folderSyncTitle });
    contentEl.createEl("p", { cls: "setting-item-description", text: t.folderSyncDesc });
    const box = contentEl.createDiv({ cls: "nanalstamp-fr-list" });
    for (const r of this.list) {
      const row = box.createDiv({ cls: "nanalstamp-fr-row" });
      row.createSpan({ cls: "nanalstamp-fr-from", text: r.from });
      row.createSpan({ cls: "nanalstamp-fr-arrow", text: "→" });
      row.createSpan({ cls: "nanalstamp-fr-to", text: r.to });
      const n = this.countNotes(r.from);
      if (n) row.createSpan({ cls: "nanalstamp-fr-count", text: t.folderSyncNotes(n) });
    }
    const btns = new Setting(contentEl);
    btns.addButton((b) => b.setButtonText(t.folderSyncLater).onClick(() => this.finish(false)));
    btns.addButton((b) => b.setButtonText(t.folderSyncApply).setCta().onClick(() => this.finish(true)));
  }

  /// 이 폴더가 품고 있는 파일 수 — "무엇이 움직이는지"를 숫자로 보여 주기 위한 것.
  private countNotes(prefix: string): number {
    return this.app.vault.getFiles().filter((f) => f.path.startsWith(prefix + "/")).length;
  }

  private finish(ok: boolean): void {
    if (this.decided) return;
    this.decided = true;
    this.close();
    void this.done(ok);
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.decided) { this.decided = true; void this.done(false); } // ESC·바깥 클릭 = 나중에
  }
}

export class FolderCreateModal extends NanalModal {
  private rows: FolderRow[] = [];
  private makeBtn: HTMLButtonElement | null = null;
  /// 샘플 포함 여부 — **기본 꺼짐**(2026-07-27). 샘플은 하지도 않은 실험·수업 기록이고,
  /// vault에 만들면 `.md`라 봉인 대상이 된다. 봉인은 되돌릴 수 없으므로 안전한 쪽이 기본이다.
  private withSamples = false;
  constructor(app: App, private plugin: NanalStampPlugin) { super(app); }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: t.folderCreateTitle });
    const listEl = contentEl.createDiv();
    listEl.createDiv({ text: t.folderCreateLoading, cls: "setting-item-description" });
    void this.load(listEl);
  }
  onClose() { this.contentEl.empty(); }

  private async load(listEl: HTMLElement): Promise<void> {
    this.rows = await this.buildRows();
    this.render(listEl);
  }

  /// 대상(팀 공통 + 참여 과제)은 plugin.teamFolderTargets에서 받고, 여기서는 **이 시점의** vault
  /// 스냅샷으로 상태만 매긴다 — 대상 계산이 여기 따로 있으면 자동 적용과 갈린다.
  /// 루트 미설정이면 빈 목록(render가 안내 문구를 띄운다).
  private async buildRows(): Promise<FolderRow[]> {
    const existing = new Set<string>(this.app.vault.getAllLoadedFiles().map((f) => f.path));
    const targets = await this.plugin.teamFolderTargets({ samples: this.withSamples });
    return targets.map((tg) => ({ ...tg, status: folderStatus(tg.allPaths, existing) }));
  }

  /// 샘플이 하나라도 있는 킷을 받았을 때만 체크박스를 보여준다 — 없는 킷에 켜고 끄는 스위치가
  /// 있으면 "켰는데 아무 일도 안 난다"가 된다.
  private hasSamples(): boolean {
    return this.rows.some((r) => r.hasSamples);
  }

  private render(listEl: HTMLElement): void {
    listEl.empty();
    if (!this.rows.length) {
      const msg = this.plugin.teamRoot() ? t.folderCreateEmpty : t.folderCreateNoRoot;
      listEl.createDiv({ text: msg, cls: "setting-item-description" });
      return;
    }
    for (const row of this.rows) {
      // 행 전체가 <label>이다 — 체크박스와 암묵적으로 연결되므로 이름·경로 어디를 눌러도 토글되고,
      // 스크린리더가 체크박스 이름으로 행 텍스트를 읽는다(체크박스만 단독으로 두면 이름이 없다).
      const rowEl = listEl.createEl("label", { cls: "nanalstamp-fc-row" });
      const check = rowEl.createEl("input", { attr: { type: "checkbox" } });
      check.addEventListener("change", () => this.updateMakeEnabled());
      const labelWrap = rowEl.createDiv({ cls: "nanalstamp-fc-label" });
      labelWrap.createDiv({ text: row.label });
      labelWrap.createDiv({ text: row.pathLabel, cls: "nanalstamp-fc-sub" });
      const badge = rowEl.createSpan({ cls: "nanalstamp-fc-badge" });
      row.checkEl = check;
      row.badgeEl = badge;
      this.applyRowState(row);
    }
    // 샘플 포함 — 있는 킷에서만 노출. 켜면 하지도 않은 기록이 vault에 생기고, 팀 정책에 따라
    // **봉인될 수 있다**(되돌릴 수 없다). 그래서 경고를 체크박스 바로 아래 붙인다.
    if (this.hasSamples()) {
      const sw = this.contentEl.createEl("label", { cls: "nanalstamp-fc-row" });
      const sc = sw.createEl("input", { attr: { type: "checkbox" } });
      sc.checked = this.withSamples;
      const wrap = sw.createDiv({ cls: "nanalstamp-fc-label" });
      wrap.createDiv({ text: t.kitSamplesInclude });
      wrap.createDiv({ text: t.kitSamplesWarn, cls: "nanalstamp-fc-sub" });
      sc.addEventListener("change", () => {
        this.withSamples = sc.checked;
        // 대상 경로가 통째로 바뀌므로 목록을 다시 만든다(뱃지·개수도 함께 갱신된다).
        void this.load(listEl);
      });
    }
    const btns = new Setting(this.contentEl);
    btns.addButton((b) => { this.makeBtn = b.setButtonText(t.folderCreateMake).setCta().onClick(() => void this.make()).buttonEl; });
    this.updateMakeEnabled();
  }

  /// 상태 뱃지·체크박스 반영. 완료=체크·비활성(muted), 실패=비활성(에러색), 부분/없음=체크 활성.
  private applyRowState(row: FolderRow): void {
    const check = row.checkEl, badge = row.badgeEl;
    if (!check || !badge) return;
    badge.removeClass("is-error"); badge.removeClass("is-muted"); // 상태는 배타적 — 남은 클래스가 섞이지 않게
    check.closest(".nanalstamp-fc-row")?.toggleClass("is-locked", row.failed || row.status.state === "done");
    if (row.failed) {
      check.checked = false; check.disabled = true;
      badge.setText(t.folderCreateLoadFail); badge.addClass("is-error");
    } else if (row.status.state === "done") {
      check.checked = true; check.disabled = true;
      badge.setText(`${t.folderStateDone} ✓`); badge.addClass("is-muted");
    } else if (row.status.state === "partial") {
      check.disabled = false;
      badge.setText(t.folderStatePartial(row.status.existing, row.status.total));
    } else {
      check.disabled = false;
      badge.setText(t.folderStateNone);
    }
  }

  private updateMakeEnabled(): void {
    if (!this.makeBtn) return;
    const any = this.rows.some((r) => r.checkEl && !r.checkEl.disabled && r.checkEl.checked);
    this.makeBtn.disabled = !any;
  }

  /// 체크된(미완료) 항목의 미존재분만 생성 → 행 상태 재판정·완료 갱신·체크 해제.
  private async make(): Promise<void> {
    const targets = this.rows.filter((r) => !r.failed && r.checkEl && !r.checkEl.disabled && r.checkEl.checked);
    if (!targets.length) return;
    let touchedProject = false;
    for (const row of targets) {
      await this.plugin.materializeFolders(row.folders, row.files);
      if (row.kind === "project") touchedProject = true;
    }
    // 재판정은 **전부 만든 뒤 한 번**의 vault 스냅샷으로 한다. 행마다 getAllLoadedFiles()를 다시
    // 돌면 대상 N개에 N번(대형 vault에서 수만 항목 × N)이고, 결과는 최종 상태와 같다 —
    // 행끼리 경로가 겹쳐도(팀 루트와 과제 루트의 공통 조상) 마지막 스냅샷이 모두를 반영한다.
    const existing = new Set<string>(this.app.vault.getAllLoadedFiles().map((f) => f.path));
    for (const row of targets) {
      row.status = folderStatus(row.allPaths, existing);
      if (row.checkEl) row.checkEl.checked = false;
      this.applyRowState(row);
    }
    this.updateMakeEnabled();
    if (touchedProject) void this.plugin.syncProjectNotes(); // 방금 만든 템플릿 노트도 즉시 귀속(구 createKitFolders 계승)

    // 할 일이 남지 않았으면 **닫는다.**
    //
    // 예전에는 완료 뒤에도 모달이 떠 있었다. 버튼은 disabled 인데 색이 그대로라 눌리는 것처럼
    // 보였고, 눌러도 아무 일이 없으니 "안 먹는다"로 읽혔다(2026-07-31 사용자 지적).
    // 다 만들었으면 남은 행동은 닫는 것뿐이다 — 그 한 번을 사람에게 시킬 이유가 없다.
    //
    // 남은 것이 있으면(일부만 체크했거나 킷을 못 받아 실패한 행) 열어 둔다 — 아직 할 일이 있다.
    const done = this.rows.every((r) => r.failed || r.status.state === "done");
    if (done) {
      new Notice(t.folderCreateDone(targets.length));
      this.close();
    }
  }
}

// ── 업무 수정 모달(2026-07-29) — 접수 뒤에도 우선순위·기간·과제·비고를 고친다 ──────
//
// **수정이 봉인된다**는 것을 화면에서 먼저 말한다. 접수된 업무를 뒤늦게 고치는 일은 실제로
// 늘 일어나지만, 그것이 조용히 되면 업무함이 증거로 못 쓰인다. 서버는 바뀐 필드만
// `필드:이전>이후`로 요약해 원장에 봉인하고, 여기서는 그 사실을 미리 고지한다.
//
// 담당자 변경은 같은 창에 두되 **별도 동작**이다 — 필드 교체가 아니라 상태를 되돌리는
// 전이(reassign)라, 저장 버튼과 섞으면 무슨 일이 일어나는지 알 수 없게 된다.
export class TaskEditModal extends NanalModal {
  private priority: string;
  private startDate: string;
  private due: string;
  private memo: string;
  private projectId: string;
  private assignee: string;          // 재배정 대상(현재 담당자로 프리필)
  private roster: RosterMember[] = [];
  constructor(app: App, private plugin: NanalStampPlugin, private task: TaskItem, private onDone: () => void) {
    super(app);
    this.priority = task.priority;
    this.startDate = task.startDate ?? "";
    this.due = task.dueDate ?? "";
    this.memo = task.memo ?? "";
    this.projectId = task.projectId ?? "";
    this.assignee = task.assigneeUid ?? "";
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: t.taskEditTitle });
    contentEl.createEl("p", { cls: "nanalstamp-m-subject", text: this.task.title });
    contentEl.createEl("p", { cls: "nanalstamp-m-note", text: t.taskEditNote });

    new Setting(contentEl).setName(t.taskFieldPriority).addDropdown((dd) => {
      for (const p of ["now", "week", "ref"]) dd.addOption(p, t.taskPriLabel[p]);
      dd.setValue(this.priority);
      dd.onChange((v) => (this.priority = v));
    });
    new Setting(contentEl).setName(t.taskFieldStart).addText((tx) => {
      (tx.inputEl).type = "date";
      tx.setValue(this.startDate);
      tx.onChange((v) => (this.startDate = v));
    });
    new Setting(contentEl).setName(t.taskFieldDue).addText((tx) => {
      (tx.inputEl).type = "date";
      tx.setValue(this.due);
      tx.onChange((v) => (this.due = v));
    });
    new Setting(contentEl).setName(t.taskFieldProject).addDropdown((dd) => {
      dd.addOption("", t.taskProjectNone);
      for (const p of this.plugin.teamProjects) dd.addOption(p.id, p.code ? `${p.name} (${p.code})` : p.name);
      dd.setValue(this.projectId);
      dd.onChange((v) => (this.projectId = v));
    });
    new Setting(contentEl).setName(t.taskFieldMemo).addText((tx) => {
      tx.setPlaceholder(t.taskMemoPlaceholder);
      tx.setValue(this.memo);
      tx.onChange((v) => (this.memo = v));
      tx.inputEl.addClass("nanalstamp-input-full");
    });

    // 담당자 변경 — 팀 업무(담당자가 있는 것)에서만. 개인 업무엔 담당 개념이 없다.
    if (this.task.assigneeUid) {
      const re = new Setting(contentEl).setName(t.taskReassignName).setDesc(t.taskReassignDesc);
      re.settingEl.addClass("nanalstamp-m-stack");
      re.addDropdown((dd) => {
        dd.addOption(this.assignee, t.taskLoading);
        void this.plugin.fetchTaskRoster().then((ms) => {
          this.roster = ms ?? [];
          dd.selectEl.empty();
          for (const m of this.roster) dd.addOption(m.userId, rosterLabel(m));
          dd.setValue(this.assignee);
        });
        dd.onChange((v) => (this.assignee = v));
      });
      re.addButton((b) => b.setButtonText(t.taskReassignBtn).setDestructive().onClick(() => void this.reassign()));
    }

    const actions = new Setting(contentEl).addButton((b) =>
      b.setButtonText(t.taskEditSave).setCta().onClick(() => void this.save()));
    actions.settingEl.addClass("nanalstamp-m-actions");
  }

  private async save(): Promise<void> {
    const r = await this.plugin.taskPatch(`/attest/team/tasks/${encodeURIComponent(this.task.id)}`, {
      priority: this.priority,
      start_date: this.startDate || null,
      due_date: this.due || null,
      memo: this.memo,
      project_id: this.projectId,
    });
    if (!r) return;
    // 서버가 "정말 바뀐 게 있었는지"를 판정한다 — 화면이 짐작하지 않는다.
    new Notice(r.amended
      ? t.taskEditSaved.replace("{n}", String(r.seal_seq ?? "—"))
      : t.taskEditNoChange);
    if (r.amended) void this.plugin.refreshTaskSealSummary();
    this.close();
    this.onDone();
  }

  private async reassign(): Promise<void> {
    if (!this.assignee || this.assignee === this.task.assigneeUid) { new Notice(t.taskEditNoChange); return; }
    const r = await this.plugin.taskPost(`/attest/team/tasks/${encodeURIComponent(this.task.id)}/reassign`,
      this.due ? { assignee_uid: this.assignee, due_date: this.due } : { assignee_uid: this.assignee });
    if (!r) return;
    new Notice(t.taskReassignDone);
    void this.plugin.refreshTaskSealSummary();
    this.close();
    this.onDone();
  }
  onClose() { this.contentEl.empty(); }
}

// ── 팀 폴더 충돌 처리 팝업(2026-08-06) ─────────────────────────────────────
// 자동 적용이 멈추는 유일한 순간(이름 충돌)을 **그 자리에서 처리**한다. 리본의 수동
// 「팀 폴더 만들기」 메뉴는 없앴다 — 평상시엔 자동이 다 하고, 사람이 필요할 때는 메뉴를
// 찾아 들어오게 하는 게 아니라 팝업이 온다(사용자 결정). 이름을 바꾸면 그 자리에서
// 자동 적용을 다시 돌려 팀 폴더가 만들어진다. 폴더 안 내용·링크는 renameFile이 보존한다.
export class FolderConflictModal extends NanalModal {
  constructor(app: App, private plugin: NanalStampPlugin, private conflicts: string[]) { super(app); }

  onOpen(): void {
    this.render();
  }
  onClose(): void { this.contentEl.empty(); }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: t.fcfTitle });
    contentEl.createEl("p", { text: t.fcfDesc, cls: "setting-item-description" });
    const existing = new Set<string>(this.app.vault.getAllLoadedFiles().map((f) => f.path));
    for (const path of this.conflicts) {
      const row = contentEl.createDiv({ cls: "nanalstamp-fcf-row" });
      row.createDiv({ text: path, cls: "nanalstamp-fcf-path" });
      const input = row.createEl("input", { attr: { type: "text" } });
      input.value = conflictRenameSuggestion(path, existing, t.fcfSuffix);
      const btn = row.createEl("button", { text: t.fcfRename });
      btn.addEventListener("click", () => void this.rename(path, input.value.trim(), row));
    }
    const foot = contentEl.createDiv({ cls: "nanalstamp-fcf-foot" });
    foot.createDiv({ text: t.fcfLaterHint, cls: "setting-item-description" });
    const later = foot.createEl("button", { text: t.fcfLater });
    later.addEventListener("click", () => this.close());
  }

  private async rename(from: string, to: string, row: HTMLElement): Promise<void> {
    const af = this.app.vault.getAbstractFileByPath(from);
    if (!af || !to || to === from || this.app.vault.getAbstractFileByPath(to)) {
      new Notice(t.fcfRenameFail);
      return;
    }
    try {
      // fileManager.renameFile — 내부 링크까지 갱신하는 공식 경로(vault.rename은 링크를 깨뜨린다).
      await this.app.fileManager.renameFile(af, to);
    } catch {
      new Notice(t.fcfRenameFail);
      return;
    }
    new Notice(t.fcfRenamed(from, to));
    this.conflicts = this.conflicts.filter((c) => c !== from);
    row.remove();
    if (this.conflicts.length === 0) {
      new Notice(t.fcfAllDone);
      this.close();
      // 그 자리에서 자동 적용 재실행 — 다음 폴링(5분)을 기다리게 하지 않는다.
      void this.plugin.applyTeamFoldersNow();
    }
  }
}
