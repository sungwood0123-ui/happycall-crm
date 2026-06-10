# 세찬 해피콜 관리시스템 V9.4 No Target Mutation

## V9.4 FK 오류 최종 방지
- happycall_targets delete/update/upsert 완전 금지
- 기존 대상은 조회 후 건너뜀
- 신규 대상만 insert
- happycall_logs가 연결된 기존 대상 절대 수정/삭제하지 않음
- FK 오류 방지 목적
- V9 직원별 현황 / 감사로그 기능 유지

## 핵심 원칙
happycall_targets는 한 번 생성되면 통화/검수 기록 보호를 위해 삭제/갱신하지 않습니다.
