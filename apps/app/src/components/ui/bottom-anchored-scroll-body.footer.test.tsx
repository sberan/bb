// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BottomAnchoredScrollBody } from "@/components/ui/bottom-anchored-scroll-body";

// Real component, browser primitives jsdom omits are stubbed. Nothing of ours
// is mocked.

const SCROLL_AREA_CLASS = "scroll-area";
const CLIENT_HEIGHT = 400;
const SCROLL_HEIGHT = 2000;
const MAX_SCROLL_TOP = SCROLL_HEIGHT - CLIENT_HEIGHT;

class ResizeObserverMock implements ResizeObserver {
  readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function requireHTMLElement(element: Element | null) {
  if (!(element instanceof HTMLElement)) throw new Error("Expected element.");
  return element;
}

function renderBody() {
  const view = render(
    <BottomAnchoredScrollBody
      footer={<button type="button">Send</button>}
      maxWidthClassName="max-w-none"
      scrollAreaClassName={SCROLL_AREA_CLASS}
    >
      <div>Transcript</div>
    </BottomAnchoredScrollBody>,
  );
  const scrollArea = requireHTMLElement(
    view.container.querySelector(`.${SCROLL_AREA_CLASS}`),
  );
  Object.defineProperty(scrollArea, "scrollHeight", {
    configurable: true,
    value: SCROLL_HEIGHT,
  });
  Object.defineProperty(scrollArea, "clientHeight", {
    configurable: true,
    value: CLIENT_HEIGHT,
  });
  const footer = requireHTMLElement(
    view.container.querySelector("[data-scroll-body-footer]"),
  );
  const scrollTo = (scrollTop: number) => {
    scrollArea.scrollTop = scrollTop;
    fireEvent.scroll(scrollArea);
  };
  return { view, scrollArea, footer, scrollTo };
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("BottomAnchoredScrollBody footer", () => {
  it("keeps the footer out of the scrolled content so overscroll cannot move it", () => {
    const { scrollArea, footer } = renderBody();

    // A sticky child of the scroller rides WebKit's rubber-band. A sibling in
    // the scroller's grid cell does not.
    expect(scrollArea.contains(footer)).toBe(false);
    expect(footer.className).not.toContain("sticky");
  });

  it("hides the footer when swiping down into older content", () => {
    const { footer, scrollTo } = renderBody();
    scrollTo(MAX_SCROLL_TOP);
    expect(footer.hasAttribute("data-hidden")).toBe(false);

    // Away from the bottom first, so the reveal-near-bottom rule is not what is
    // being measured, then a downward swipe: scrollTop decreasing.
    scrollTo(800);
    scrollTo(700);
    expect(footer.hasAttribute("data-hidden")).toBe(true);
    expect(footer.className).toContain("translate-y-full");
  });

  it("brings the footer back when swiping the other way", () => {
    const { footer, scrollTo } = renderBody();
    scrollTo(800);
    scrollTo(700);
    expect(footer.hasAttribute("data-hidden")).toBe(true);

    scrollTo(800);
    expect(footer.hasAttribute("data-hidden")).toBe(false);
  });

  it("always shows the footer near the end of the transcript", () => {
    const { footer, scrollTo } = renderBody();
    scrollTo(800);
    scrollTo(700);
    expect(footer.hasAttribute("data-hidden")).toBe(true);

    scrollTo(MAX_SCROLL_TOP);
    expect(footer.hasAttribute("data-hidden")).toBe(false);
  });

  it("does not hide a footer that holds focus", () => {
    const { view, footer, scrollTo } = renderBody();
    view.getByRole("button", { name: "Send" }).focus();

    scrollTo(800);
    scrollTo(700);

    expect(footer.hasAttribute("data-hidden")).toBe(false);
  });

  it("ignores wobble below the travel threshold", () => {
    const { footer, scrollTo } = renderBody();
    scrollTo(800);
    scrollTo(790);

    expect(footer.hasAttribute("data-hidden")).toBe(false);
  });
});
