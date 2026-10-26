import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api.js";
import { questionsStore } from "../lib/store.js";

type QuestionRow = {
  question_id: string;
  question_title: string;
  answer_count: number;
  upvoted_count: number;
  faved_count: number;
  latest_time: string | null;
};

const fmtNum = (n: any) => {
  const num = Number(n) || 0;
  if (num >= 10000) return (num / 10000).toFixed(1).replace(/\.0$/, "") + " 万";
  return String(num);
};

const fmtDate = (val: any) => {
  if (!val) return "";
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
};

function SourceTags({ upvoted, faved }: { upvoted: number; faved: number }) {
  return (
    <>
      {upvoted > 0 && (
        <span className="detail-tag" style={{ background: "var(--zhihu-blue-bg)", color: "var(--zhihu-blue)" }}>
          赞同 {upvoted}
        </span>
      )}
      {faved > 0 && (
        <span className="detail-tag" style={{ background: "rgba(46,125,50,0.08)", color: "#2e7d32" }}>
          收藏 {faved}
        </span>
      )}
    </>
  );
}

export default function QuestionsPage() {
  const { id: routeId } = useParams();

  if (routeId) return <QuestionDetail questionId={routeId} />;
  return <QuestionList />;
}

function QuestionList() {
  const [rows, setRows] = useState<QuestionRow[]>(questionsStore.list);
  const [page, setPage] = useState(questionsStore.page);
  const [total, setTotal] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const fetchPage = async (p: number) => {
    setIsLoading(true);
    setError("");
    try {
      const res = await api<{ data: QuestionRow[]; total?: number }>(`/api/questions?page=${p}`);
      setRows(prev => (p === 1 ? res.data : [...prev, ...res.data]));
      questionsStore.list = p === 1 ? res.data : [...rows, ...res.data];
      setPage(p);
      questionsStore.page = p;
      if (typeof res.total === "number") setTotal(res.total);
    } catch (e: any) {
      setError(e?.message || "问题列表加载失败");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (rows.length === 0) fetchPage(1);
  }, []);

  return (
    <div>
      {error && <div className="card" style={{ color: "var(--zhihu-red)", fontSize: 14 }}>{error}</div>}

      <div className="card" style={{ marginBottom: 10, padding: "14px 18px" }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>按问题整理</h1>
        <p style={{ margin: "6px 0 0", color: "var(--zhihu-meta)", fontSize: 13 }}>
          你赞同或收藏过的回答，按所属问题聚合{total !== null ? ` · 共 ${total} 个问题` : ""}
        </p>
      </div>

      <div className="cards">
        {rows.map(q => (
          <Link
            className="card"
            key={q.question_id}
            to={`/questions/${encodeURIComponent(q.question_id)}`}
          >
            <h3 style={{ marginBottom: 8 }}>{q.question_title || q.question_id}</h3>
            <div className="card-footer">
              <span className="stat" style={{ color: "var(--zhihu-blue)", background: "var(--zhihu-blue-bg)", borderRadius: 4, padding: "2px 10px", fontWeight: 500 }}>
                {fmtNum(q.answer_count)} 个回答
              </span>
              <SourceTags upvoted={q.upvoted_count} faved={q.faved_count} />
              <span className="footer-right">
                {q.latest_time ? "最近 " : ""}{fmtDate(q.latest_time)}
              </span>
            </div>
          </Link>
        ))}
        {isLoading && <p className="loading-state">加载中...</p>}
        {!isLoading && rows.length === 0 && !error && (
          <p className="empty-state">还没有可整理的内容——先让同步抓一轮赞同和收藏</p>
        )}
        {!isLoading && rows.length > 0 && rows.length < (total ?? Infinity) && (
          <button
            className="btn-primary"
            style={{ display: "block", margin: "10px auto" }}
            onClick={() => fetchPage(page + 1)}
          >
            加载更多
          </button>
        )}
      </div>
    </div>
  );
}

function QuestionDetail({ questionId }: { questionId: string }) {
  const [data, setData] = useState<any>(null);
  const [loadError, setLoadError] = useState("");
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    api<{ question: any; answers: any[] }>(`/api/questions/${encodeURIComponent(questionId)}`)
      .then(d => {
        if (!d?.question) {
          setLoadError("问题不存在");
          return;
        }
        setData(d);
      })
      .catch((e: any) => setLoadError(e?.message || "加载失败"));
  }, [questionId, retryKey]);

  if (!data) {
    if (loadError) {
      return (
        <div className="loading-state">
          <p style={{ marginBottom: 12 }}>{loadError}</p>
          <button
            onClick={() => { setLoadError(""); setRetryKey(k => k + 1); }}
            style={{ padding: "8px 20px", border: "none", borderRadius: 6, background: "var(--zhihu-blue)", color: "#fff", cursor: "pointer" }}
          >
            重试
          </button>
        </div>
      );
    }
    return <div className="loading-state">加载中...</div>;
  }

  const stripHtml = (html: string) => html ? html.replace(/<[^>]+>/g, "").substring(0, 150) + "..." : "";

  return (
    <>
      <button className="back-fab" onClick={() => window.history.back()}>
        ← <span>返回</span>
      </button>

      <div className="card" style={{ marginBottom: 10 }}>
        <h1 className="question-title">{data.question.question_title}</h1>
        <p style={{ color: "var(--zhihu-meta)", fontSize: 14, margin: "8px 0 0" }}>
          我赞同/收藏过的回答 · 共 {data.answers.length} 条
        </p>
      </div>

      <div className="cards">
        {data.answers.map((a: any) => (
          <Link className="card" key={a.pk} to={`/contents/${encodeURIComponent(a.pk)}`}>
            {a.author_name && (
              <div className="card-author">
                {a.author_avatar && <img src={a.author_avatar} alt="" referrerPolicy="no-referrer" />}
                <span className="author-name">{a.author_name}</span>
                {a.author_headline && <span className="author-headline">{a.author_headline}</span>}
              </div>
            )}
            {a.excerpt && <p className="card-excerpt">{stripHtml(a.excerpt)}</p>}
            <div className="card-footer">
              <span className="stat" style={{ color: "var(--zhihu-blue)", background: "var(--zhihu-blue-bg)", borderRadius: 4, padding: "2px 10px", fontWeight: 500 }}>
                ▲ {fmtNum(a.voteup_count)}
              </span>
              {a.upvote_time
                ? <span className="detail-tag" style={{ background: "var(--zhihu-blue-bg)", color: "var(--zhihu-blue)" }}>我赞同于 {fmtDate(a.upvote_time)}</span>
                : <span className="detail-tag" style={{ background: "rgba(46,125,50,0.08)", color: "#2e7d32" }}>收藏中</span>}
              <span className="footer-right">{a.upvote_time || a.updated_time || a.last_seen_at ? "收录于 " : ""}{fmtDate(a.upvote_time || a.updated_time || a.last_seen_at)}</span>
            </div>
          </Link>
        ))}
        {data.answers.length === 0 && <p className="empty-state">这个问题下暂无相关回答</p>}
      </div>
    </>
  );
}
