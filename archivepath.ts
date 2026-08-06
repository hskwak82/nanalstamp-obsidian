// archivepath.ts — 아카이브 폴더 이름 규칙(순수 함수). obsidian·Node 를 쓰지 않는다.
//
// 왜 vault 이름을 넣나: 기본값이 기기당 하나(~/nanalStamp-archive)이면 한 기기에서 vault 를
// 둘 쓰는 사람은 손대지 않는 한 두 vault 가 같은 repo 를 쓴다. 원문이 섞이지는 않지만
// (파일명이 경로 해시라 충돌이 드물다) **다른 vault 의 폴더·파일명이 대시보드에 그대로 보인다** —
// 연구노트가 기밀인 제품에서 그 자체로 문제다(2026-07-31 실측: e2e vault 에서 실 vault 노트
// 1,429건이 "삭제됨"으로 떴다).

const BASE = "nanalStamp-archive";
// 폴더명 상한 — 파일시스템(255바이트)보다 넉넉히 아래로. 한글은 UTF-8 로 3바이트다.
const MAX_LEN = 80;

/// vault 이름으로 아카이브 폴더 이름을 만든다. 경로 문자는 지운다 —
/// vault 이름에 `/`·`..` 가 들어오면 아카이브가 엉뚱한 곳에 생긴다.
/// 이름을 못 얻으면(빈 값) **옛 기본값 그대로** 돌려준다: 새 폴더를 만들지 않는다.
export function archiveDirNameForVault(vaultName: string): string {
  const cleaned = (vaultName || "")
    .replace(/[/\\:*?"<>|]+/g, "-")   // 경로·금지 문자 → 하이픈
    .replace(/\.+/g, "")               // 상위 이동(..) 제거
    .replace(/^[-\s]+|[-\s]+$/g, "")   // 양끝 하이픈·공백
    .trim();
  if (!cleaned) return BASE;
  const room = MAX_LEN - BASE.length - 1;
  return `${BASE}-${cleaned.slice(0, room)}`;
}
