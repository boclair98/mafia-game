"use client";

import { ArrowDown, ArrowUpRight, Award, BookOpen, Bot, ChevronRight, Fingerprint, Gavel, Headphones, Moon, Search, Settings, ShieldQuestion, Users } from "lucide-react";
import { memo, useState } from "react";
import "./midnight-landing.css";

type Props = {
  players: number | null;
  invited: boolean;
  onPlay: (mode: "party" | "solo" | "first") => void;
  onJoin: () => void;
  onGuide: () => void;
  onRanking: () => void;
  onPassport: () => void;
  onSettings: () => void;
};

const roles = [
  { name: "마피아", label: "거짓말로 살아남는 자", side: "MAFIA", face: 2, icon: Moon, text: "밤에는 한 사람을 습격하고, 낮에는 가장 믿을 만한 시민이 되세요.", goal: "마피아 수가 시민 수와 같아질 때까지 생존" },
  { name: "탐정", label: "침묵 속에서 진실을 찾는 자", side: "CITIZEN", face: 5, icon: Search, text: "매일 밤 한 사람의 정체를 조사합니다. 진실을 언제 공개할지는 당신의 선택입니다.", goal: "조사 결과와 토론으로 마피아 전원 검거" },
  { name: "의사", label: "어둠 속에서 누군가를 지키는 자", side: "CITIZEN", face: 7, icon: Headphones, text: "매일 밤 한 사람을 치료합니다. 당신의 선택이 다음 날의 증언을 살릴 수 있습니다.", goal: "시민을 보호하며 마피아 전원 검거" },
  { name: "광대", label: "의심받기를 원하는 자", side: "NEUTRAL", face: 10, icon: ShieldQuestion, text: "처형당하는 순간 단독 승리합니다. 의심을 사되, 밤의 표적이 되어서는 안 됩니다.", goal: "시민의 최종 판결로 자신이 처형되기" },
] as const;

export default memo(function MidnightLanding({ players, invited, onPlay, onJoin, onGuide, onRanking, onPassport, onSettings }: Props) {
  const [selectedRole, setSelectedRole] = useState(0);
  const role = roles[selectedRole];
  const RoleIcon = role.icon;
  return <div className="midnight-home">
    <header className="midnight-nav">
      <a className="midnight-brand" href="#"><Fingerprint size={29} strokeWidth={1.2} /><span><b>검은 자정</b><small>BLACK MIDNIGHT</small></span></a>
      <nav aria-label="게임 안내"><a href="#case-world">게임 소개</a><button onClick={onGuide}>플레이 가이드</button><button onClick={onRanking}>명예의 전당</button></nav>
      <div className="midnight-nav-end"><span className="midnight-live"><i />{players === null ? "연결 확인 중" : `${players}명 수사 중`}</span><button className="midnight-icon" onClick={onPassport} aria-label="수사관 패스포트"><Award size={19} /></button><button className="midnight-icon" onClick={onSettings} aria-label="설정과 운영 정책"><Settings size={19} /></button></div>
    </header>

    <section className="midnight-hero" aria-labelledby="midnight-title">
      <picture className="midnight-scene"><source media="(max-width: 600px)" srcSet="/case-room-mobile.webp" /><img src="/case-room-wide.webp" alt="빗소리가 들리는 저택, 증거가 흩어진 수사실" fetchPriority="high" /></picture>
      <div className="midnight-hero-shade" aria-hidden="true" />
      <div className="midnight-hero-content">
        <div className="midnight-eyebrow"><span /> REALTIME SOCIAL DEDUCTION</div>
        <h1 id="midnight-title">이 방 안에,<br /> <em>범인이 있다.</em></h1>
        <p className="midnight-hero-copy">같은 밤. 다른 진실.<br />단서를 읽고, 진술을 의심하고, 당신의 한 표로<br className="desktop-break" /> 사건의 결말을 바꾸세요.</p>
        <div className="midnight-hero-actions"><button className="midnight-primary" onClick={() => onPlay(invited ? "party" : "first")}><Fingerprint size={20} />{invited ? "초대받은 사건에 합류" : "첫 사건 시작하기"}<ArrowUpRight size={20} /></button><button className="midnight-guide" onClick={onGuide}><BookOpen size={17} />플레이 방법</button></div>
        <p className="midnight-hero-note">{invited ? "초대 링크의 방 코드로 이어집니다" : "처음이라면 AI 3명과 함께 · 약 8–12분"}</p>
        <div className="midnight-facts"><span><Users size={15} />4–12인</span><span><Headphones size={15} />음성·텍스트 토론</span><span><span className="fact-dot" />설치 없이 플레이</span></div>
      </div>
      <div className="midnight-scene-label"><span>BLACK MIDNIGHT / CRIME SCENE</span><b>아무도 이 방을 떠날 수 없다.</b><i /></div>
      <a className="midnight-scroll" href="#case-world"><ArrowDown size={15} />사건 파일 열기</a>
    </section>

    <section className="midnight-modes" aria-label="플레이 모드 선택">
      <div className="midnight-mode-heading"><span>CHOOSE YOUR CASE</span><h2>오늘 밤, 어떻게 시작할까요?</h2><button onClick={onJoin}>방 코드로 참가<ChevronRight size={16} /></button></div>
      <div className="midnight-mode-grid">
        <button className="midnight-mode" onClick={() => onPlay("party")}><span className="mode-icon"><Users size={24} strokeWidth={1.5} /></span><span className="mode-top">함께하는 심리전 <i>4–12인</i></span><b>친구와 사건 시작</b><p>링크 하나로 초대하세요.<br />가장 가까운 사람이 범인일지도.</p><span className="mode-link">새 방 만들기<ArrowUpRight size={17} /></span></button>
        <button className="midnight-mode" onClick={() => onPlay("solo")}><span className="mode-icon"><Bot size={24} strokeWidth={1.5} /></span><span className="mode-top">나만의 추리 시간 <i>AI 7명</i></span><b>혼자 수사</b><p>서로 다른 성향의 AI 용의자들.<br />그들의 알리바이를 파헤치세요.</p><span className="mode-link">수사 시작하기<ArrowUpRight size={17} /></span></button>
        <button className="midnight-mode first-mode" onClick={() => onPlay("first")}><span className="mode-icon"><BookOpen size={24} strokeWidth={1.5} /></span><span className="mode-top">처음이라면 여기서 <i>입문 추천</i></span><b>첫 번째 사건</b><p>AI 3명과 함께 배우는 실제 경기.<br />진행관의 안내로 한 단계씩 배우세요.</p><span className="mode-link">첫 사건 열기<ArrowUpRight size={17} /></span></button>
      </div>
    </section>

    <section className="midnight-file" id="case-world">
      <div className="midnight-section-heading"><span>HOW THE NIGHT UNFOLDS</span><h2>말은 거짓말을 해도,<br />기록은 남습니다.</h2><p>밤의 행동부터 마지막 판결까지.<br />흩어진 증거를 연결하는 건 당신입니다.</p></div>
      <div className="midnight-flow">{[
        { icon: Moon, title: "밤, 정체가 움직인다", copy: "비밀리에 능력을 선택하세요. 누군가는 지키고, 누군가는 흔적을 남깁니다.", tag: "NIGHT" },
        { icon: Search, title: "새벽, 단서가 도착한다", copy: "실제 사건에서 나온 단서와 개인 조사 결과. 사실과 주장을 구분하세요.", tag: "EVIDENCE" },
        { icon: Users, title: "낮, 진술을 대조한다", copy: "말을 듣고 질문하세요. 어젯밤의 행동과 오늘의 알리바이가 맞아떨어지나요?", tag: "TESTIMONY" },
        { icon: Gavel, title: "판결, 선택에 책임진다", copy: "피고를 지목하고 최후 변론을 들은 뒤, 처형 또는 석방을 결정하세요.", tag: "VERDICT" },
      ].map((step, i) => <article key={step.tag}><div><span>0{i + 1}</span><step.icon size={22} strokeWidth={1.4} /></div><small>{step.tag}</small><h3>{step.title}</h3><p>{step.copy}</p></article>)}</div>
    </section>

    <section className="midnight-roles">
      <div className="midnight-section-heading"><span>TRUST IS A DANGEROUS THING</span><h2>당신은 누구의 편입니까?</h2><p>역할은 비밀입니다. 승리의 방법은 서로 다릅니다.</p></div>
      <div className="midnight-role-layout"><div className="midnight-role-list" role="group" aria-label="역할 안내">{roles.map((item, i) => <button key={item.name} onClick={() => setSelectedRole(i)} aria-pressed={selectedRole === i} className={selectedRole === i ? "active" : ""}><span className={`avatar-photo avatar-${item.face}`} /><span><small>{item.side}</small><b>{item.name}</b></span><ChevronRight size={17} /></button>)}</div><article className="midnight-role-detail"><span className="role-detail-kicker"><RoleIcon size={17} />봉인된 역할 파일</span><h3>{role.name}<small>{role.label}</small></h3><p>{role.text}</p><div><span>승리 조건</span><b>{role.goal}</b></div><span className="role-private"><Fingerprint size={16} />나의 역할과 개인 조사 결과는 나에게만 공개됩니다.</span></article></div>
    </section>

    <footer className="midnight-footer"><div><Fingerprint size={24} /><span>검은 자정<small>BLACK MIDNIGHT</small></span></div><p>누군가는 진실을. 누군가는 완벽한 거짓말을.</p><button onClick={onPassport}>수사관 패스포트<ArrowUpRight size={16} /></button><button onClick={onSettings}>설정·운영 정책</button></footer>
  </div>;
});
