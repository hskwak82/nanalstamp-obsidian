// 번들 전용 서드파티 모듈의 최소 타입 선언(공식 @types 미사용).
declare module "qrcode" {
  export function toDataURL(text: string, opts?: { margin?: number; width?: number }): Promise<string>;
}
