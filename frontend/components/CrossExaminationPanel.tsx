"use client";

import { useEffect, useState, type FormEvent } from "react";
import { ArrowDown, ArrowUpRight, Check, ChevronRight, FileSearch, Fingerprint, LockKeyhole, MessageCircle, Quote, Radio, Send, ShieldQuestion } from "lucide-react";
import type { CrossExamination, GameState } from "@/lib/game";
import type { ConnStatus } from "@/lib/ws";

export type CommandFailure = { serial: number; message: string };
type Props = {
  game: GameState;
  connection: ConnStatus;
  failure: CommandFailure;
  onCommand: (message: object) => boolean;
};
type Submission = { phase: string; errorSerial: number };

function submissionState(game: GameState, failure: CommandFailure, submission: Submission | null, accepted: boolean) {
  if (!submission) return { pending: false, error: "", accepted: false };
  if (accepted) return { pending: false, error: "", accepted: true };
  if (failure.serial > submission.errorSerial) return { pending: false, error: failure.message, accepted: false };
  if (game.phase_id !== submission.phase) return { pending: false, error: "단계가 바뀌었습니다. 입력한 내용은 보관되어 있습니다.", accepted: false };
  return { pending: true, error: "", accepted: false };
}

function useSubmissionState(game: GameState, failure: CommandFailure, submission: Submission | null, accepted: boolean) {
  const [expiredSubmission, setExpiredSubmission] = useState<Submission | null>(null);
  const result = submissionState(game, failure, submission, accepted);
  useEffect(() => {
    if (!submission || !result.pending) return;
    const timer = window.setTimeout(() => setExpiredSubmission(submission), 12000);
    return () => window.clearTimeout(timer);
  }, [submission, result.pending]);
  if (result.pending && expiredSubmission === submission) {
    return { pending: false, error: "접수 결과를 확인하지 못했습니다. 기록을 확인한 뒤 같은 내용으로 다시 전송할 수 있습니다.", accepted: false };
  }
  return result;
}

function Feedback({ pending, error, accepted }: { pending: boolean; error: string; accepted: boolean }) {
  if (!pending && !error && !accepted) return null;
  return <p className={`cross-feedback ${error ? "error" : accepted ? "accepted" : ""}`} role="status">
    {accepted ? <Check size={14} /> : pending ? <Radio size={14} /> : <ShieldQuestion size={14} />}
    {error || (accepted ? "사건 기록에 접수되었습니다." : "서버에서 접수를 확인하고 있습니다. 입력을 보관 중입니다.")}
  </p>;
}

function RetainedDraft({ label, text, detail }: { label: string; text: string; detail: string }) {
  return <div className="cross-retained-draft"><small>{label}</small><blockquote>{text}</blockquote><p>{detail}</p></div>;
}

function ClaimComposer({ game, connection, failure, onCommand }: Props) {
  const [text, setText] = useState("");
  const [submitted, setSubmitted] = useState<Submission | null>(null);
  const [localError, setLocalError] = useState("");
  const mine = game.claims.find((claim) => claim.round === game.round && claim.speaker_id === game.me.id);
  const result = useSubmissionState(game, failure, submitted, Boolean(mine));
  const canWrite = game.phase === "day" && game.me.alive && game.speaker_id === game.me.id && !mine;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canWrite || !text.trim() || result.pending || connection !== "open") return;
    if (!onCommand({ t: "claim", phase_id: game.phase_id, text: text.trim() })) {
      setLocalError("연결이 복구되면 다시 전송해 주세요. 진술은 보관되어 있습니다.");
      return;
    }
    setLocalError("");
    setSubmitted({ phase: game.phase_id, errorSerial: failure.serial });
  };
  if (mine) return <div className="cross-own-claim"><Check size={16} /><span><small>내 공식 진술 · 기록됨</small><p>{mine.text}</p></span></div>;
  if (!canWrite) return text.trim() ? <>
    <RetainedDraft label={submitted ? "공식 진술 · 접수 확인이 필요한 초안" : "공식 진술 · 전송하지 않은 초안"} text={text} detail={game.phase === "day" && game.me.alive ? "집중 발언 순서가 바뀌어 지금은 공식 진술을 보낼 수 없습니다. 필요한 내용은 자유 대화에서 직접 설명하세요." : "공식 진술을 보낼 수 있는 시간이 끝났습니다. 이 초안은 다음 라운드에 자동 전송되지 않습니다."} />
    <Feedback {...result} error={localError || result.error} />
  </> : null;
  return <form className="cross-claim-form" onSubmit={submit}>
    <label htmlFor="cross-own-claim"><Quote size={15} />지금은 당신의 집중 발언입니다</label>
    <textarea id="cross-own-claim" value={text} onChange={(event) => { setText(event.target.value); setLocalError(""); }} maxLength={120} placeholder="확인한 사실과 당신의 판단을 한 문장으로 남기세요." rows={2} disabled={result.pending} />
    <div><small>한 라운드에 한 번 · {text.length}/120</small><button type="submit" disabled={!text.trim() || result.pending || connection !== "open"}><LockKeyhole size={15} />{result.pending ? "접수 확인 중" : "공식 진술 남기기"}</button></div>
    <Feedback {...result} error={localError || result.error} />
  </form>;
}

function ReplyComposer({ entry, ...props }: Props & { entry: CrossExamination }) {
  const { game, connection, failure, onCommand } = props;
  const [text, setText] = useState("");
  const [kind, setKind] = useState<"clarify" | "revise">("clarify");
  const [submitted, setSubmitted] = useState<Submission | null>(null);
  const [localError, setLocalError] = useState("");
  const result = useSubmissionState(game, failure, submitted, entry.response !== null);
  const canReply = game.phase === "day" && game.me.alive && entry.round === game.round && entry.target_id === game.me.id && entry.response === null;
  if (!canReply) return entry.target_id === game.me.id && entry.response === null && text.trim() ? <>
    <RetainedDraft label={submitted ? "답변 · 접수 확인이 필요한 초안" : "답변 · 전송하지 않은 초안"} text={text} detail="공개 토론 시간이 끝났거나 답변 권한이 없어 더 이상 보낼 수 없습니다. 기록에서 접수 여부를 확인하세요. 다음 라운드에 자동 전송되지 않습니다." />
    <Feedback {...result} error={localError || result.error} />
  </> : null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (text.trim().length < 5 || result.pending || connection !== "open") return;
    if (!onCommand({ t: "challenge_reply", phase_id: game.phase_id, challenge_id: entry.id, text: text.trim(), kind })) {
      setLocalError("연결이 복구되면 다시 전송해 주세요. 답변은 보관되어 있습니다.");
      return;
    }
    setLocalError("");
    setSubmitted({ phase: game.phase_id, errorSerial: failure.serial });
  };
  return <form className="cross-reply-form" onSubmit={submit}>
    <label htmlFor={`reply-${entry.id}`}>당신에게 온 질문에 답하세요</label>
    <div className="cross-reply-kind" role="group" aria-label="답변 방식">
      <button type="button" aria-pressed={kind === "clarify"} onClick={() => setKind("clarify")} disabled={result.pending}>주장을 설명할게요</button>
      <button type="button" aria-pressed={kind === "revise"} onClick={() => setKind("revise")} disabled={result.pending}>판단을 수정할게요</button>
    </div>
    <textarea id={`reply-${entry.id}`} value={text} onChange={(event) => { setText(event.target.value); setLocalError(""); }} maxLength={160} rows={2} placeholder="그 기록을 어떻게 해석했는지 설명해 주세요. 판단을 바꾼 이유도 좋습니다." disabled={result.pending} />
    <div className="cross-form-foot"><small>5자 이상 · {text.length}/160</small><button type="submit" disabled={text.trim().length < 5 || result.pending || connection !== "open"}><Send size={14} />{result.pending ? "접수 확인 중" : "답변 기록하기"}</button></div>
    <Feedback {...result} error={localError || result.error} />
  </form>;
}

export default function CrossExaminationPanel(props: Props) {
  const { game, connection, failure, onCommand } = props;
  const [claimId, setClaimId] = useState("");
  const [clueId, setClueId] = useState("");
  const [question, setQuestion] = useState("");
  const [submitted, setSubmitted] = useState<Submission | null>(null);
  const [localError, setLocalError] = useState("");
  const living = new Set(game.players.filter((player) => player.alive).map((player) => player.id));
  const claims = game.claims.filter((claim) => claim.round === game.round && claim.speaker_id !== game.me.id && living.has(claim.speaker_id));
  const selectedClaim = claims.find((claim) => claim.id === claimId) ?? claims.find((claim) => claim.speaker_id === game.speaker_id) ?? claims.at(-1);
  const records = [
    ...(game.night_summary ? [{ id: game.night_summary.id, title: game.night_summary.title, detail: game.night_summary.detail, label: "확정된 밤 결과" }] : []),
    ...game.clues.filter((clue) => clue.round === game.round).map((clue) => ({ id: clue.id, title: clue.title, detail: clue.detail, label: clue.code })),
  ];
  const selectedRecord = records.find((record) => record.id === clueId) ?? records[0];
  const entries = game.cross_examinations.filter((entry) => game.phase === "gameover" || entry.round === game.round);
  const mine = entries.find((entry) => entry.asker_id === game.me.id && entry.round === game.round);
  const result = useSubmissionState(game, failure, submitted, Boolean(mine));
  const speaker = game.players.find((player) => player.id === game.speaker_id);
  const canAsk = game.phase === "day" && game.me.can_challenge && Boolean(selectedClaim && selectedRecord) && !mine;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canAsk || !selectedClaim || !selectedRecord || question.trim().length < 5 || result.pending || connection !== "open") return;
    if (!onCommand({ t: "challenge", phase_id: game.phase_id, claim_id: selectedClaim.id, clue_id: selectedRecord.id, text: question.trim() })) {
      setLocalError("연결이 복구되면 다시 전송해 주세요. 질문은 보관되어 있습니다.");
      return;
    }
    setLocalError("");
    setSubmitted({ phase: game.phase_id, errorSerial: failure.serial });
  };

  return <section className="cross-exam-panel" aria-labelledby="cross-exam-heading" data-testid="cross-examination-panel">
    <header className="cross-heading"><span className="cross-heading-mark"><Fingerprint size={26} strokeWidth={1.3} /></span><span><small>TESTIMONY × EVIDENCE · DAY {game.round}</small><h2 id="cross-exam-heading">증언 대조실</h2></span><span className="cross-live"><i />{game.phase === "day" ? "공개 토론" : game.phase === "gameover" ? "사건 종결" : "기록 열람"}</span></header>
    <p className="cross-intro">누가 맞는지 결정하기 전에, 무엇을 근거로 말했는지 물어보세요.</p>
    {game.phase === "day" && speaker && <div className="cross-speaker"><Radio size={16} /><span><small>지금 집중 발언</small><b>{speaker.n}{speaker.id === game.me.id ? " · 나" : ""}</b></span><em>자유 대화도 계속할 수 있습니다</em></div>}
    {game.night_summary && !canAsk && <div className="cross-night-summary"><FileSearch size={18} /><span><small>확정된 밤 결과 · DAY {game.night_summary.round}</small><b>{game.night_summary.title}</b><p>{game.night_summary.detail}</p></span></div>}
    <ClaimComposer {...props} />

    {canAsk ? <form className="cross-question-form" onSubmit={submit}>
      <div className="cross-comparison">
        <div className="cross-record claim"><label htmlFor="challenge-claim"><Quote size={15} />검토할 진술</label><select id="challenge-claim" value={selectedClaim?.id ?? ""} onChange={(event) => setClaimId(event.target.value)} disabled={result.pending}>{claims.map((claim) => <option key={claim.id} value={claim.id}>{claim.speaker}님의 진술</option>)}</select><blockquote>{selectedClaim?.text}</blockquote></div>
        <span className="cross-compare-mark" aria-hidden="true">×</span>
        <div className="cross-record evidence"><label htmlFor="challenge-record"><FileSearch size={15} />함께 제시할 기록</label><select id="challenge-record" value={selectedRecord?.id ?? ""} onChange={(event) => setClueId(event.target.value)} disabled={result.pending}>{records.map((record) => <option key={record.id} value={record.id}>{record.label} · {record.title}</option>)}</select><p>{selectedRecord?.detail}</p></div>
      </div>
      <label className="cross-question-label" htmlFor="challenge-question"><MessageCircle size={15} />두 기록을 어떻게 설명할 수 있나요?</label>
      <textarea id="challenge-question" value={question} onChange={(event) => {
        // Keep the cited records stable when the active speaker changes while
        // someone is composing a question.
        if (!claimId && selectedClaim) setClaimId(selectedClaim.id);
        if (!clueId && selectedRecord) setClueId(selectedRecord.id);
        setQuestion(event.target.value);
        setLocalError("");
      }} maxLength={160} rows={2} placeholder="예: 이 밤 결과와 방금 진술을 함께 보면, 어떤 근거로 그렇게 판단했나요?" disabled={result.pending} />
      <div className="cross-form-foot"><small>질문은 라운드당 1회 · 5자 이상 · {question.length}/160</small><button type="submit" disabled={question.trim().length < 5 || result.pending || connection !== "open"}><ArrowUpRight size={16} />{result.pending ? "접수 확인 중" : "기록을 제시해 질문"}</button></div>
      <Feedback {...result} error={localError || result.error} />
    </form> : !mine && game.phase !== "gameover" ? <div className="cross-empty"><FileSearch size={23} /><span><b>{game.phase === "day" && !claims.length ? "아직 대조할 상대 진술이 없습니다" : game.phase === "day" && !records.length ? "공개된 사건 기록을 기다리고 있습니다" : game.phase === "day" && !game.me.alive ? "사건의 대화를 지켜보고 있습니다" : "지금은 기록을 읽는 시간입니다"}</b><p>{game.phase === "day" && game.me.alive ? "집중 발언자는 공식 진술을 남길 수 있습니다. 그동안 자유 토론으로 서로의 근거를 확인하세요." : "다음 판단에 앞서 공개된 진술과 기록을 다시 살펴보세요."}</p></span></div> : null}

    {!canAsk && !mine && question.trim() && <>
      <RetainedDraft label={submitted ? "대조 질문 · 접수 확인이 필요한 초안" : "대조 질문 · 전송하지 않은 초안"} text={question} detail="현재 단계나 남은 질문 권한으로는 전송할 수 없습니다. 사건 기록에서 접수 여부를 확인하고 필요한 내용은 자유 대화에서 직접 설명하세요. 다음 라운드에 자동 전송되지 않습니다." />
      <Feedback {...result} error={localError || result.error} />
    </>}

    {entries.length > 0 && <div className="cross-records"><div className="cross-section-heading"><h3>제시된 질문과 답변</h3><span>{entries.length}건 기록</span></div>{[...entries].reverse().map((entry) => <article className={`cross-entry ${entry.response ? "answered" : ""}`} key={entry.id}>
      <header><span><b>{entry.asker}</b><ChevronRight size={13} /><b>{entry.target}</b></span><small>{entry.response ? entry.response_kind === "revise" ? "판단 수정" : "해명 기록" : game.phase === "day" ? "답변 기다리는 중" : "답변 없이 마감"}</small></header>
      <div className="cross-entry-sources"><blockquote><small>인용 진술</small>{entry.claim_text}</blockquote><div><small>{entry.clue_title}</small><p>{entry.clue_detail}</p></div></div>
      <p className="cross-entry-question"><MessageCircle size={15} /><span>{entry.question}</span></p>
      {entry.response && <div className="cross-entry-response"><ArrowDown size={15} /><span><small>{entry.target}님의 {entry.response_kind === "revise" ? "수정" : "해명"}</small><p>{entry.response}</p></span></div>}
      <ReplyComposer {...props} entry={entry} />
    </article>)}</div>}
    {mine && <p className="cross-confirmed"><Check size={15} />{game.phase === "gameover" ? "당신이 제시한 기록과 답변을 실제 밤의 기록과 비교해 보세요." : "이번 라운드의 질문이 사건 기록에 남았습니다. 답변을 듣고 최종 표를 결정하세요."}</p>}
    <p className="cross-fairness"><ShieldQuestion size={14} />질문과 해명은 각자의 주장입니다. 판단의 수정도 유죄의 증거가 아닙니다.</p>
    {game.phase === "gameover" && game.night_replay.length > 0 && <details className="cross-night-replay" open><summary><LockKeyhole size={16} />봉인 해제 · 밤의 실제 기록 <span>{game.night_replay.length}일</span></summary>{game.night_replay.map((night) => <article key={night.id}><header><small>DAY {night.round}</small><b>{night.title}</b></header><p>{night.detail}</p><ul>{night.actions.map((action, index) => <li key={`${action.actor_id}-${index}`}><span>{action.actor}</span><i>{action.kind === "attack" ? "습격" : action.kind === "heal" ? "치료" : action.kind === "investigate" ? "조사" : "경호"}</i><ChevronRight size={12} /><span>{action.target}</span></li>)}</ul></article>)}</details>}
  </section>;
}
