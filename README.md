# 세찬컴퍼니 인트라넷 V29.44

## 기준 버전
- V29.43 설치 완료 기준

## 반영 내용
- 실제 실행 파일을 `src/main-v2944.jsx`로 통일
- `index.html`이 위 실행 파일만 불러오도록 경로 일치
- 프로젝트 전체에서 정의되지 않은 `diagnostic` 및 `setDiagnostic` 직접 참조 제거 확인
- 해피콜 생성 탭의 진단 상태는 `diagnosticResult` / `setDiagnosticResult`만 사용
- 프리패스 로그 코드 문법 정상 여부 확인
- 기존 해피콜 생성·저장·배정 기준은 변경하지 않음

## QA
- `diagnostic` 미정의 직접 참조 검색: 0건
- `setDiagnostic` 미정의 직접 참조 검색: 0건
- Vite 실제 production build: PASS
- 실행 진입 파일 경로 일치: PASS
- ZIP / README / version.json / 화면 버전: V29.44 일치
- SQL 작업 없음

## 설치 시 주의
- ZIP 안의 파일과 `src` 폴더를 저장소 최상단에 그대로 업로드하세요.
- 이전 `src/main-v2943.jsx`가 남아 있어도 `index.html`은 새 `src/main-v2944.jsx`만 실행합니다.
