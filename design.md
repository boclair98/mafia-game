# OpenUI Design Plan

## Variant 1

### Resolved inputs
- Topic: 검은 자정 실시간 추리 게임
- Offer: 친구 또는 AI와 역할·토론·투표로 진행하는 추리 게임
- Audience: 설치 없이 첫 사건을 시작하려는 플레이어
- Primary user action: 기존 onPlay(first/party), onGuide, onJoin을 통한 시작과 참가
- Deliverable: 기존 프로젝트의 실제 홈페이지·컴포넌트와 스타일; 기술 스택 유지
- Style direction: 기존 수사실 이미지와 붉은 포인트의 어두운 사건 파일
- Tonal key: 기존 제품의 실제 브랜드와 사용 환경에 맞춤
- Icon policy: 기존 아이콘·자산 유지; 새 장식 아이콘 불필요
- Proof assets: 기존의 실제 자산·데이터만 보존; 새로운 증거·성과·후기는 없음
- Motion intensity: Minimal; 기능 이해와 피드백만, reduced-motion 존중

### Composition contract
- Hero archetype: immersive
- First-viewport structure: MidnightLanding은 초대 링크, 실제 접속 인원, 플레이 모드, 역할 설명을 기존 콜백으로 연결한다. 몰입형 이미지는 보존하며 제목·본문·게임 시작의 대비와 터치 크기를 높인다. 모바일에서 장면 라벨과 CTA가 겹치지 않게 흐름을 확보하고 역할 버튼은 의도적으로 가로 탐색한다.
- Primary visual/proof artifact: 현재 제품의 실제 인터페이스·제공된 자산 또는 타이포그래피; 임의 지표 없음
- Interaction behavior: 기존 onPlay(first/party), onGuide, onJoin을 통한 시작과 참가
- Reuse boundary: 현재 라우트·상태·폼·인증·API·실제 데이터 구조를 유지하고 output target의 화면 표현만 수정

### 서비스와 코드 근거
MidnightLanding은 초대 링크, 실제 접속 인원, 플레이 모드, 역할 설명을 기존 콜백으로 연결한다. 몰입형 이미지는 보존하며 제목·본문·게임 시작의 대비와 터치 크기를 높인다. 모바일에서 장면 라벨과 CTA가 겹치지 않게 흐름을 확보하고 역할 버튼은 의도적으로 가로 탐색한다.

### 디자인 기준과 구현 범위
기존 midnight-landing.css 토큰 보존; h1 PC64~80/mobile40~48px/1.2, 본문17px/1.75, 버튼52px. 간격8·12·16·24·32·48·64px를 기존 리듬에 맞춰 쓰고 모바일 좌우20px, PC 콘텐츠 폭1120~1440px를 유지한다. 유연한 자식 min-width:0, 긴 한국어 keep-all과 안전한 overflow-wrap, 명확한 focus-visible, 링크·폼 레이블, 모바일 safe area를 확인한다. 프로젝트에 이미 있는 구체적인 토큰을 우선하며 모든 서비스를 같은 템플릿으로 만들지 않는다.

### 실행과 검증 계획
기존 패키지 스크립트의 빌드·타입·핵심 테스트를 실행한다. 앱을 띄워 1440×900, 768×1024, 390×844, 360×800의 실제 브라우저 화면을 확인하고 버튼·탭·라우팅·키보드 포커스·가로 넘침·오류 상태를 점검한다. 실제 API·OAuth·기기·데이터 접근이 없는 검증은 미확인으로 기록하고 가짜 응답으로 성공을 주장하지 않는다.

### Filled generation prompt

Create one high-concept page for 검은 자정 실시간 추리 게임.

#### Inputs
- Topic: 검은 자정 실시간 추리 게임.
- Offer: 친구 또는 AI와 역할·토론·투표로 진행하는 추리 게임
- Audience: 설치 없이 첫 사건을 시작하려는 플레이어
- Primary user action: 기존 onPlay(first/party), onGuide, onJoin을 통한 시작과 참가
- Deliverable: 기존 프로젝트의 실제 홈페이지·컴포넌트와 스타일; 기술 스택 유지
- Style direction: 기존 수사실 이미지와 붉은 포인트의 어두운 사건 파일
- Tonal key: 기존 제품의 실제 브랜드와 사용 환경에 맞춤
- Icon policy: 기존 아이콘·자산 유지; 새 장식 아이콘 불필요
- Proof assets: 기존의 실제 자산·데이터만 보존; 새로운 증거·성과·후기는 없음
- Motion intensity: Minimal; 기능 이해와 피드백만, reduced-motion 존중

#### Objective
Design one premium, memorable page with a dominant hero and one coherent visual world derived from the topic itself.
The result should feel specific, intentional, and action-oriented when the concept calls for action, not like a generic startup or SaaS template.

Choose the strongest clear solution.
Do not collapse the concept into a simpler generic pattern just to make execution easier.

- Treat single-file execution as a packaging constraint, not a creative constraint.
Do not reduce conceptual ambition, visual specificity, interaction richness, or production quality merely because the deliverable is concise.

#### Internal concept choice
Before composing, decide internally:
- one dominant hero archetype: centered / asymmetrical / immersive
- one dominant proof mode: none / embedded gesture / single artifact
- one palette driver derived from the topic
- one tonal key: light / mid / dark / topic-derived
- one motion role: none / minimal / ambient / interactive
- one icon approach: none / minimal / expressive / topic-native
- optionally one secondary accent only if it strengthens the main direction without creating a second visual world
Do not output this planning.

#### Non-negotiables
- Use a strong hero-first composition.
- Headline: 3-12 words, max 3 lines.
- Supporting copy: 1-2 short sentences, concise and specific.
- CTAs are optional. If used, include at most 1 primary and 1 secondary CTA.
- If a clear next step is central to the offer or concept, include a CTA; otherwise CTA omission is allowed.
- CTA labels must be specific to the offer and action, not generic.
- Supporting highlights are optional. If used, show them only once in a single lower support cluster beneath the hero.
- Keep the hero dominant, focused, readable, and uncluttered.
- Proof is optional. Use it only if it clearly strengthens the concept.
- If no real proof assets are provided, do not invent metrics, testimonials, customer logos, screenshots, or fake UI proof.
- Prefer depth inside the hero, proof gesture, CTA behavior, support copy, or background logic rather than adding extra sections by default.

#### Composition
- Choose the clearest structure for the topic; do not default to generic two-column marketing layouts.
- A top navigation bar is optional. When used, make it native to the chosen style direction and subordinate to the hero rather than a generic boxed header.
- The hero may be fully integrated rather than framed.
- The hero does not need to become a panel, dashboard, device mockup, rounded card, or floating showcase unless the topic genuinely demands that artifact.
- Build hierarchy through scale, contrast, spacing, alignment, depth, rhythm, and composition before using frames, dividers, or containers.
- Keep supporting content clearly subordinate to the hero.
- Do not interpret structural restraint as permission to flatten the concept into a generic minimal layout.
- Do not use text-on-text layering, typographic collisions, or overlapping live text as a compositional device.

#### Visual system
- Build one coherent visual world derived from the topic itself.
- Let the topic drive palette, contrast, typography, spacing, geometry, motifs, materials, and motion.
- Even restrained palettes must feel intentional and specific, not generic premium-neutral.
- The background must actively contribute mood, depth, and topic logic.
- If the topic suggests a real system language, physical behavior, or interface grammar, show that directly instead of generic abstract-tech decoration.
- Treat headline typography as part of the concept, not neutral text.
- The headline may use topic-derived color, selective emphasis, multi-tone treatment, or gradient accents when they strengthen the concept and remain readable.
- Do not default the headline to neutral black, white, or near-white unless that is clearly the strongest topic-native choice.

#### Background and tonal diversity
- Premium and atmospheric design may be light, mid-tone, or dark; do not default to dark.
- Choose the tonal key from the topic, offer, audience, and style direction rather than from generic cinematic or tech aesthetics.
- Contrast may come from hue, saturation, temperature, texture, density, or scale, not only darkness.

#### Proof and concept expression
- Prefer the minimum visual evidence needed to make the idea feel specific, credible, and native to the topic.
- If the concept is strongest with typography, atmosphere, and one precise gesture, do that.
- If a stronger proof artifact is justified, use one legible, unified artifact rather than multiple fragmented panels.
- Proof may take the form of a signal, trace, contour, command line, path, specimen, structural mark, scene fragment, or other topic-native evidence.
- Typography itself may carry part of the concept or proof.
- When appropriate, use one precise typographic gesture—such as selective word emphasis, chromatic offset, gradient emphasis, distortion, signal breakup, or structural interruption—to make the concept feel more specific and alive.
- Prefer one strong typographic intervention over many scattered decorative effects.
- Avoid decorative pseudo-proof.
- Avoid turning simple ideas into framed showcases, dashboard fragments, floating panels, softened slabs, or generic marketing geometry.

#### Icons and symbolic language
- Icons are optional.
- Use icons only when they improve scanability, recognition, navigation, proof clarity, or support-cluster legibility.
- Prefer topic-native icon logic over generic startup glyphs.
- Keep icon style consistent in stroke weight, geometry, corner logic, and detail level.
- Use icons primarily in clearly secondary roles unless a single topic-native symbol is central to the concept.
- Do not let icons compete with the hero headline, proof artifact, or CTA hierarchy.

#### Support cluster
- If used, show supporting highlights only once, in a single lower cluster beneath the hero.
- Each highlight should be short, fast to scan, and clearly secondary.
- Supporting highlights may use concise icons or symbolic marks when helpful.
- Support-cluster elements may use subtle motion when it improves scanability, continuity, or atmosphere and remains clearly secondary.
- Card-like grouping is allowed only inside this lower support cluster.
- These modules may use at most one light surface treatment, such as a subtle stroke, tonal fill, or very soft shadow.
- Keep support modules uniform, non-nested, and visually subordinate.
- Do not use card-like structures in the hero, proof, CTA area, or elsewhere on the page.

#### Motion
- Motion is optional.
- Use motion only when it supports hierarchy, continuity, feedback, atmosphere, or topic logic.
- Default to none, minimal, or ambient motion depending on what the concept actually needs.
- Motion may live in typography, background behavior, proof logic, support-cluster behavior, or interaction feedback.
- A single key word or short phrase may use subtle text-based motion such as glitch, flicker, jitter, scanline shift, chromatic split, text scramble, pulse, or reveal if it strengthens the concept.
- Keep motion controlled, readable, non-blocking, and subordinate to clarity.
- Avoid scrolljacking, attention-hijacking loops, and ornamental animation.
- Respect reduced-motion preferences.

#### Accessibility and readability
- Preserve strong readability and clear hierarchy at all viewport sizes.
- Maintain sufficient contrast between text and background.
- Do not place essential text over busy imagery unless readability remains strong.
- Avoid cramped spacing, visual collisions, and weak focal hierarchy.
- Do not place badges, pills, annotations, stickers, or floating interface fragments over essential text.
- If the deliverable is code, use semantic HTML structure, visible focus states, keyboard-friendly interactions, and reduced-motion handling.
- When in doubt, preserve legibility over expressive overlap.

#### Anti-drift rules
- Do not drift into bland corporate SaaS styling.
- Do not default to dashboard aesthetics, feature-grid thinking, boxed-section composition, or template-like modularity.
- Do not use disconnected motifs, random color choices, or interchangeable abstract-tech shapes.
- Do not use card-within-card composition, nested surfaces, floating panels, fake proof, or stock-looking UI.
- Keep one visual world, one dominant hero, and one clear structural logic.
- Do not allow text, labels, or interface elements to overlap, collide, or sit on top of one another.

#### Output
Return only the final 기존 프로젝트의 실제 홈페이지·컴포넌트와 스타일; 기술 스택 유지.

If the deliverable is code:
- Output a complete production-ready file or component.
- Keep dependencies minimal unless explicitly requested.
- Make it responsive.
- Keep support highlights in one lower support cluster only when used.

#### Final self-check
Before returning, verify that the result keeps:
- one dominant hero
- one coherent visual world
- no invented proof
- no cardification outside the lower support cluster
- no generic SaaS drift
- no unnecessary structural fragmentation
- no nested containment
- no floating sub-surfaces
- all text clearly legible and comfortably spaced


### Output target
- Path: frontend/components/MidnightLanding.tsx
- Path: frontend/components/midnight-landing.css
