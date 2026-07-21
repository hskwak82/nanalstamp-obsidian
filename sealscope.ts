// sealscope.ts — 봉인 대상 판정의 순수 로직(Obsidian/Node 비의존, node:test로 검증).
// main.ts가 TFile.extension / TFile.stat.size / 설정을 넘겨 판정만 위임한다.

// 봉인 대상 파일인가. .md는 항상 대상. 첨부는 확장자와 무관하게 "범위 내 노트가 참조하는가"로 판정한다
// (증명 제품에서 노트만 봉인되고 참조 첨부가 형식 때문에 빠지면 원본이 불완전 — 반대로 참조 없는 잡파일은
//  원장 노이즈라 제외). isReferenced 계산은 호출자(main.ts referencedAttachments) 책임.
export function isSealableFile(ext: string, sealAttachments: boolean, isReferenced: boolean): boolean {
  if ((ext || "").toLowerCase() === "md") return true;
  return sealAttachments && isReferenced;
}

// 경로가 마크다운 노트(.md)인가. beaconDirty처럼 TFile 없이 경로 문자열만 있을 때 쓴다.
// 첨부는 바이트 해시가 필요해 텍스트 경로(utf8)로 처리하면 해시가 손상되므로 .md만 걸러낸다.
export function isMarkdownPath(path: string): boolean {
  return /\.md$/i.test(path);
}

// 크기 상한 초과 여부(상한은 MiB). 0 이하 = 무제한(항상 통과). 경계값은 통과(초과만 스킵).
export function isOverSizeLimit(sizeBytes: number, maxMB: number): boolean {
  if (!(maxMB > 0)) return false;
  return sizeBytes > maxMB * 1024 * 1024;
}
