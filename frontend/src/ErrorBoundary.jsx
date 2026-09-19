import React from 'react';

/**
 * Keeps a failing screen from blanking the whole app: the top bar and header
 * stay usable so the user can navigate away, and the error is shown rather
 * than swallowed.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(prev) {
    // A new route mounts a fresh screen — clear the previous failure.
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="screen">
        <div className="err banner">
          This screen failed to render: {this.state.error.message}
        </div>
        <p className="small muted">
          Go Home to pick another screen, or reload to try again.
        </p>
      </div>
    );
  }
}
