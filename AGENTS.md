

<!-- openui:start -->
## Mandatory OpenUI workflow

When a task asks for any of the following, use the `openui` skill before editing implementation files:
- landing page
- homepage
- marketing page
- hero page
- design concept page
- multiple landing-page variants
- high-concept page generation

## Required process

1. Before generating page code, create or replace `/design.md` at the repository root.
2. `design.md` is mandatory and is the source of truth for implementation.
3. Never leave unresolved placeholders such as `[Topic]` or `[Offer]` inside `design.md`.
4. If the user omitted inputs, resolve them first and write concrete values into `design.md`.
5. If the user explicitly fixed an input, preserve it.
6. If the user asked for multiple variants:
   - create one section per variant in `design.md`
   - resolve inputs independently for each variant
   - do not copy one variant's input set into another
   - a variant is invalid if it differs only by palette, copy polish, spacing, or superficial decoration
   - each variant must represent a materially different concept direction
   - each variant must define a distinct composition contract, not only distinct copy
7. After `design.md` is written, implement the page variants one by one in the same order they appear in `design.md`.
8. For four or more variants, implement and inspect variants in batches of at most three before continuing.
9. Do not invent proof assets, fake metrics, fake testimonials, fake logos, or fake screenshots.
10. Keep support highlights in one lower support cluster only.
11. Do not use cardified hero layouts, floating sub-surfaces, or generic SaaS dashboard patterns unless the topic explicitly requires that artifact.
12. Before final response, compare all variants together and revise any that feel weaker, repetitive, or merely reskinned.

## Multi-Variant Quality Gates

For four or more variants:

- Add a composition contract for every variant in `design.md`: hero archetype, first-viewport structure, primary visual/proof artifact, interaction behavior, and reuse boundary.
- Work in implementation batches of at most three variants.
- Before each batch, reread the relevant `design.md` sections.
- After each batch, visually inspect desktop and mobile screenshots for every route in the batch before continuing.
- Shared CSS, JS, components, or templates are allowed only for infrastructure such as resets, routing, navigation, basic accessibility helpers, and small utilities.
- Do not implement a large multi-variant request as one generic data-driven page renderer unless each variant still has a custom hero composition, custom visual/proof artifact, and custom interaction behavior.
- Do not let later variants become "same layout plus different copy."
- Ensure the first viewport shows the dominant hero and a hint of the next section on common desktop and mobile sizes unless the user explicitly requests a full-screen hero.

Final comparative gate:

- Review all variants side by side or in a fast route sweep.
- Confirm each variant has a distinct first impression, composition, visual/proof artifact, and interaction behavior.
- Revise later variants if they have degraded into thinner versions of earlier variants.

## Implementation policy

- For a single HTML deliverable, prefer `index.html`.
- For multiple HTML variants, prefer:
  - `variants/variant-01/index.html`
  - `variants/variant-02/index.html`
  - `variants/variant-03/index.html`
- For a single React deliverable, prefer one component file in the existing project structure.
- For multiple React variants, create one component per variant with clear naming.

Do not start implementation until `design.md` is complete.
<!-- openui:end -->


<!-- project-ui-workflow:start -->
## 모든 기존·신규 프로젝트의 UI 작업 기본 지침

이 지침은 이 사용자의 기존 프로젝트와 앞으로 만들 프로젝트 모두에 적용한다.
UI가 있는 작업에서는 서비스와 실제 콘텐츠에 맞게 적용한다. 백엔드·CLI·학습 자료에
랜딩 페이지를 임의로 추가하지 않는다. 문서 적용만 요청한 작업을 배포 권한으로 해석하지 않는다.
기존 AGENTS.md, 기술 스택, 브랜드, API, 인증, 화면 이동, 사용자 변경사항을 보존한다.
프로젝트별 명시 지침과 사용자의 현재 요청을 우선하며 불필요한 마이그레이션을 하지 않는다.

### 코드보다 먼저 조사와 계획

1. Git 상태·브랜치·원격, README, 패키지와 실행 명령, 라우팅, 메인 화면, 공통 컴포넌트,
   스타일 토큰, 자산, API·폼·인증 연결을 읽는다. 목적, 주요 사용자, 첫 행동을 실제 근거로 파악한다.
2. 랜딩·홈·마케팅·히어로 화면을 만들거나 개선할 때는 `openui` 스킬의 SKILL.md를 읽고
   OpenUI 워크플로를 적용한다. 설치되어 있지 않으면 공식 저장소의 현재 README와
   플러그인 구조를 확인해 지원되는 스킬 방식으로 준비한다.
   원본: https://github.com/IamJimtheFish/openui
3. 구현 전에 저장소 루트의 `design.md`를 작성한다. 기존 문서의 관련 없는 계획은 보존하고
   이번 범위를 갱신한다. 기본 결과는 완성된 디자인 1개이며 사용자가 다른 수를 요청하면 따른다.
4. 일반적인 디자인 선택은 직접 판단한다. 소스나 서비스 목적이 없으면 이를 지어내지 말고
   확인된 사실과 필요한 입력을 기록한다. 예시 수치·가상 리뷰로 빈 근거를 채우지 않는다.

### design.md 필수 내용

- 서비스 목적, 주요 사용자, 현재 화면의 문제와 코드·콘텐츠 근거
- 첫 화면 핵심 메시지, 최우선 행동, 주·보조 CTA 문구와 실제 목적지 또는 처리 함수
- OpenUI resolved inputs: Topic, Offer, Audience, Primary user action, Deliverable,
  Style direction, Tonal key, Icon policy, Proof assets, Motion intensity
- Composition contract: hero archetype, first-viewport structure, primary visual/proof artifact,
  interaction behavior, reuse boundary
- 한 가지 디자인 방향과 구체적인 색상 역할·값, 폰트·대체 폰트, 글자 크기·두께·줄 높이,
  간격·콘텐츠 폭·정렬·반경·테두리 기준. 기존 토큰이 있다면 먼저 재사용한다.
- 첫 화면과 이후 필요한 섹션의 콘텐츠·구성·목적, 모바일 배치와 탐색 방식
- 실제 확보한 이미지·아이콘, 대체 텍스트, 인터랙션과 reduced-motion 처리
- 실제 수정 경로, 유지해야 할 기능·API 계약, 실행·검증 계획
- OpenUI의 master prompt를 해당 서비스의 확정 값으로 채운 내용과 output target

### 참고 자료를 적용하는 방법

- Taste Skill: https://www.tasteskill.dev/ — 서비스 고유의 콘텐츠에서 시각 방향을 찾고,
  타이포그래피·여백·섹션 구성에 의도를 담는다. 기존 브랜드를 무조건 바꾸거나
  모든 서비스를 같은 카드·그라데이션 템플릿으로 만들지 않는다.
- SEED 브랜딩: https://seed-design.io/updates/why-design-system-needs-branding —
  서비스의 가치와 시각 언어를 연결한다. 당근·SEED 로고나 화면을 복제하지 않는다.
- SEED Foundations: https://seed-design.io/foundations — 색상·타입·간격·레이아웃·상태를
  일관된 역할과 토큰으로 관리한다. 모든 프로젝트에 특정 색상이나 숫자를 강제하지 않는다.
- SEED Skill: https://seed-design.io/ai-integration/skill — SEED를 실제 사용하는 프로젝트의
  구현·설치·진단은 공식 스킬과 최신 문서로 확인한다. 참조만을 이유로 SEED로 이전하지 않는다.
- Emil Kowalski: https://github.com/emilkowalski/skills — 필요한 조작 피드백에만 모션을 쓰고,
  목적에 맞는 속도·이징·중단 동작을 선택한다. 터치에 hover를 강제하지 않는다.
- 자료의 현재 내용이 필요한 작업은 공식 원문을 확인한다. 서로 다른 스타일 지침이 충돌하면
  사용자 요청·기존 제품 맥락·가독성·접근성·OpenUI 작업 순서를 우선해 선택을 기록한다.

### 구현 품질

- design.md를 기준으로 기존 스택과 컴포넌트 구조에서 실제 코드를 완성한다.
- 서비스 설명, 제목, 본문, CTA의 위계를 명확히 한다. 각 섹션은 콘텐츠에 맞게 설계한다.
- 사용자 수, 성과, 가격, 리뷰, 고객 로고, 스크린샷, API 응답과 공식 연동을 만들어내지 않는다.
- 모든 버튼·링크를 실제 동작에 연결한다. 기존 API·인증·폼·검색·필터·상세 이동을 보존한다.
- 실제 데이터의 loading·empty·error·success 상태를 다루고 실패 원인과 다음 행동을 설명한다.
- 의미 있는 HTML, 폼 레이블, 대체 텍스트, 적절한 대비와 보이는 키보드 포커스를 제공한다.
- 한국어에는 적절한 keep-all과 안전한 긴 문자열 줄바꿈을 사용하고 flex/grid 자식의
  min-width: 0 등으로 축소를 허용한다. 넘침을 숨기거나 글씨를 과도하게 줄여 해결하지 않는다.
- 모바일 주요 조작 영역은 보통 44 CSS px 이상 확보하고 고정 요소·safe area를 확인한다.
- 모션은 화면 이해·상태 전달·조작 피드백에 필요할 때 사용하고 reduced-motion을 존중한다.

### 실행과 완료 검증

1. 변경에 필요한 최소 빌드·타입·테스트를 수행하고 실패를 고친다.
2. 가능한 환경에서 앱을 실행하고 브라우저에서 실제 화면을 연다.
3. 360×800, 390×844, 1440×900과 레이아웃이 바뀌면 768×1024를 확인한다.
   PC·모바일 스크린샷을 직접 보고 겹침, 가로 넘침, 줄바꿈, 이미지 비율, 고정 요소를 수정한다.
4. 주요 CTA·메뉴·라우팅·폼과 연결된 API 흐름을 확인한다. Tab·Shift+Tab·Enter·Space와
   필요한 Escape 동작, 포커스 표시·복귀를 확인한다. 콘솔 오류·실패 요청을 점검한다.
5. 실제 확인한 환경·명령·결과와 미확인 항목을 구분해 보고한다. 빌드 성공만으로 기능·반응형
   검증이 끝났다고 하지 않는다. 비밀값은 문서·콘솔·보고서에 남기지 않는다.
6. 배포는 해당 요청과 기존 정책의 범위에서 진행한다. Coders.kr에 연결되거나 배포를 요청한
   경우 기존 Coders.kr 정책의 upstream → fork 동기화 → 배포 → 운영 검증 순서를 지킨다.
<!-- project-ui-workflow:end -->
