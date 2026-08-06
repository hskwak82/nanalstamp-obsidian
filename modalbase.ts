// modalbase.ts — 플러그인 모달 전체의 공통 바닥(2026-07-29).
//
// 두 가지를 여기서 한 번에 고친다. 모달마다 따로 붙이면 새 모달을 만들 때 빠뜨린다.
//
// 1) **바깥을 눌러도 닫히지 않는다.** Obsidian 기본은 배경 클릭 = 닫기다. 업무 상세처럼
//    회신을 쓰는 창에서는 옆을 한 번 잘못 누르는 것으로 입력이 통째로 날아간다.
//    닫기는 [닫기] 버튼·X·Esc — **사용자가 닫겠다고 한 동작**으로만 이뤄져야 한다.
// 2) **뒤가 비치지 않는다.** 기본 배경은 opacity 0.85 × alpha 0.4 = 실효 0.34라
//    아래 표의 글자가 그대로 읽힌다. 어디까지가 모달인지 눈으로 구분되지 않는다.
//    실제 어둡기와 테두리는 styles.css(.nanalstamp-modal-container)에서 준다.
//
// 상속만 바꾸면 되도록 constructor에서 처리한다 — 각 모달이 이미 super(app)을 부르므로
// onOpen에 super 호출을 넣는 방식(빠뜨리기 쉬운)보다 안전하다.

import { App, Modal } from "obsidian";

export class NanalModal extends Modal {
  constructor(app: App) {
    super(app);
    this.containerEl.addClass("nanalstamp-modal-container");
    // 캡처 단계에서 삼켜 Obsidian 기본 핸들러까지 가지 않게 한다. 배경 위에서 눌렀을 때만.
    // mousedown까지 막는 이유: 배경에서 누르고 모달 안에서 떼는 드래그도 닫기로 잡힐 수 있다.
    const swallow = (ev: Event) => {
      const t = ev.target as HTMLElement | null;
      if (t && (t === this.containerEl || t.classList?.contains("modal-bg"))) {
        ev.stopPropagation();
        ev.preventDefault();
      }
    };
    this.containerEl.addEventListener("mousedown", swallow, true);
    this.containerEl.addEventListener("click", swallow, true);
  }
}

// 확인 모달 — 되돌릴 수 없는 조작 앞에 세운다.
//
// 왜 Modal 인가(2026-07-31): 여기 있던 것은 브라우저 `confirm()` 이었다. 그것은 **Electron
// 네이티브 대화상자**라 렌더러 프로세스를 통째로 세운다. 실측하면 앱이 응답을 멈추고, 자동화는
// 물론이고 다른 창까지 함께 막힌다. Obsidian 스타일도 따르지 않고, 모바일에서는 나타나는
// 모양이 플랫폼마다 다르다. 플러그인이 부를 자리가 아니다.
//
// 기본값은 **취소**다 — Esc·배경 클릭·창 닫기 전부 "하지 않음"으로 떨어진다.
export class ConfirmModal extends NanalModal {
  private decided = false;

  constructor(
    app: App,
    private opts: { title: string; body?: string; confirmText: string; cancelText: string; warning?: boolean },
    private onConfirm: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.opts.title });
    if (this.opts.body) contentEl.createEl("p", { text: this.opts.body, cls: "setting-item-description" });
    const row = contentEl.createDiv({ cls: "nanalstamp-confirm-btns" });
    const cancel = row.createEl("button", { text: this.opts.cancelText });
    cancel.onclick = () => this.close();
    const ok = row.createEl("button", { text: this.opts.confirmText });
    if (this.opts.warning) ok.addClass("mod-warning"); else ok.addClass("mod-cta");
    ok.onclick = () => { this.decided = true; this.close(); this.onConfirm(); };
    // 취소에 초점 — Enter 연타가 실행으로 이어지지 않게.
    window.setTimeout(() => cancel.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
    this.decided = false;
  }
}
