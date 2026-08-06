// fmtutil.ts — 날짜·시각 표기 순수 함수. main.ts에서 순수 이동(2026-07-26).
// 분리 이유는 i18n.ts와 같다: 모달군(taskmodals)이 fmtDate·fmtDateTime을 쓰는데
// main.ts에 남겨두면 main → taskmodals → main 값 순환 참조가 된다.
// dashcore.ts에도 동명의 pad2가 있으나 그쪽은 독립 순수 모듈이라 건드리지 않는다.

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
export function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
export function fmtDateTime(d: Date): string {
  return `${fmtDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
// 점검 서명 시각 표기 — np-verify와 동일한 UTC 포맷("YYYY-MM-DD HH:MM:SS UTC").
// 비숫자(변조 번들 등)면 new Date(NaN)이 RangeError를 던지므로 "—"로 방어.
export function fmtUtc(unixSec: number): string {
  return Number.isFinite(unixSec) ? new Date(unixSec * 1000).toISOString().slice(0, 19).replace("T", " ") + " UTC" : "—";
}
