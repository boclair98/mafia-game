"use client";

import { BookOpen, ChevronDown, ChevronUp, Clock3 } from "lucide-react";
import { useState } from "react";

import type { GameState } from "@/lib/game";

type RoleGuide = { name: string; goal: string; power: string };

const STEPS: GameState["phase"][] = ["reveal", "night", "dawn", "day", "vote", "defense", "verdict", "result"];
const STEP_NAMES: Record<GameState["phase"], string> = {
  lobby: "입장 준비", reveal: "역할 확인", night: "밤의 선택", dawn: "새벽 감식", day: "진술 대조",
  vote: "피고 지목", defense: "최후 변론", verdict: "최종 판결", result: "결과 확인", gameover: "사건 복기",
};

function getGuidance(game: GameState, role: RoleGuide) {

  if (game.phase === "gameover") {
    return { title: "사건을 함께 되짚어 보세요", copy: "사건 파일에서 각 역할과 밤의 기록, 투표 결과를 확인할 수 있어요. 친구와 서로의 추리를 비교해 보세요." };
  }
  if (game.phase === "lobby") {
    return { title: "모두 준비되면 방장이 시작해요", copy: "첫 사건은 AI 참가자 3명과 함께 진행됩니다. 초대 링크를 공유하거나, 준비가 되면 방장이 사건을 열 수 있어요." };
  }
  if (game.phase === "reveal") {
    return { title: `당신은 ${role.name}입니다`, copy: `${role.goal} ${role.power} 역할과 개인 정보는 다른 참가자에게 공개되지 않아요.` };
  }
  if (!game.me.alive || game.me.role === "spectator") {
    return { title: "지금은 관전하며 기록을 따라가세요", copy: "생존자의 공개 진술과 사건 기록을 비교해 보세요. 비공개 역할이나 조사 결과는 알 수 없어요." };
  }
  if (game.phase === "night") {
    if (game.me.role === "citizen" || game.me.role === "trickster") {
      return { title: "이번 밤에는 선택할 능력이 없어요", copy: "밤 행동을 하지 않아도 괜찮아요. 아침이 되면 공개되는 사건 기록과 단서를 살펴보세요." };
    }
    return { title: `${role.name}: 밤의 능력을 선택하세요`, copy: `${role.power} 대상을 고른 뒤 아래의 ‘명령 봉인’을 눌러 전송하세요. 마감 전에는 선택을 바꿀 수 있습니다.` };
  }
  if (game.phase === "dawn") {
    return { title: "밤의 결과와 새 단서를 읽어 보세요", copy: "단서는 범인을 확정하지 않아요. 누가 무엇을 주장하는지 기억해 두고, 낮에 알리바이와 공개 기록을 대조하세요." };
  }
  if (game.phase === "day") {
    if (game.speaker_id === game.me.id) {
      return { title: "지금은 당신의 집중 발언 차례예요", copy: "확인한 사실과 추측을 구분해서 말해 보세요. 공식 진술로 봉인한 내용은 모두가 함께 볼 수 있어요." };
    }
    return { title: "말과 기록이 어긋나는지 들어 보세요", copy: "현재 발언을 듣고 공개된 단서와 비교하세요. 근거가 있다면 질문하고, 아직 확신이 없으면 다른 참가자의 설명을 기다려도 됩니다." };
  }
  if (game.phase === "vote") {
    return { title: "이번 표는 최후 변론을 들을 사람을 정해요", copy: "가장 많은 표를 받은 참가자가 변론합니다. 이 투표만으로 처형이 확정되지는 않아요. 처형 또는 석방은 다음 판결에서 결정합니다." };
  }
  if (game.phase === "defense") {
    return game.accused_id === game.me.id
      ? { title: "당신의 마지막 변론 차례예요", copy: "사건 기록과 연결해 자신의 행동을 설명해 보세요. 판결은 변론이 끝난 뒤 생존자들이 내립니다." }
      : { title: "피고의 마지막 설명을 들어 보세요", copy: "새로 나온 설명을 공개 기록과 대조하세요. 아직 판결할 차례는 아니며, 다음 단계에서 처형 또는 석방을 고릅니다." };
  }
  if (game.phase === "verdict") {
    return game.accused_id === game.me.id
      ? { title: "도시가 최종 판결을 내리고 있어요", copy: "피고는 자신의 판결에 참여하지 않습니다. 다른 생존자들의 결정을 기다려 주세요." }
      : { title: "기록을 근거로 최종 판결을 선택하세요", copy: "처형과 석방 중 하나를 선택합니다. 정답이 자동으로 표시되는 퍼즐이 아니라, 여러분의 추리로 결정하는 단계예요." };
  }
  if (game.phase === "result") {
    return { title: "판결 결과를 확인하세요", copy: "결과가 공개되어도 사건이 끝날 때까지 역할은 비밀로 남아요. 다음 밤이 시작되면 새 단서와 진술을 다시 비교하세요." };
  }
  return { title: "다음 사건 기록을 기다려 주세요", copy: "현재 단계와 남은 시간은 화면 위쪽에 표시됩니다. 진행관 안내는 필요할 때 접었다 다시 열 수 있어요." };
}

export default function FirstCaseCoach({ game, role }: { game: GameState; role: RoleGuide }) {
  const [expanded, setExpanded] = useState(true);
  const guidance = getGuidance(game, role);
  const step = game.phase === "gameover" ? STEPS.length : Math.max(1, STEPS.indexOf(game.phase) + 1);

  return (
    <section className={`first-case-coach ${expanded ? "is-open" : "is-closed"}`} data-testid="first-case-coach" aria-label="첫 사건 진행관 안내">
      <header className="first-case-coach-head">
        <BookOpen size={17} aria-hidden="true" />
        <span><small>첫 사건 진행관 · {step}/{STEPS.length}</small><b>{STEP_NAMES[game.phase]}</b></span>
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? <>안내 접기<ChevronUp size={15} /></> : <>안내 열기<ChevronDown size={15} /> </>}
        </button>
      </header>
      {expanded && <div className="first-case-coach-copy" role="status" aria-live="polite" aria-atomic="true">
        <h2>{guidance.title}</h2>
        <p>{guidance.copy}</p>
        <small><Clock3 size={13} />남은 시간은 상단 타이머에서 확인해요. 안내를 읽는 동안에도 경기는 계속 진행됩니다.</small>
      </div>}
    </section>
  );
}
