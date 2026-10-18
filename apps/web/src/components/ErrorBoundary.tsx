import { Component, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * 兜底错误边界：任一页面组件抛错时不至于整站白屏。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("页面渲染出错:", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="card" style={{ textAlign: "center", padding: "40px 20px" }}>
          <h3 style={{ marginTop: 0 }}>页面出错了</h3>
          <p style={{ color: "var(--zhihu-meta)", fontSize: 14, wordBreak: "break-all" }}>
            {this.state.error.message || "未知错误"}
          </p>
          <button className="btn-primary" onClick={() => this.setState({ error: null })}>
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
