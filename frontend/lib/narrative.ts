import type { GameState, Phase } from "./game";

export type NarrativeChapter = {
  id: string;
  label: string;
  title: string;
  copy: string;
  phases: Phase[];
};

export type CaseNarrative = {
  codename: string;
  motif: string;
  prologue: string;
  chapters: NarrativeChapter[];
  phaseLines: Partial<Record<Phase, string>>;
  endings: {
    mafia: string;
    citizen: string;
    trickster: string;
  };
};

const COMMON_CHAPTERS: NarrativeChapter[] = [
  {
    id: "seal",
    label: "CHAPTER 01 · 봉인",
    title: "문이 잠기고, 이름이 사라졌다",
    copy: "모두가 같은 방에 있지만 아무도 같은 편이 아닙니다. 첫 번째 침묵이 사건의 방향을 정합니다.",
    phases: ["lobby", "reveal", "night"],
  },
  {
    id: "trace",
    label: "CHAPTER 02 · 흔적",
    title: "새벽은 거짓말보다 먼저 도착한다",
    copy: "현장에 남은 작은 흔적과 밤의 선택을 겹쳐 보세요. 단서는 범인을 좁히지만, 대신 결론을 내려주지 않습니다.",
    phases: ["dawn", "day"],
  },
  {
    id: "fracture",
    label: "CHAPTER 03 · 균열",
    title: "목소리 사이에 금이 가기 시작했다",
    copy: "누군가의 알리바이가 흔들리고, 누군가의 침묵이 증거처럼 보입니다. 지금의 말은 사건 파일에 남습니다.",
    phases: ["vote", "defense"],
  },
  {
    id: "verdict",
    label: "CHAPTER 04 · 판결",
    title: "마지막 표가 운명을 봉인한다",
    copy: "처형은 정답 버튼이 아닙니다. 마지막 변론과 기록을 함께 본 뒤 도시의 책임으로 판결하세요.",
    phases: ["verdict", "result", "gameover"],
  },
];

const NARRATIVES: Record<string, CaseNarrative> = {
  "hotel-404": {
    codename: "THE LAST NOTE",
    motif: "비가 멎은 뒤에도 404호의 현악기는 한 음을 놓지 않았다.",
    prologue: "백야 호텔 4층. 잠긴 객실 안에서 바이올리니스트 한서윤이 발견됐습니다. 문은 안에서 잠겼고, 출입 기록은 누군가의 손으로 다시 쓰였습니다.",
    chapters: COMMON_CHAPTERS,
    phaseLines: {
      night: "호텔의 복도등이 하나씩 꺼집니다. 누군가는 열쇠를 쥐고, 누군가는 숨을 고릅니다.",
      dawn: "새벽의 첫 음이 울렸습니다. 어젯밤 4분 동안 누가 사라졌는지 확인하세요.",
      day: "라운지의 시계가 다시 움직입니다. 연주가 끊긴 순간과 오늘의 진술을 비교하세요.",
      vote: "마지막 음을 끊을 사람을 고르세요. 표는 기록으로 남고, 변명은 다음 장면을 엽니다.",
      defense: "피고에게 마지막 무대가 주어졌습니다. 박수 대신 질문으로 진실을 확인하세요.",
      gameover: "호텔의 문이 열렸습니다. 이제 마지막 연주가 누구의 손에서 시작됐는지 복기합니다.",
    },
    endings: {
      mafia: "404호의 마지막 음은 끝났지만, 호텔의 어둠은 아직 손님들을 기억하고 있습니다.",
      citizen: "잠긴 문보다 서로의 기록을 믿은 사람들이 사건의 마지막 음을 되찾았습니다.",
      trickster: "가장 큰 거짓말은 범인이 아니라, 모두가 믿고 싶어 했던 결말이었습니다.",
    },
  },
  "night-train": {
    codename: "FOUR MINUTES TO TUNNEL",
    motif: "터널 안 4분, 열차는 달렸지만 시간은 멈춰 있었다.",
    prologue: "자정행 7호 열차가 터널에 들어간 순간, 탐사 기자 윤재하의 녹음기가 꺼졌습니다. 같은 객차에 있던 모두가 마지막 목격자입니다.",
    chapters: COMMON_CHAPTERS,
    phaseLines: {
      night: "열차가 터널로 들어갑니다. 창문에는 얼굴 대신 검은 반사만 남았습니다.",
      dawn: "터널을 빠져나왔지만 녹음기는 비어 있습니다. 누가 4분을 지웠는지 추적하세요.",
      day: "객차의 좌석 배치와 말의 순서가 서로 어긋납니다. 한 명씩 알리바이를 세워보세요.",
      vote: "다음 역에 도착하기 전, 가장 위험한 승객을 지목하세요.",
      defense: "열차 안내 방송이 피고의 마지막 말을 덮습니다. 짧은 진술 속 빈칸을 찾으세요.",
      gameover: "열차가 종착역에 도착했습니다. 지워진 4분의 진짜 주인이 밝혀집니다.",
    },
    endings: {
      mafia: "열차는 종착역에 도착했지만, 범인은 승객 명단에서 조용히 빠져나갔습니다.",
      citizen: "승객들의 기억이 하나의 시간표가 되어 지워진 4분을 복원했습니다.",
      trickster: "열차에서 가장 먼저 내린 것은 진실이 아니라, 모두의 확신이었습니다.",
    },
  },
  "black-wing": {
    codename: "THE FORGED LABEL",
    motif: "정전 뒤, 진짜 그림보다 가짜 작품표가 더 선명하게 남았다.",
    prologue: "아르카 미술관의 전시실이 90초 동안 어두워졌습니다. 불이 돌아왔을 때 수석 큐레이터 차유진은 사라졌고, 벽에는 위조된 작품표만 남아 있었습니다.",
    chapters: COMMON_CHAPTERS,
    phaseLines: {
      night: "전시실의 조명이 모두 꺼집니다. 어둠 속에서는 발소리도 작품의 일부가 됩니다.",
      dawn: "비상등 아래에서 첫 번째 흔적이 드러났습니다. 위조된 표가 가리키는 사람을 확인하세요.",
      day: "모두가 자신의 작품을 설명하지만, 설명에는 작가의 서명이 없습니다.",
      vote: "누구의 알리바이를 전시장에서 내릴지 결정하세요. 표는 공개되지 않은 카탈로그입니다.",
      defense: "피고의 마지막 설명이 전시장 중앙에 울립니다. 진짜와 위조를 나누는 것은 세부입니다.",
      gameover: "전시실의 셔터가 올라갔습니다. 사라진 큐레이터의 마지막 큐레이터 노트를 읽습니다.",
    },
    endings: {
      mafia: "가짜 작품표는 철거됐지만, 누가 처음 그것을 걸었는지는 끝내 전시장 밖에 남았습니다.",
      citizen: "시민들은 작품보다 사람의 흔적을 믿었고, 위조된 동선을 끊어냈습니다.",
      trickster: "가장 완벽한 위조는 광대의 결백이었습니다. 모두가 그것을 진짜라고 믿었으니까요.",
    },
  },
  observatory: {
    codename: "00:42 SIGNAL",
    motif: "관측 기록이 멈춘 90초 동안, 별보다 가까운 곳에서 신호가 왔다.",
    prologue: "북악 천문 관측소의 시계가 00시 42분에서 멈췄습니다. 천문학자 강이안은 사라졌고, 서버에는 내부자만 읽을 수 있는 암호가 남았습니다.",
    chapters: COMMON_CHAPTERS,
    phaseLines: {
      night: "관측소의 돔이 닫힙니다. 하늘을 보는 사람과 아래를 보는 사람을 구분해야 합니다.",
      dawn: "첫 신호가 복구됐습니다. 기록이 끊긴 90초와 누군가의 위치를 대조하세요.",
      day: "모든 진술은 하나의 좌표입니다. 좌표가 겹치는 순간 거짓말의 궤도가 보입니다.",
      vote: "신호를 보낸 사람을 지목하세요. 다음 관측 전까지 표를 봉인해야 합니다.",
      defense: "피고는 마지막으로 암호를 해독할 기회를 얻었습니다. 말하지 않은 숫자를 들어보세요.",
      gameover: "관측 기록이 다시 움직입니다. 00시 42분의 내부자가 누구였는지 최종 복기합니다.",
    },
    endings: {
      mafia: "신호는 끊겼지만 관측소의 암호는 남았습니다. 어둠은 아직 해독되지 않았습니다.",
      citizen: "흩어진 좌표를 연결한 시민들이 마지막 신호의 발신자를 찾아냈습니다.",
      trickster: "광대는 암호가 아니라 사람들의 확신을 해킹해 혼자만의 궤도에 올랐습니다.",
    },
  },
};

const FALLBACK: CaseNarrative = {
  codename: "BLACK MIDNIGHT",
  motif: "한 명이 사라졌고, 남은 사람 모두가 마지막 목격자입니다.",
  prologue: "사건 현장이 봉쇄됐습니다. 기록과 목소리를 모아 누가 거짓말을 시작했는지 확인하세요.",
  chapters: COMMON_CHAPTERS,
  phaseLines: {},
  endings: {
    mafia: "도시는 잠들었고, 마지막 거짓말만 남았습니다.",
    citizen: "기록을 맞춘 사람들이 사건의 문을 열었습니다.",
    trickster: "모두가 찾던 범인은 마지막 표 뒤에 숨어 있었습니다.",
  },
};

export function getCaseNarrative(caseId: string): CaseNarrative {
  return NARRATIVES[caseId] ?? FALLBACK;
}

export function getActiveChapter(game: Pick<GameState, "case_profile" | "phase">): NarrativeChapter {
  const narrative = getCaseNarrative(game.case_profile.id);
  return narrative.chapters.find((chapter) => chapter.phases.includes(game.phase)) ?? narrative.chapters[0];
}

export function getNarrativeLine(game: Pick<GameState, "case_profile" | "phase">): string {
  const narrative = getCaseNarrative(game.case_profile.id);
  return narrative.phaseLines[game.phase] ?? getActiveChapter(game).copy;
}

export function getEndingLine(game: Pick<GameState, "case_profile" | "winner">): string {
  const narrative = getCaseNarrative(game.case_profile.id);
  return narrative.endings[game.winner ?? "citizen"];
}
