import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

// Catches any render error so the app shows the actual message instead of a blank
// white screen — makes crashes diagnosable in production.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    this.setState({ info });
    // eslint-disable-next-line no-console
    console.error("FRONTAGE render error:", error, info);
  }
  render() {
    if (this.state.error) {
      const e = this.state.error;
      return (
        <div style={{ fontFamily: "monospace", padding: 24, maxWidth: 900, margin: "40px auto", color: "#1b1930" }}>
          <h2 style={{ color: "#d14a3c" }}>Something errored while rendering</h2>
          <p>Copy this and send it over so it can be fixed:</p>
          <pre style={{ whiteSpace: "pre-wrap", background: "#f4f4fb", border: "1px solid #e5e3f1", borderRadius: 8, padding: 14, fontSize: 12.5 }}>
{String(e && e.message || e)}
{"\n\n"}{e && e.stack ? e.stack : ""}
{this.state.info && this.state.info.componentStack ? "\n\nComponent stack:" + this.state.info.componentStack : ""}
          </pre>
          <button onClick={() => location.reload()} style={{ marginTop: 12, padding: "8px 16px", cursor: "pointer" }}>Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
