import { Component, type ReactNode } from "react";
import { loading, SCENE_ITEMS } from "../loading";

/**
 * Without WebGL there is no panda, but text and voice still work: keep the
 * backdrop and the controls instead of letting the error blank the whole page.
 */
export class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[scene] could not start:", error);
    for (const item of SCENE_ITEMS) loading.report(item);
  }

  render() {
    return this.state.failed ? <div className="scene-loading" /> : this.props.children;
  }
}
