# 세찬 해피콜 관리시스템 V14 Reviewer Store / Refusal

## 반영
- 관리자 직원관리에서 검수자별 검수 가능 매장 설정
- 검수자는 지정된 매장 건만 검수 화면에 표시
- 반려 건이 직원 리스트에는 보이지만 수량이 0으로 뜨던 문제 수정
  - 반려는 미완료 수량에 포함
  - 반려 수량은 review_status='반려' 기준
- 통화거부 저장 시 refused_customers 테이블에 등록
- 통화거부 고객은 이후 해피콜 생성 대상에서 제외
- 관리자 기록 메뉴에 통화거부 고객 리스트 추가

## 별도 SQL 필요
- reviewer_store_permissions 테이블
- refused_customers 테이블

## 기존 기능 회귀검사
- 내 해피콜
- 검수
- 전체 해피콜
- 감사로그
- 직원별 현황
- 직원관리
- 매장관리
- RAW 업로드
- 해피콜 생성
- 사용방법
- 근무이력 수정/삭제
- D+95/D+185 점장 배정
- happycall_targets delete 제거
- npm build 검증
