import { Component } from "react";

// 画面の一部でエラーが起きても真っ白にしない
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(prev) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="card">
        <h2>この画面の表示でエラーが起きました</h2>
        <p className="hint">ほかのタブは使えます。下の内容をスクショで送ってください。</p>
        <pre className="err">{String(this.state.error?.message || this.state.error)}</pre>
        <button type="button" className="ghost" onClick={() => this.setState({ error: null })}>
          もう一度表示する
        </button>
      </section>
    );
  }
}
