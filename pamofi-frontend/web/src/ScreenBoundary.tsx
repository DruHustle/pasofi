import { Component, createRef, type ReactNode } from 'react';

/** Keep navigation available when a deferred screen or render fails. Never replay a mutation. */
export default class ScreenBoundary extends Component<{
  children: ReactNode;
  screen: string;
  onBrowse: () => void;
}, { failed: boolean }> {
  state = { failed: false };
  private heading = createRef<HTMLHeadingElement>();

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidCatch() { this.heading.current?.focus(); }

  componentDidUpdate(previous: Readonly<{ screen: string }>) {
    if (this.state.failed && previous.screen !== this.props.screen) this.setState({ failed: false });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <section className="pf-empty pf-screen-error" aria-labelledby="screen-error-heading">
      <h1 id="screen-error-heading" tabIndex={-1} ref={this.heading}>Let’s get you back on track.</h1>
      <p role="alert">This screen could not be loaded. Please reload the page or return to the bundle catalogue.</p>
      <p>If a purchase was in progress, check its status before starting another payment.</p>
      <div className="purchase-actions">
        <button className="pf-button pf-button-primary" onClick={() => window.location.reload()}>Reload this page</button>
        <button className="pf-button pf-button-secondary" onClick={this.props.onBrowse}>Return to bundles</button>
      </div>
    </section>;
  }
}
