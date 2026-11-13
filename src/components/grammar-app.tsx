"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, BookOpen, Camera, ChartNoAxesCombined, Check, CheckCheck, ChevronRight, CircleAlert, Clock3, FileText, GraduationCap, ImagePlus, LayoutDashboard, LoaderCircle, LogIn, LogOut, Plus, RefreshCw, ScanLine, ShieldCheck, Sparkles, Target, Upload, X } from "lucide-react";
import type { Capture, InputQuestion, Overview, PublicPracticeSession, QuestionResult, RuntimeConfig, SampleSummary, Submission, Tag } from "@/lib/types";

let authClient: SupabaseClient | null = null;
function supabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  if (!authClient) authClient = createClient(url, key);
  return authClient;
}
async function headersForRequest() {
  const headers = new Headers();
  const client = supabase();
  if (client) {
    const { data } = await client.auth.getSession();
    if (data.session) headers.set("Authorization", `Bearer ${data.session.access_token}`);
  }
  return headers;
}
async function request<T>(url: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers = await headersForRequest();
  const multipart = options.body instanceof FormData;
  if (options.body !== undefined && !multipart) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { method: options.method || "GET", headers, credentials: "same-origin", cache: "no-store", body: options.body === undefined ? undefined : multipart ? options.body as FormData : JSON.stringify(options.body) });
  const payload = await response.json().catch(() => ({ error: "服务器返回了无法读取的响应，请稍后重试。" }));
  if (!response.ok) throw new Error(response.status === 401 ? "请先登录后继续。" : payload.error || "请求没有完成，请重试。");
  return payload as T;
}
function requestKey(scope: string, renew = false) {
  const key = `grammar-loop:${scope}`;
  let value = sessionStorage.getItem(key);
  if (!value || renew) { value = crypto.randomUUID(); sessionStorage.setItem(key, value); }
  return value;
}
function dateLabel(value?: string, includeTime = false) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Hong_Kong", month: "short", day: "numeric", ...(includeTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}) }).format(date);
}
const active = (status: string) => status === "queued" || status === "processing";
const tagName = (tags: Tag[], id: string) => tags.find(tag => tag.id === id)?.name || id || "待归类";

function useResource<T>(url: string | null, shouldPoll?: (value: T) => boolean, refreshToken?: unknown) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const poll = useRef(shouldPoll);
  poll.current = shouldPoll;
  useEffect(() => {
    if (!url) { setLoading(false); return; }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    setLoading(true); setError("");
    const load = async () => {
      try {
        const value = await request<T>(url);
        if (disposed) return;
        setData(value); setError(""); setLoading(false);
        if (poll.current?.(value)) timer = setTimeout(load, 2000);
      } catch (e) { if (!disposed) { setError(e instanceof Error ? e.message : "加载失败"); setLoading(false); } }
    };
    void load();
    return () => { disposed = true; clearTimeout(timer); };
  }, [url, revision, refreshToken]);
  return { data, error, loading, setData, refetch: () => setRevision(value => value + 1) };
}

function Button({ children, onClick, disabled, secondary, className = "", type = "button" }: { children: ReactNode; onClick?: () => void; disabled?: boolean; secondary?: boolean; className?: string; type?: "button" | "submit" }) {
  return <button type={type} onClick={onClick} disabled={disabled} className={`button ${secondary ? "button-secondary" : "button-primary"} ${className}`}>{children}</button>;
}
function Notice({ children, kind = "info" }: { children: ReactNode; kind?: "info" | "error" | "success" }) {
  return <div className={`notice notice-${kind}`} role={kind === "error" ? "alert" : "status"}>{kind === "success" ? <Check size={17} /> : <CircleAlert size={17} />}<div>{children}</div></div>;
}
function StatusPill({ status }: { status: string }) {
  const names: Record<string, string> = { queued: "排队中", processing: "处理中", completed: "已完成", needs_input: "待核对", failed: "处理失败", correct: "正确", incorrect: "错误", uncertain: "待确认" };
  return <span className={`pill status-${status}`}>{active(status) && <LoaderCircle size={12} className="spin" />}{names[status] || status}</span>;
}
function SamplePill() { return <span className="pill pill-sample">样例回放</span>; }
function EmptyState({ icon = <BookOpen size={25} />, title, children, action }: { icon?: ReactNode; title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{children}</p>{action}</div>;
}
function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-heading"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{action}</div>;
}
function Processing({ stage, title = "正在整理你的题目" }: { stage: string; title?: string }) {
  return <div className="processing-panel"><div className="scan-icon"><ScanLine size={34} /></div><h2>{title}</h2><p>{stage || "任务已提交，正在等待处理。"}</p><div className="progress-track"><span /></div><span className="muted small">可以离开页面，回来后继续查看。</span></div>;
}

export default function GrammarApp() {
  const pathname = usePathname();
  const router = useRouter();
  const [refresh, setRefresh] = useState(0);
  const overview = useResource<Overview>("/api/me/overview", undefined, `${pathname}:${refresh}`);
  const configResource = useResource<RuntimeConfig>("/api/config");
  const [email, setEmail] = useState<string | null>(null);
  const config = overview.data?.config || configResource.data;
  useEffect(() => {
    const client = supabase();
    if (!client) return;
    void client.auth.getSession().then(({ data }) => setEmail(data.session?.user.email || null));
    const { data } = client.auth.onAuthStateChange((_event, session) => { setEmail(session?.user.email || null); setRefresh(value => value + 1); });
    return () => data.subscription.unsubscribe();
  }, []);
  const refreshAll = useCallback(() => setRefresh(value => value + 1), []);
  const nav = [
    { href: "/", label: "学习首页", icon: LayoutDashboard },
    { href: "/capture", label: "录入错题", icon: ScanLine },
    { href: "/review", label: "针对性复习", icon: BookOpen },
    { href: "/overview", label: "学习记录", icon: ChartNoAxesCombined },
  ];
  const section = pathname.startsWith("/submissions") ? "/overview" : pathname.startsWith("/review") ? "/review" : pathname;
  const authError = overview.error.includes("登录");
  let content: ReactNode;
  if (pathname === "/login") content = <LoginPage configured={!!supabase()} />;
  else if (pathname === "/capture") content = <CapturePage overview={overview.data} config={config || null} onChange={refreshAll} />;
  else if (pathname.startsWith("/submissions/")) content = <SubmissionPage id={pathname.split("/")[2]} tags={overview.data?.tags || []} onChange={refreshAll} />;
  else if (pathname.startsWith("/review/")) content = <PracticePage id={pathname.split("/")[2]} tags={overview.data?.tags || []} onChange={refreshAll} />;
  else if (pathname === "/review") content = <ReviewPage overview={overview.data} onChange={refreshAll} />;
  else if (pathname === "/overview") content = <OverviewPage overview={overview.data} />;
  else if (pathname === "/") content = <HomePage overview={overview.data} config={config || null} />;
  else content = <EmptyState title="这个页面还没有内容" action={<Link className="button button-primary" href="/">返回首页</Link>}>从学习首页重新开始吧。</EmptyState>;
  return <div className="app-shell"><header className="topbar"><div className="topbar-inner"><Link href="/" className="brand" aria-label="Grammar Loop 首页"><span className="brand-icon"><BookOpen size={21} /></span><span>Grammar<span className="brand-light">Loop</span><small>英语语法诊断</small></span></Link><nav className="desktop-nav" aria-label="主导航">{nav.map(item => <Link key={item.href} href={item.href} className={section === item.href ? "nav-link current" : "nav-link"}><item.icon size={16} />{item.label}</Link>)}</nav><div className="account">{email ? <><span className="user-avatar" title={email}>{email[0].toUpperCase()}</span><button className="icon-button" title="退出登录" onClick={async () => { await supabase()?.auth.signOut(); router.push("/login"); refreshAll(); }}><LogOut size={17} /></button></> : config?.authConfigured ? <Link className="login-link" href="/login"><LogIn size={16} />登录</Link> : <span className="local-badge"><span />本地体验</span>}</div></div></header><main className="main-container">{overview.error && pathname !== "/login" && <div className="global-notice"><Notice kind="error">{overview.error} {authError ? <Link href="/login">前往登录 <ArrowRight size={13} /></Link> : <button className="text-button" onClick={overview.refetch}>重新加载</button>}</Notice></div>}{content}</main><footer className="footer"><span>Grammar Loop</span><span>每一次理解，都算数。</span><span className="footer-end">AI 诊断可核对、可修正</span></footer><nav className="mobile-nav" aria-label="移动导航">{nav.map(item => <Link key={item.href} href={item.href} className={section === item.href ? "current" : ""}><item.icon size={20} /><span>{item.label}</span></Link>)}</nav></div>;
}

function HomePage({ overview, config }: { overview: Overview | null; config: RuntimeConfig | null }) {
  const recent = overview?.submissions.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 3) || [];
  return <><div className="welcome-line"><span><span className="welcome-dot" />学习，从理解开始</span><span>GRAMMAR · PRACTICE · PROGRESS</span></div><section className="hero"><div className="hero-copy"><div className="hero-kicker"><Sparkles size={14} /> YOUR PERSONAL GRAMMAR COMPANION</div><h1>读懂这一次错误，<br />走好下一步。</h1><p>把试卷里的疑问，变成清晰的语法知识。<br className="desktop-only" />从错题诊断到针对性练习，让每次复习都有方向。</p><div className="hero-actions"><Link className="button button-white" href="/capture"><Camera size={18} />录入一份试卷<ArrowRight size={17} /></Link><Link className="hero-text-link" href="/capture#samples">先体验真实题样例<ChevronRight size={16} /></Link></div><div className="hero-footnote"><ShieldCheck size={14} />保留原题证据 · 支持人工核对</div></div><div className="hero-art" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="floating-dot dot-one" /><div className="floating-dot dot-two" /><div className="art-page back-page" /><div className="art-page front-page"><div className="art-page-head"><span className="art-logo">G</span><span>GRAMMAR NOTES</span><CheckCheck size={19} /></div><div className="art-lines"><i /><i /><i /></div><div className="example-sentence">Every mistake is<br />a chance <span>to grow.</span></div><div className="art-lines short"><i /><i /></div><div className="art-answer"><span><Check size={13} /></span>理解规则，而不只是答案</div></div><div className="art-note"><div className="art-note-icon"><Target size={20} /></div><div><strong>发现薄弱知识点</strong><span>让练习更有针对性</span></div></div><div className="art-spark"><Sparkles size={21} /></div></div></section>{config && !config.aiConfigured && <div className="config-notice"><Sparkles size={15} /><span>当前尚未连接 AI 服务，可以先体验真实题样例回放。样例结果不代表实时模型输出。</span><Link href="/capture#samples">体验样例 <ArrowRight size={13} /></Link></div>}<section className="stats-grid">{[{ label: "已诊断试卷", value: overview?.stats.submissions ?? 0, unit: "份", icon: FileText, cls: "blue" }, { label: "待巩固错题", value: overview?.stats.incorrect ?? 0, unit: "题", icon: Target, cls: "orange" }, { label: "已完成练习", value: overview?.stats.practiced ?? 0, unit: "次", icon: CheckCheck, cls: "green" }, { label: "到期复习任务", value: overview?.stats.due ?? 0, unit: "项", icon: Clock3, cls: "purple" }].map(stat => <div className="stat-card" key={stat.label}><div><span>{stat.label}</span><strong>{stat.value}<small>{stat.unit}</small></strong></div><div className={`stat-icon ${stat.cls}`}><stat.icon size={22} /></div></div>)}</section><div className="home-columns"><section className="panel recent-panel"><div className="section-heading"><div><h2>最近的学习记录</h2><p>回到题目，找到进步的线索</p></div><Link href="/overview" className="subtle-link">查看全部<ChevronRight size={15} /></Link></div>{recent.length ? <div className="record-list">{recent.map(item => <SubmissionRow key={item.id} submission={item} />)}</div> : <EmptyState title="你的第一份学习记录，即将开始" action={<Link href="/capture" className="button button-secondary"><Plus size={16} />录入试卷</Link>}>上传一道疑问，或者选择一份样例，<br />一起把语法学清楚。</EmptyState>}</section><section className="review-callout"><div className="callout-icon"><BookOpen size={25} /></div><span className="eyebrow">SMALL STEPS, STEADY PROGRESS</span><h2>学过了，再练一次。</h2><p>根据错题知识点安排复习，<br />把“好像懂了”变成“真的会了”。</p><Link className="button button-primary" href="/review">{overview?.stats.due ? `开始 ${overview.stats.due} 项到期复习` : "查看我的复习"}<ArrowRight size={16} /></Link><div className="callout-bottom"><span /><span /><span /><span /><span /><span /><span /><span /></div></section></div><section className="how-section"><div className="section-heading"><div><h2>一次完整的学习循环</h2><p>从一道错题开始，不止于一个答案</p></div><span className="section-index">THE LEARNING LOOP</span></div><div className="how-grid">{[{ num: "01", icon: ScanLine, title: "录入与核对", text: "上传图片，核对题干和作答，让诊断基于准确的信息。" }, { num: "02", icon: Sparkles, title: "理解与归类", text: "查看知识点、原文证据和讲解，有疑问随时修正。" }, { num: "03", icon: GraduationCap, title: "练习与巩固", text: "围绕薄弱知识点练习，再用新的作答检验理解。" }].map(step => <div className="how-card" key={step.num}><div className="how-card-top"><step.icon size={24} /><span>{step.num}</span></div><h3>{step.title}</h3><p>{step.text}</p></div>)}</div></section></>;
}

function SubmissionRow({ submission }: { submission: Submission }) {
  const wrong = submission.questions.filter(question => question.gradeStatus === "incorrect").length;
  return <Link href={`/submissions/${submission.id}`} className="record-row"><div className="record-icon"><FileText size={21} /></div><div className="record-copy"><strong>{submission.title || "语法诊断"}</strong><div><span>{dateLabel(submission.createdAt, true)}</span><span className="record-divider">·</span>{submission.mode === "sample" ? <span>样例回放</span> : <span>自主录入</span>}{submission.status === "completed" && <><span className="record-divider">·</span><span>{wrong} 道待巩固</span></>}</div></div><StatusPill status={submission.status} /><ChevronRight size={17} className="muted" /></Link>;
}

function CapturePage({ overview, config, onChange }: { overview: Overview | null; config: RuntimeConfig | null; onChange: () => void }) {
  const router = useRouter();
  const sampleResource = useResource<SampleSummary[]>(overview ? null : "/api/samples");
  const samples = overview?.samples || sampleResource.data || [];
  const [captureId, setCaptureId] = useState<string | null>(null);
  const resource = useResource<Capture>(captureId ? `/api/captures/${captureId}` : null, value => active(value.status));
  const capture = resource.data;
  const [draft, setDraft] = useState<{ title: string; passage: string; questions: InputQuestion[] } | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  useEffect(() => { const id = new URLSearchParams(window.location.search).get("id"); if (id) setCaptureId(id); }, []);
  useEffect(() => { if (capture && !active(capture.status)) setDraft({ title: capture.title, passage: capture.passage, questions: capture.questions.map(item => ({ ...item })) }); }, [capture?.id, capture?.version, capture?.status]);
  useEffect(() => {
    if (!capture?.imagePath) return;
    let disposed = false; let objectUrl = "";
    void headersForRequest().then(headers => fetch(`/api/captures/${capture.id}/image`, { headers })).then(response => { if (!response.ok) throw new Error("图片暂时无法加载"); return response.blob(); }).then(blob => { if (!disposed) { objectUrl = URL.createObjectURL(blob); setImageUrl(objectUrl); } }).catch(() => {});
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [capture?.id, capture?.imagePath]);
  async function createCapture(selectedFile?: File, sampleId?: string) {
    if (busy) return;
    setBusy("recognize"); setError(""); setFeedback("");
    try {
      let body: FormData | object;
      if (selectedFile) {
        if (!["image/jpeg", "image/png"].includes(selectedFile.type)) throw new Error("请选择 JPG 或 PNG 图片。");
        if (selectedFile.size > 10 * 1024 * 1024) throw new Error("图片请控制在 10 MB 以内。");
        setFile(selectedFile); setImageUrl(URL.createObjectURL(selectedFile));
        const form = new FormData(); form.append("image", selectedFile); form.append("clientRequestId", requestKey(`capture:${selectedFile.name}:${selectedFile.size}:${selectedFile.lastModified}`)); body = form;
      } else body = { sampleId, clientRequestId: requestKey(`capture-sample:${sampleId}`) };
      const result = await request<Capture>("/api/captures", { method: "POST", body });
      sessionStorage.removeItem(`grammar-loop:${selectedFile ? `capture:${selectedFile.name}:${selectedFile.size}:${selectedFile.lastModified}` : `capture-sample:${sampleId}`}`); setCaptureId(result.id); resource.setData(result); setDraft(null);
      window.history.replaceState(null, "", `/capture?id=${result.id}`);
    } catch (e) { setError(e instanceof Error ? e.message : "上传失败"); } finally { setBusy(""); }
  }
  async function save(thenDiagnose = false) {
    if (!capture || !draft || busy) return;
    setBusy(thenDiagnose ? "diagnose" : "save"); setError(""); setFeedback("");
    try {
      if (!draft.passage.trim() || !draft.questions.length) throw new Error("请补充完整篇章和题目后继续。");
      const hasChanges = draft.title !== capture.title || draft.passage !== capture.passage || JSON.stringify(draft.questions) !== JSON.stringify(capture.questions);
      const saved = hasChanges ? await request<Capture>(`/api/captures/${capture.id}`, { method: "PATCH", body: { ...draft, expectedVersion: capture.version } }) : capture;
      resource.setData(saved);
      if (thenDiagnose) {
        const result = await request<Submission>("/api/submissions", { method: "POST", body: { captureId: saved.id, inputVersion: saved.version, clientRequestId: requestKey(`submission:${saved.id}:${saved.version}`) } });
        onChange(); router.push(`/submissions/${result.id}`);
      } else setFeedback("修改已保存。");
    } catch (e) { setError(e instanceof Error ? e.message : "保存失败"); } finally { setBusy(""); }
  }
  const updateQuestion = (index: number, field: keyof InputQuestion, value: string) => setDraft(previous => previous && ({ ...previous, questions: previous.questions.map((question, i) => i === index ? { ...question, [field]: value } : question) }));
  return <><PageHeading eyebrow="CAPTURE & CONFIRM" title="先把题目录清楚" description="上传完整语法填空篇章，核对识别内容，再开始诊断。" /><div className="stepper"><div className={!capture ? "step current" : "step done"}><span>{capture ? <Check size={14} /> : "1"}</span>录入题目</div><i /><div className={capture && !active(capture.status) ? "step current" : "step"}><span>2</span>核对内容</div><i /><div className="step"><span>3</span>生成诊断</div></div>{(error || resource.error) && <Notice kind="error">{error || resource.error}{resource.error && <button className="text-button" onClick={resource.refetch}>重新加载</button>}</Notice>}{feedback && <Notice kind="success">{feedback}</Notice>}{!capture ? <div className="capture-columns"><section className="panel upload-panel"><div className="section-heading"><div><h2>上传试卷图片</h2><p>清晰的原题，是可靠诊断的第一步。</p></div><span className="pill pill-blue">JPG / PNG</span></div><input ref={cameraInput} type="file" accept="image/jpeg,image/png" capture="environment" className="visually-hidden" aria-label="拍摄试卷图片" onChange={event => { const selected = event.target.files?.[0]; if (selected) void createCapture(selected); event.target.value = ""; }} /><input ref={fileInput} type="file" accept="image/jpeg,image/png" className="visually-hidden" aria-label="选择试卷图片" onChange={event => { const selected = event.target.files?.[0]; if (selected) void createCapture(selected); event.target.value = ""; }} /><button className={`upload-drop ${dragging ? "dragging" : ""}`} disabled={!!busy || (config !== null && !config.aiConfigured)} onClick={() => fileInput.current?.click()} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); const selected = event.dataTransfer.files[0]; if (selected && config?.aiConfigured) void createCapture(selected); }}><span className="upload-circle">{busy ? <LoaderCircle size={31} className="spin" /> : <ImagePlus size={31} />}</span><strong>{busy ? "正在上传图片…" : "点击选择，或拖入试卷图片"}</strong><span>单张图片，最大 10 MB</span><span className="button button-secondary"><Upload size={15} />选择图片</span></button><Button secondary className="camera-button" disabled={!!busy || (config !== null && !config.aiConfigured)} onClick={() => cameraInput.current?.click()}><Camera size={16} />用手机拍照录入</Button>{config && !config.aiConfigured && <Notice>图片识别需要连接 AI 服务。你可以先选择右侧真实题样例，体验完整流程。</Notice>}<div className="upload-tips"><h3><ScanLine size={16} />拍摄小提示</h3><p>包含完整篇章、空格题号及你的作答；保持文字清晰，尽量减少倾斜与阴影。</p><p>第一版支持单页 JPG / PNG，不支持 PDF、HEIC 或整卷混合题型。</p></div></section><section className="panel samples-panel" id="samples"><div className="section-heading"><div><span className="eyebrow">TRY THE LOOP</span><h2>先用一份真实题体验</h2><p>共 30 个来源小题，按完整篇章分组。</p></div></div><div className="sample-list">{samples.map(sample => <button key={sample.id} className="sample-card" disabled={!!busy} onClick={() => void createCapture(undefined, sample.id)}><div className="sample-card-top"><span className={`pill ${sample.split === "development" ? "pill-blue" : "pill-neutral"}`}>{sample.split === "development" ? "开发样本" : "冻结测试"} · {sample.questionCount} 题</span><ArrowRight size={16} /></div><strong>{sample.title}</strong><span className="sample-source"><ShieldCheck size={13} />{sample.verification.status === "pending" ? "题源待核验" : "题源与答案已交叉核验"}</span></button>)}</div>{!samples.length && <p className="muted">{sampleResource.error || "正在读取样例…"}</p>}<p className="small muted sample-disclaimer">样例会回放已记录结果；作答为人工构造，不代表真实学生表现。测试样本不在核对阶段提供答案。</p></section></div> : active(capture.status) ? <section className="panel"><Processing stage={capture.stage} /><div className="center"><span className="pill pill-neutral">每 2 秒同步处理状态</span></div></section> : capture.status === "failed" ? <section className="panel"><EmptyState icon={<CircleAlert size={27} />} title="这次识别没有完成" action={<div className="button-row"><Button onClick={async () => { setBusy("retry"); try { const result = await request<Capture>(`/api/captures/${capture.id}/retry`, { method: "POST" }); resource.setData(result); resource.refetch(); } catch (e) { setError(e instanceof Error ? e.message : "重试失败"); } finally { setBusy(""); } }} disabled={!!busy}><RefreshCw size={15} />重新识别</Button><Button secondary onClick={() => { setCaptureId(null); resource.setData(null); setDraft(null); window.history.replaceState(null, "", "/capture"); }}>重新上传</Button></div>}>{capture.error || "请检查图片是否清晰、是否包含完整题目后再试。"}</EmptyState></section> : draft ? <><div className="confirm-title"><div><h2>请核对识别内容</h2><p>模型可能误读字母或题号。请确认下方篇章与作答准确，空格使用 {"{{56}}"} 这样的格式。</p></div>{capture.mode === "sample" && <SamplePill />}</div>{capture.warnings.map((warning, index) => <Notice key={index}>{warning}</Notice>)}<div className="confirmation-grid"><section className="panel original-panel"><div className="panel-label"><ImagePlus size={16} />原始图片 / 篇章</div>{imageUrl ? <img className="source-image" src={imageUrl} alt="待核对的原始试卷" /> : <div className="source-passage"><span className="eyebrow">ORIGINAL PASSAGE</span><p>{capture.passage}</p><span className="pill pill-neutral">样例完整上下文</span></div>}</section><section className="panel edit-panel"><label className="field-label" htmlFor="capture-title">记录标题</label><input id="capture-title" value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /><label className="field-label" htmlFor="passage">完整篇章</label><textarea id="passage" className="passage-editor english" rows={10} value={draft.passage} onChange={event => setDraft({ ...draft, passage: event.target.value })} /><div className="question-table-label"><label className="field-label">题目与我的作答</label><button className="text-button" onClick={() => setDraft({ ...draft, questions: [...draft.questions, { id: crypto.randomUUID(), number: String(draft.questions.length + 1), cue: "", studentAnswer: "" }] })}><Plus size={14} />添加一题</button></div><div className="editable-questions"><div className="question-header"><span>题号</span><span>提示词</span><span>我的作答</span><span /></div>{draft.questions.map((question, index) => <div className="question-edit-row" key={question.id}><input aria-label={`第${index + 1}题题号`} value={question.number} onChange={event => updateQuestion(index, "number", event.target.value)} /><input aria-label={`第${question.number}题提示词`} value={question.cue} placeholder="无提示词" onChange={event => updateQuestion(index, "cue", event.target.value)} /><input aria-label={`第${question.number}题我的作答`} value={question.studentAnswer} placeholder="留空表示未作答" onChange={event => updateQuestion(index, "studentAnswer", event.target.value)} /><button className="icon-button" aria-label={`删除第${question.number}题`} onClick={() => setDraft({ ...draft, questions: draft.questions.filter((_, i) => i !== index) })}><X size={15} /></button></div>)}</div></section></div><div className="sticky-actions"><span><ShieldCheck size={15} />核对后再诊断，结果更可靠</span><div><Button secondary disabled={!!busy} onClick={() => void save()}>{busy === "save" && <LoaderCircle size={15} className="spin" />}保存修改</Button><Button disabled={!!busy || !draft.questions.length} onClick={() => void save(true)}>{busy === "diagnose" ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />}确认并开始诊断<ArrowRight size={16} /></Button></div></div></> : <div className="panel loading-inline"><LoaderCircle className="spin" />正在载入核对内容…</div>}</>;
}

function SubmissionPage({ id, tags, onChange }: { id: string; tags: Tag[]; onChange: () => void }) {
  const router = useRouter();
  const resource = useResource<Submission>(`/api/submissions/${id}`, value => active(value.status) || (!value.error && value.questions.some(question => question.explanationStatus === "pending")));
  const submission = resource.data;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [note, setNote] = useState("");
  const selected = submission?.questions.find(question => question.id === selectedId) || submission?.questions.find(question => question.gradeStatus === "incorrect") || submission?.questions[0];
  const selectQuestion = (question: QuestionResult) => { setSelectedId(question.id); setFeedback(""); setNote(""); };
  async function correctDiagnosis(tagId: string, disputed?: boolean) {
    if (!selected || busy) return;
    setBusy("tag"); setError(""); setFeedback("");
    try {
      const updated = await request<Submission>(`/api/questions/${selected.id}/diagnosis`, { method: "PATCH", body: { tagId, expectedVersion: selected.diagnosisVersion, note, ...(disputed !== undefined ? { disputed } : {}) } });
      resource.setData(updated); setFeedback("修改已保存，相关统计与复习任务已更新。"); setNote(""); onChange(); resource.refetch();
    } catch (e) { setError(e instanceof Error ? e.message : "修改失败"); } finally { setBusy(""); }
  }
  async function practice() {
    if (!selected || busy) return;
    setBusy("practice"); setError("");
    try { const result = await request<PublicPracticeSession>("/api/review/sessions", { method: "POST", body: { sourceQuestionId: selected.id, sourceSubmissionId: id, tagId: selected.tagId, mode: submission?.mode, clientRequestId: requestKey(`practice-question:${selected.id}:${selected.diagnosisVersion}`) } }); sessionStorage.removeItem(`grammar-loop:practice-question:${selected.id}:${selected.diagnosisVersion}`); onChange(); router.push(`/review/${result.id}`); } catch (e) { setError(e instanceof Error ? e.message : "练习生成失败"); } finally { setBusy(""); }
  }
  if (!submission) return <><Link className="back-link" href="/overview"><ArrowLeft size={15} />返回学习记录</Link>{resource.error ? <Notice kind="error">{resource.error}<button className="text-button" onClick={resource.refetch}>重试</button></Notice> : <div className="panel loading-inline"><LoaderCircle className="spin" />正在读取诊断…</div>}</>;
  const correct = submission.questions.filter(q => q.gradeStatus === "correct").length;
  const incorrect = submission.questions.filter(q => q.gradeStatus === "incorrect").length;
  const uncertain = submission.questions.filter(q => q.gradeStatus === "uncertain").length;
  const aiReference = submission.questions.some(q => q.answerSource === "ai");
  return <><Link className="back-link" href="/overview"><ArrowLeft size={15} />返回学习记录</Link><PageHeading eyebrow="UNDERSTAND YOUR MISTAKES" title={submission.title || "这一份语法诊断"} description={`${dateLabel(submission.createdAt, true)} · 原题证据、判断与讲解，都可以在这里核对。`} action={<div className="button-row">{submission.mode === "sample" && <SamplePill />}<Link href={`/capture?id=${submission.captureId}`} className="button button-secondary"><ScanLine size={15} />核对原始输入</Link></div>} />{(resource.error || error) && <Notice kind="error">{error || resource.error}<button className="text-button" onClick={resource.refetch}>重新加载</button></Notice>}{submission.error && !active(submission.status) && submission.status !== "failed" && <Notice kind="error">{submission.error}<Button secondary disabled={!!busy} onClick={async () => { setBusy("retry"); try { const result = await request<Submission>(`/api/submissions/${id}/retry`, { method: "POST" }); resource.setData(result); resource.refetch(); } catch (e) { setError(e instanceof Error ? e.message : "重试失败"); } finally { setBusy(""); } }}><RefreshCw size={14} />重试讲解更新</Button></Notice>}{active(submission.status) ? <section className="panel"><Processing stage={submission.stage} title="正在把错误讲清楚" /></section> : submission.status === "failed" ? <section className="panel"><EmptyState icon={<CircleAlert size={27} />} title="诊断暂时没有完成" action={<Button disabled={!!busy} onClick={async () => { setBusy("retry"); try { const result = await request<Submission>(`/api/submissions/${id}/retry`, { method: "POST" }); resource.setData(result); resource.refetch(); } catch (e) { setError(e instanceof Error ? e.message : "重试失败"); } finally { setBusy(""); } }}><RefreshCw size={15} />重新诊断</Button>}>{submission.error || "原始输入已保留，可以稍后重试。"}</EmptyState></section> : <>{aiReference && <Notice>本次包含 AI 参考答案，相关正误为暂定判断，不作为正式考试得分。对不确定的内容，你可以标记异议。</Notice>}{submission.status === "needs_input" && <Notice>部分内容需要补充或确认，请返回核对原始输入后重新诊断。</Notice>}<div className="diagnosis-summary"><div className="summary-main"><span className="summary-symbol"><FileText size={25} /></span><div><span>{aiReference ? "暂定诊断概览" : "语法部分诊断"}</span><strong>{submission.questions.length}<small>道题目</small></strong>{submission.questions.length > 0 && submission.questions.every(q => q.maxScore !== null) && <span className="reference-score">参考得分 {submission.questions.reduce((n, q) => n + (q.score ?? 0), 0)}{uncertain > 0 ? `–${submission.questions.reduce((n, q) => n + (q.score ?? 0) + (q.gradeStatus === "uncertain" ? q.maxScore ?? 0 : 0), 0)}` : ""} / {submission.questions.reduce((n, q) => n + (q.maxScore ?? 0), 0)}</span>}</div></div><div className="summary-number green-text"><strong>{correct}</strong><span><Check size={13} />{aiReference ? "暂定正确" : "正确"}</span></div><div className="summary-number orange-text"><strong>{incorrect}</strong><span><Target size={13} />待巩固</span></div><div className="summary-number"><strong>{uncertain}</strong><span><CircleAlert size={13} />待确认</span></div></div><div className="diagnosis-grid"><aside className="panel question-sidebar"><div className="panel-label"><FileText size={16} />逐题查看<span>{submission.questions.length} 题</span></div><div className="question-picker">{submission.questions.map(question => <button className={`question-pick ${selected?.id === question.id ? "selected" : ""}`} key={question.id} onClick={() => selectQuestion(question)}><span className={`question-number status-${question.gradeStatus}`}>{question.number}</span><div><strong>{tagName(tags, question.tagId)}</strong><span>{question.studentAnswer || "未作答"}</span></div>{question.gradeStatus === "correct" ? <Check size={15} className="green-text" /> : question.gradeStatus === "uncertain" ? <CircleAlert size={15} /> : <ChevronRight size={15} />}</button>)}</div><details open className="passage-details"><summary>查看完整篇章</summary><p className="english">{submission.passage}</p></details></aside>{selected ? <section className="panel diagnosis-detail"><div className="detail-heading"><div><span className="eyebrow">QUESTION {selected.number}</span><h2>{tagName(tags, selected.tagId)}</h2></div><StatusPill status={selected.gradeStatus} /></div>{selected.disputed && <Notice>你已对这道题标记异议，相关结论需进一步核对。</Notice>}<div className="answer-comparison"><div><span>我的作答</span><strong className={selected.gradeStatus === "incorrect" ? "wrong-answer" : ""}>{selected.studentAnswer || "未作答"}</strong></div><ArrowRight size={19} /><div><span>{selected.answerSource === "ai" ? "AI 参考答案" : selected.answerSource === "published_reference" ? "公开参考答案 · 交叉核对" : "人工核验答案"}</span><strong>{selected.referenceAnswers.join(" / ") || "尚待确认"}</strong></div></div>{selected.maxScore !== null && <p className="cue-line">本题参考得分：{selected.score ?? "待确认"} / {selected.maxScore}</p>}{selected.cue && <p className="cue-line">提示词：<span className="english">{selected.cue}</span></p>}{selected.errorPattern && <div className="error-pattern"><Target size={16} /><span>{selected.errorPattern}</span></div>}<div className="explanation"><h3><Sparkles size={17} />把这一题讲清楚</h3>{selected.explanationStatus === "pending" ? <div className="loading-inline"><LoaderCircle size={17} className="spin" />知识点已更新，正在重新生成讲解…</div> : <div className="explanation-sections">{[{ label: "语法规则", text: selected.explanation.rule }, { label: "原文证据", text: selected.explanation.evidence }, { label: "为什么这样填", text: selected.explanation.why }, { label: "再看一个例子", text: selected.explanation.example }].filter(block => block.text).map((block, index) => <div className={`explanation-block block-${index}`} key={block.label}><span className="explanation-index">0{index + 1}</span><div><h4>{block.label}</h4><p>{block.text}</p></div></div>)}</div>}</div>{selected.possibleCause && <div className="cause-note"><CircleAlert size={15} /><div><strong>可能的原因</strong><p>{selected.possibleCause}</p><span>这是辅助反思的假设，不能仅凭一道作答确定。</span></div></div>}<div className="correction-section"><div className="section-heading"><div><h3>你也可以修正诊断</h3><p>修改知识点后，相关讲解与复习会随之更新。</p></div><ShieldCheck size={20} /></div><div className="correction-row"><label className="field-label" htmlFor="tag-select">主要知识点</label><select id="tag-select" value={selected.tagId} disabled={!!busy} onChange={event => void correctDiagnosis(event.target.value)}>{!tags.some(tag => tag.id === selected.tagId) && <option value={selected.tagId}>{selected.tagId || "待归类"}</option>}{tags.map(tag => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select></div><input className="correction-note" aria-label="修正备注" placeholder="补充你的判断（选填）" value={note} onChange={event => setNote(event.target.value)} /><div className="correction-save"><Button secondary disabled={!!busy || !note.trim()} onClick={() => void correctDiagnosis(selected.tagId)}>{busy === "tag" && <LoaderCircle size={13} className="spin" />}保存补充判断</Button></div><button className="text-button dispute-button" disabled={!!busy} onClick={() => void correctDiagnosis(selected.tagId, !selected.disputed)}>{selected.disputed ? <Check size={14} /> : <CircleAlert size={14} />}{selected.disputed ? "取消异议标记" : "我对这道题的判断有异议"}</button>{feedback && <Notice kind="success">{feedback}</Notice>}</div><div className="detail-bottom"><span>理解之后，用一道新题检验。</span><Button disabled={!!busy || !selected.tagId || selected.gradeStatus === "uncertain" || selected.disputed} onClick={() => void practice()}>{busy === "practice" ? <LoaderCircle size={16} className="spin" /> : <BookOpen size={16} />}练习这个知识点<ArrowRight size={16} /></Button></div></section> : <section className="panel"><EmptyState title="还没有可展示的逐题结果">请先核对输入，或重试诊断。</EmptyState></section>}</div></>}</>;
}

function ReviewPage({ overview, onChange }: { overview: Overview | null; onChange: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const tasks = overview?.reviewTasks.filter(task => task.status === "pending").sort((a, b) => a.dueAt.localeCompare(b.dueAt)) || [];
  const due = tasks.filter(task => new Date(task.dueAt).getTime() <= Date.now());
  const sessions = overview?.sessions.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6) || [];
  async function start(body: Record<string, unknown>, scope: string) {
    if (busy) return; setBusy(scope); setError("");
    try { const result = await request<PublicPracticeSession>("/api/review/sessions", { method: "POST", body: { ...body, clientRequestId: requestKey(`review:${scope}`) } }); sessionStorage.removeItem(`grammar-loop:review:${scope}`); onChange(); router.push(`/review/${result.id}`); } catch (e) { setError(e instanceof Error ? e.message : "生成失败"); } finally { setBusy(""); }
  }
  return <><PageHeading eyebrow="PRACTICE WITH PURPOSE" title="再练一次，记得更牢" description="根据错题知识点安排练习，用新的作答检验理解。" />{error && <Notice kind="error">{error}</Notice>}<section className="review-banner"><div><span className="eyebrow">YOUR NEXT SMALL STEP</span><h2>{due.length ? `有 ${due.length} 项复习，等你来完成。` : "不赶进度，把一个知识点弄懂。"}</h2><p>{due.length ? "先处理到期任务，让刚学会的知识留下来。" : "可以从下方知识点开始练习，或回到一份错题诊断。"}</p></div><div className="review-banner-icon"><BookOpen size={54} /></div>{due[0] && <Button disabled={!!busy} onClick={() => void start({ reviewTaskId: due[0].id, tagId: due[0].tagId, sourceQuestionId: due[0].sourceQuestionId, sourceSubmissionId: due[0].sourceSubmissionId }, due[0].id)}>{busy ? <LoaderCircle size={16} className="spin" /> : <ArrowRight size={17} />}开始到期复习</Button>}</section><div className="home-columns"><section className="panel"><div className="section-heading"><div><h2>我的复习计划</h2><p>按到期时间排列，完成练习后更新下一次安排。</p></div><span className="pill pill-blue">{tasks.length} 项待复习</span></div>{tasks.length ? <div className="task-list">{tasks.map(task => <div className="task-row" key={task.id}><div className="task-icon"><Target size={19} /></div><div><strong>{tagName(overview?.tags || [], task.tagId)}</strong><span>{new Date(task.dueAt).getTime() <= Date.now() ? "已到复习时间" : `${dateLabel(task.dueAt)} 复习`} · 第 {task.level + 1} 轮{task.tentative ? " · 暂定诊断" : ""}</span></div><Button secondary disabled={!!busy} onClick={() => void start({ reviewTaskId: task.id, tagId: task.tagId, sourceQuestionId: task.sourceQuestionId, sourceSubmissionId: task.sourceSubmissionId }, task.id)}>{busy === task.id ? <LoaderCircle size={14} className="spin" /> : "开始"}<ChevronRight size={14} /></Button></div>)}</div> : <EmptyState title="还没有待复习任务" action={<Link href="/capture" className="button button-secondary">录入第一份错题<ArrowRight size={15} /></Link>}>完成一次诊断后，系统会根据错题知识点安排复习。</EmptyState>}</section><section className="panel"><div className="section-heading"><div><h2>按知识点练一练</h2><p>选择一个方向，专注完成一次练习。</p></div></div><div className="tag-practice-grid">{(overview?.tags || []).map((tag, index) => <button key={tag.id} disabled={!!busy} onClick={() => void start({ tagId: tag.id }, `tag:${tag.id}`)}><span className={`tag-dot dot-color-${index % 4}`} /><strong>{tag.name}</strong><ChevronRight size={14} /></button>)}</div>{!overview?.tags.length && <p className="muted small">{overview === null ? "正在加载知识点…" : "暂无可用知识点"}</p>}<p className="small muted practice-tip"><Sparkles size={14} />样例练习使用固定回放题；实时 AI 练习需要连接服务。</p></section></div><section className="panel section-gap"><div className="section-heading"><div><h2>最近的练习</h2><p>继续未完成的练习，或回顾已经提交的答案。</p></div></div>{sessions.length ? sessions.map(session => <Link key={session.id} className="record-row" href={`/review/${session.id}`}><div className="record-icon"><BookOpen size={20} /></div><div className="record-copy"><strong>{tagName(overview?.tags || [], session.tagId)}专项练习</strong><div><span>{dateLabel(session.createdAt, true)}</span><span>·</span><span>{session.results.length ? `答对 ${session.results.filter(result => result.correct).length} / ${session.results.length} 题` : "尚未提交"}</span>{session.mode === "sample" && <span>· 样例回放</span>}</div></div><span className={`pill ${session.results.length ? "status-correct" : "pill-neutral"}`}>{session.results.length ? "已提交" : active(session.status) ? "生成中" : "继续练习"}</span><ChevronRight size={16} /></Link>) : <EmptyState title="练习记录会保存在这里">每一次认真作答，都会留下学习的足迹。</EmptyState>}</section></>;
}

function PracticePage({ id, tags, onChange }: { id: string; tags: Tag[]; onChange: () => void }) {
  const resource = useResource<PublicPracticeSession>(`/api/review/sessions/${id}`, value => active(value.status));
  const session = resource.data;
  const [responses, setResponses] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { try { const saved = sessionStorage.getItem(`grammar-loop:practice-draft:${id}`); if (saved) setResponses(JSON.parse(saved)); } catch {} }, [id]);
  function update(itemId: string, response: string) { setResponses(previous => { const next = { ...previous, [itemId]: response }; sessionStorage.setItem(`grammar-loop:practice-draft:${id}`, JSON.stringify(next)); return next; }); }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!session || busy) return; setBusy(true); setError("");
    try { const result = await request<PublicPracticeSession>(`/api/review/sessions/${id}/attempts`, { method: "POST", body: { responses: session.items.map(item => ({ itemId: item.id, response: responses[item.id] || "" })), clientRequestId: requestKey(`attempt:${id}`) } }); resource.setData(result); onChange(); } catch (e) { setError(e instanceof Error ? e.message : "提交失败"); } finally { setBusy(false); }
  }
  const finished = !!session?.results.length;
  const answered = session?.items.filter(item => responses[item.id]?.trim()).length || 0;
  return <div className="practice-container"><Link className="back-link" href="/review"><ArrowLeft size={15} />返回针对性复习</Link><PageHeading eyebrow="A LITTLE PRACTICE, A DEEPER UNDERSTANDING" title={session ? `${tagName(tags, session.tagId)}专项练习` : "准备开始练习"} description={finished ? "答案已经提交，看看这一次理解得怎么样。" : "先独立想一想。提交后再查看参考答案与讲解。"} action={session?.mode === "sample" ? <SamplePill /> : session ? <span className="pill pill-blue">AI 生成练习</span> : undefined} />{(error || resource.error) && <Notice kind="error">{error || resource.error}{resource.error && <button className="text-button" onClick={resource.refetch}>重试</button>}</Notice>}{!session ? <div className="panel loading-inline"><LoaderCircle className="spin" />正在读取练习…</div> : active(session.status) ? <section className="panel"><Processing title="正在准备针对性练习" stage="围绕你的知识点生成题目，并检查答案与讲解。" /></section> : session.status === "failed" ? <section className="panel"><EmptyState title="这次练习没有生成成功" action={<div className="button-row"><Button disabled={busy} onClick={async () => { setBusy(true); setError(""); try { const result = await request<PublicPracticeSession>(`/api/review/sessions/${id}/retry`, { method: "POST" }); resource.setData(result); resource.refetch(); } catch (e) { setError(e instanceof Error ? e.message : "重试失败"); } finally { setBusy(false); } }}><RefreshCw size={15} />重新生成练习</Button><Link href="/review" className="button button-secondary">返回复习</Link></div>}>{session.error || "请稍后再试。"}</EmptyState></section> : <>{session.sampleLabel && <Notice>{session.sampleLabel}</Notice>}{finished && <div className="practice-score"><span className="score-check"><CheckCheck size={30} /></span><div><span>这次练习已完成</span><h2>{session.results.filter(result => result.correct).length}<small> / {session.results.length} 题答对</small></h2></div><div className="score-next">{session.nextDueAt ? <><Clock3 size={16} /><span>下次复习<br /><strong>{dateLabel(session.nextDueAt)}</strong></span></> : <span>继续保持每一次认真思考</span>}</div></div>}<form onSubmit={submit}><div className="practice-items">{session.items.map((item, index) => { const result = session.results.find(value => value.itemId === item.id); return <section className={`panel practice-item ${result ? result.correct ? "practice-correct" : "practice-incorrect" : ""}`} key={item.id}><div className="practice-item-head"><span className="question-order">QUESTION {String(index + 1).padStart(2, "0")}</span>{result ? <StatusPill status={result.correct ? "correct" : "incorrect"} /> : <span className="pill pill-neutral">语法填空</span>}</div><p className="practice-prompt english">{item.prompt}</p>{item.cue && <p className="cue-line">提示词：<span className="english">{item.cue}</span></p>}<label className="field-label" htmlFor={`practice-${item.id}`}>我的答案</label><input id={`practice-${item.id}`} className="practice-answer english" placeholder="填写你的答案" required value={result ? result.response : responses[item.id] || ""} disabled={finished || busy} onChange={event => update(item.id, event.target.value)} autoComplete="off" />{result && <div className="practice-explanation"><div><span>练习参考答案</span><strong className="english">{result.answers.join(" / ")}</strong></div><p>{result.explanation}</p></div>}</section>; })}</div>{!finished ? <div className="sticky-actions practice-submit"><span>{answered} / {session.items.length} 题已作答<span className="small muted"> · 作答自动保存在本次浏览器会话</span></span><Button type="submit" disabled={busy || answered !== session.items.length || !session.items.length}>{busy ? <LoaderCircle size={16} className="spin" /> : <CheckCheck size={17} />}提交并查看讲解<ArrowRight size={16} /></Button></div> : <div className="center practice-finish"><Link href="/review" className="button button-primary">回到复习计划<ArrowRight size={16} /></Link>{session.sourceSubmissionId && <Link href={`/submissions/${session.sourceSubmissionId}`} className="button button-secondary">回看原始错题</Link>}</div>}</form></>}</div>;
}

function OverviewPage({ overview }: { overview: Overview | null }) {
  const [filter, setFilter] = useState("all");
  const submissions = (overview?.submissions || []).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).filter(item => filter === "all" || item.mode === filter);
  const total = overview?.stats.byTag.reduce((sum, tag) => sum + tag.count, 0) || 0;
  return <><PageHeading eyebrow="YOUR LEARNING, IN FOCUS" title="看见自己的学习轨迹" description="汇总自主录入与样例回放；样例作答为人工构造。先看证据，再决定下一步。" action={<Link href="/capture" className="button button-primary"><Plus size={16} />录入新试卷</Link>} /><div className="overview-grid"><section className="panel distribution-panel"><div className="section-heading"><div><h2>待巩固知识点分布</h2><p>按当前错题归类统计，标签修正后同步更新。</p></div><span className="pill pill-neutral">共 {total} 题</span></div><div className="source-counts"><span>样例错题 <strong>{overview?.stats.bySource.sample ?? 0}</strong></span><span>AI 暂定错题 <strong>{overview?.stats.bySource.ai ?? 0}</strong></span><span>参考答案错题 <strong>{overview?.stats.bySource.published ?? 0}</strong></span></div>{total ? <div className="distribution-bars">{overview?.stats.byTag.filter(item => item.count > 0).sort((a, b) => b.count - a.count).map((item, index) => <div className="distribution-row" key={item.tagId}><div><span>{tagName(overview.tags, item.tagId)}</span><strong>{item.count}<small>题</small></strong></div><div className="bar-track"><span className={`bar-${index % 4}`} style={{ width: `${item.count / total * 100}%` }} /></div></div>)}</div> : <EmptyState icon={<ChartNoAxesCombined size={26} />} title="有了作答，才有分析">完成诊断后，这里会展示需要巩固的知识点分布。</EmptyState>}<p className="stat-caveat"><CircleAlert size={13} />错题数量不等同于能力掌握度。样例回放与 AI 暂定诊断需要结合实际学习情况解读。</p></section><section className="overview-note"><span className="note-number">01 / ONE STEP AT A TIME</span><div className="note-illustration"><Target size={60} /><span><Check size={20} /></span></div><h2>少一点猜测，<br />多一点理解。</h2><p>你可以修改知识点、标记异议，再用针对性练习验证自己的判断。</p><Link href="/review">去做一次练习<ArrowRight size={16} /></Link></section></div><section className="panel section-gap"><div className="section-heading history-heading"><div><h2>全部诊断记录</h2><p>保留每一次输入与诊断，随时回看。</p></div><div className="segmented" role="group" aria-label="筛选诊断记录">{[{ id: "all", name: "全部" }, { id: "live", name: "自主录入" }, { id: "sample", name: "样例回放" }].map(item => <button className={filter === item.id ? "selected" : ""} onClick={() => setFilter(item.id)} key={item.id}>{item.name}</button>)}</div></div>{submissions.length ? submissions.map(item => <SubmissionRow key={item.id} submission={item} />) : <EmptyState title={filter === "all" ? "记录，从第一次开始" : "还没有这类记录"} action={<Link href="/capture" className="button button-secondary">录入或体验样例<ArrowRight size={15} /></Link>}>真实的进步，来自每一道认真想过的题。</EmptyState>}</section></>;
}

function LoginPage({ configured }: { configured: boolean }) {
  const router = useRouter();
  const [register, setRegister] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); const client = supabase(); if (!client || busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = register ? await client.auth.signUp({ email, password }) : await client.auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;
      if (register && !result.data.session) setMessage("注册成功，请检查邮箱并完成确认后再登录。");
      else router.push("/");
    } catch (e) { setError(e instanceof Error ? e.message : "登录未完成，请重试。"); } finally { setBusy(false); }
  }
  return <div className="login-container"><section className="login-intro"><div className="login-art"><BookOpen size={49} /><span><Sparkles size={23} /></span></div><span className="eyebrow">WELCOME TO YOUR LEARNING LOOP</span><h1>让每次理解，<br />都有下一步。</h1><p>登录后保存你的诊断、复习任务和练习记录。<br />回到这里，就能接着上次的进度。</p><div className="login-feature"><ShieldCheck size={18} /><span>自己的作答，自己的学习轨迹</span></div></section><section className="panel login-form"><h2>{register ? "创建学习账号" : "欢迎回来"}</h2><p>{register ? "从第一道题，开始你的学习循环。" : "登录账号，继续你的语法学习。"}</p>{!configured ? <><Notice>当前使用本地体验模式，无需登录。云端账号服务尚未配置。</Notice><Link className="button button-primary full-width" href="/">进入本地体验<ArrowRight size={16} /></Link></> : <form onSubmit={submit}>{error && <Notice kind="error">{error}</Notice>}{message && <Notice kind="success">{message}</Notice>}<label className="field-label" htmlFor="email">邮箱</label><input id="email" type="email" autoComplete="email" placeholder="you@example.com" value={email} required onChange={event => setEmail(event.target.value)} /><label className="field-label" htmlFor="password">密码</label><input id="password" type="password" autoComplete={register ? "new-password" : "current-password"} minLength={6} placeholder="至少 6 位密码" value={password} required onChange={event => setPassword(event.target.value)} /><Button type="submit" disabled={busy} className="full-width">{busy && <LoaderCircle size={16} className="spin" />}{register ? "注册账号" : "登录"}<ArrowRight size={16} /></Button><div className="login-toggle">{register ? "已经有账号？" : "还没有账号？"}<button type="button" className="text-button" onClick={() => { setRegister(!register); setError(""); setMessage(""); }}>{register ? "去登录" : "创建账号"}</button></div></form>}<p className="login-privacy"><ShieldCheck size={13} />登录状态由 Supabase 安全管理</p></section></div>;
}
