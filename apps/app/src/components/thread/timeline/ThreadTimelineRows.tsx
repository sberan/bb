import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { useLocation } from "react-router-dom";
import { useStore } from "jotai";
import {
  isBackgroundAgentTaskType,
  isBackgroundCommandTaskType,
  ThreadOriginKind,
} from "@bb/domain";
import type {
  PromptInput,
  ThreadRuntimeDisplayStatus,
} from "@bb/domain";
import type {
  TimelineActivityIntent,
  TimelineParentChange,
  TimelineRow,
  TimelineSystemOperationKind,
} from "@bb/server-contract";
import type { ThreadChatMessageReference } from "@get-bb/plugin-sdk";
import {
  assertNever,
  buildTimelineActivityIntentTitles,
  buildTimelineRowTitle,
  buildTimelineViewRows,
  createTimelineViewRowsCache,
  findActiveLatestBundleId,
  primaryTimelineActivityIntent,
  type BuildTimelineRowTitleOptions,
  type BuildTimelineViewRowsOptions,
  type ThreadTimelineViewRow,
  type TimelineActivityIntentTitle,
  type TimelineTitle,
  type TimelineViewTurnRow,
  type TimelineViewWorkRow,
} from "@bb/thread-view";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  collectTimelineAutoExpansionRowIds,
  isNonExpandableSummary,
  isRowExpandable,
} from "./timeline-auto-expand.js";
import { isRunningThreadRuntimeDisplayStatus } from "./thread-runtime-status.js";
import type {
  ThreadTimelineAddToChatHandler,
  ThreadTimelineEditMessageHandler,
  ThreadTimelineInlineMessageEditor,
  ThreadTimelineForkMessageHandler,
  ThreadTimelineSendToMainMessageHandler,
  ThreadTimelineLinkHandler,
  ThreadTimelineLocalFileLinkHandler,
  ThreadTimelineOpenPluginPanelHandler,
  ThreadTimelineImageViewSrcResolver,
  ThreadTimelineConsumerMessageAction,
  ThreadTimelinePluginMessageAction,
  ThreadTimelineTheme,
  ThreadTimelineUnreadDividerPlacement,
  UserAttachmentImageSrcResolver,
} from "./types.js";
import { ConversationMessageContent } from "./ConversationMessageContent.js";
import { TimelineSelectionMenu } from "./TimelineSelectionMenu.js";
import type { MessageProseSelection } from "./SelectableMessageProse.js";
import { ExpandableTimelineRow } from "./ExpandableTimelineRow.js";
import {
  TimelineStaticRowHeader,
  type TimelineRowHorizontalPadding,
} from "./TimelineRowHeader.js";
import {
  TimelineTitleView,
  type TimelineTitleActionResolver,
  type TimelineTitleLinkResolver,
} from "./TimelineTitleView.js";
import { WorkRowBody } from "./TimelineRowDetails.js";
import { TimelineDetailScroll } from "./TimelineDetailScroll.js";
import { Button } from "@bb/shared-ui/button";
import { AutoHeightContainer } from "../../ui/height-transition.js";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import { useBottomAnchoredScroll } from "@/components/ui/bottom-anchored-scroll-body.js";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { threadTimelineScrollAnchorAtomFamily } from "@/lib/thread-timeline-scroll-anchor.js";
import {
  collectSearchedMessageAncestorRowIds,
  readSearchMessageTarget,
  useScrollToSearchedMessage,
} from "./useScrollToSearchedMessage.js";
import {
  joinSignatureParts,
  timelineRowRenderSignature,
  timelineRowsSignature,
} from "./timelineRowSignatures.js";
import { NESTED_TIMELINE_GROUP_LINE_CLASS_NAME } from "./timeline-nested-group-line.js";
import { getThreadRoutePath } from "@/lib/route-paths";
import { useThreadTimelineTurnSummaryDetails } from "@/hooks/queries/thread-queries";
import { type ThreadTimelineTurnSummaryDetailsQueryIdentity } from "@/hooks/queries/query-keys";
import {
  useSenderThreadMetadataById,
  type SenderThreadMetadata,
} from "@/hooks/useSenderThreadMetadataById";
import {
  EMPTY_PLUGIN_SLOT_SNAPSHOT,
  getPluginSlotSnapshot,
  subscribePluginSlots,
  type PluginMessageActionSlot,
} from "@/lib/plugin-slots.js";
import { runPluginMessageAction } from "@/lib/plugin-message-actions.js";
import { isPluginSideChatSenderThread } from "@/lib/side-chat-plugin.js";
import {
  buildMessageDirectiveRegistry,
  MessageDirectiveRegistryProvider,
} from "@/components/ui/markdown-message-directives.js";

export interface ThreadTimelineRowsProps {
  /**
   * Row ids to start expanded on first render. Non-recursive: an id only
   * applies to the row it names — bundle/step/turn children are unaffected.
   * Used by stories and audit surfaces to seed an open body without faking
   * a running runtime status.
   */
  initialExpanded?: ReadonlySet<string>;
  /**
   * Whether the rendered thread may spawn a child thread (depth-cap policy from
   * the thread response). When false the per-message Fork action renders
   * disabled. Omit when the spawn policy is unknown (treated as not allowed).
   */
  canSpawnChild?: boolean;
  /**
   * Origin of the rendered thread as a child (`fork` / `side-chat`), or null for
   * root threads. Selects the fork leading icon on the seed-without-run anchor.
   */
  threadOriginKind?: ThreadOriginKind | null;
  /** Fork the rendered thread from a specific agent message. */
  onForkMessage?: ThreadTimelineForkMessageHandler;
  /** Stage an edit of an eligible user request in the host composer. */
  onEditMessage?: ThreadTimelineEditMessageHandler;
  /** Mount a client-local editor in place of its matching user request. */
  inlineMessageEditor?: ThreadTimelineInlineMessageEditor;
  /** Add a complete agent message to the composer draft. */
  onMessageAddToChat?: ThreadTimelineAddToChatHandler;
  /** Open a side chat anchored on a specific agent message. */
  /** Hand a specific side-chat agent message back to the main thread. */
  onSendToMainMessage?: ThreadTimelineSendToMainMessageHandler;
  /**
   * Add the active text selection to the composer draft as a quote chip. When
   * omitted the floating selection menu's "Add to chat" action is unavailable
   * (so no menu is shown).
   */
  onSelectionAddToChat?: ThreadTimelineAddToChatHandler;
  /**
   * Open a side chat anchored on the active text selection. When omitted the
   * floating selection menu's "Reply in side chat" action is unavailable.
   */
  /**
   * Consumer-supplied per-message actions scoped to this surface (the
   * `ThreadChat` `messageActions` prop), rendered in the per-message action
   * bar after the slot-registered plugin actions.
   */
  consumerMessageActions?: readonly ThreadTimelineConsumerMessageAction[];
  /**
   * Whether slot-registered plugin message actions render on this surface.
   * Default true (the app's native thread surfaces). Embedded chat surfaces
   * (plugin-hosted ThreadChat, the side-chat panel) pass false so global
   * actions like "Reply in side chat" don't nest inside themselves.
   */
  includePluginMessageActions?: boolean;
  onOpenLink?: ThreadTimelineLinkHandler;
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
  onOpenPluginPanel?: ThreadTimelineOpenPluginPanelHandler;
  onTitleAction?: TimelineTitleActionResolver;
  projectId?: string;
  resolveMentionLink?: PromptMentionLinkResolver;
  resolveImageViewSrc?: ThreadTimelineImageViewSrcResolver;
  resolveUserAttachmentImageSrc?: UserAttachmentImageSrcResolver;
  hasOlderTimelineRows?: boolean;
  isLoadingOlderTimelineRows?: boolean;
  onLoadOlderRows?: () => Promise<void> | void;
  themeType?: ThreadTimelineTheme;
  timelineRows: TimelineRow[];
  threadId?: string;
  threadRuntimeDisplayStatus: ThreadRuntimeDisplayStatus;
  /** Omit for standalone initial-unread rendering, pass false for live updates. */
  unreadDividerAutoScroll?: boolean;
  unreadDividerPlacement?: ThreadTimelineUnreadDividerPlacement | null;
  /**
   * Workspace root path the agent ran in (`environment.path`). Forwarded to
   * file-change rows so they can strip the prefix from `change.path` and
   * render repo-relative paths in the diff card header. Pass `undefined`
   * only when the environment hasn't loaded yet.
   */
  workspaceRootPath: string | undefined;
}

/**
 * Stable renderer config: callbacks, theme, project/workspace identity. These
 * values change only when the parent's identity changes, so consumers that
 * read from this context do not rerender when an individual turn summary
 * loads.
 */
interface TimelineRendererStaticContextValue {
  canSpawnChild: boolean;
  getViewRows: GetTimelineViewRows;
  onForkMessage: ThreadTimelineForkMessageHandler | undefined;
  onEditMessage: ThreadTimelineEditMessageHandler | undefined;
  inlineMessageEditor: ThreadTimelineInlineMessageEditor | undefined;
  onMessageAddToChat: ThreadTimelineAddToChatHandler | undefined;
  onSendToMainMessage: ThreadTimelineSendToMainMessageHandler | undefined;
  onSelectionAddToChat: ThreadTimelineAddToChatHandler | undefined;
  /**
   * Plugin `messageAction` registrations, subscribed once at the timeline
   * root. Rows resolve them into per-message actions; empty when the surface
   * has no thread identity (plugin actions need a real thread context).
   */
  pluginMessageActions: readonly PluginMessageActionSlot[];
  /** Surface-scoped consumer actions; empty when none were supplied. */
  consumerMessageActions: readonly ThreadTimelineConsumerMessageAction[];
  /**
   * Reports an assistant message's text selection to the timeline-level
   * controller. `undefined` when no selection action is wired (Add to chat /
   * Reply in side chat / plugin actions all absent), which keeps
   * `onSelectProse` off the messages and the floating menu unmounted. The
   * message reference travels with the selection so plugin selection actions
   * can anchor on the exact message.
   */
  reportProseSelection:
    | ((
        rowId: string,
        selection: MessageProseSelection | null,
        message: ThreadChatMessageReference,
      ) => void)
    | undefined;
  threadOriginKind: ThreadOriginKind | null;
  onOpenLink: ThreadTimelineLinkHandler | undefined;
  onOpenLocalFileLink: ThreadTimelineLocalFileLinkHandler | undefined;
  onOpenPluginPanel: ThreadTimelineOpenPluginPanelHandler | undefined;
  onTitleAction: TimelineTitleActionResolver | undefined;
  projectId: string | undefined;
  resolveImageViewSrc: ThreadTimelineImageViewSrcResolver | undefined;
  resolveMentionLink: PromptMentionLinkResolver | undefined;
  resolveSegmentLinkHref: TimelineTitleLinkResolver | undefined;
  resolveUserAttachmentImageSrc: UserAttachmentImageSrcResolver | undefined;
  themeType: ThreadTimelineTheme;
  threadId: string | undefined;
  workspaceRootPath: string | undefined;
}

/**
 * Volatile row/turn state. Changes when auto-expansion is recomputed. Only
 * consumed by row components that need this flag so other rows do not rerender
 * on unrelated turn updates.
 */
interface TimelineTurnStateContextValue {
  initialAutoExpandedRowIds: ReadonlySet<string>;
  liveAutoExpandedRowIds: ReadonlySet<string>;
  terminalAutoExpandedRowIds: ReadonlySet<string>;
}

interface TimelineRowsListProps {
  compactActivityIntents: boolean;
  hasOlderTimelineRows?: boolean;
  isLoadingOlderTimelineRows?: boolean;
  onLoadOlderRows?: () => Promise<void> | void;
  rows: readonly ThreadTimelineViewRow[];
  scopeActive: boolean;
  showAssistantMessageActions: boolean;
  spacing: TimelineRowsListSpacing;
  className?: string;
  unreadDividerAutoScroll: boolean;
  unreadDividerPlacement: ThreadTimelineUnreadDividerPlacement | null;
}

interface TimelineWindowItemController {
  handleIntersection: (entry: IntersectionObserverEntry) => void;
  realize: () => void;
  /** Revert a just-realized item to its unchanged placeholder. */
  derealize: () => void;
  /** The current placeholder height, or null while the item is realized. */
  peekPlaceholderHeight: () => number | null;
  /** Grow or shrink the placeholder (clamped at zero) to absorb a height delta. */
  adjustPlaceholderHeight: (delta: number) => void;
  /**
   * Whether the item has ever mounted its real content. A false value means
   * its placeholder height is still a pure estimate, eligible for
   * re-budgeting; a true value means the placeholder carries a measurement.
   */
  hasEverRealized: () => boolean;
  /** Release an interaction pin so the row can derealize on its next exit. */
  unpin: () => void;
}

interface TimelineVisibleAnchor {
  element: HTMLDivElement;
  top: number;
}

interface TimelineWindowedListItemProps {
  alwaysRealized: boolean;
  children: ReactNode;
  estimatedHeight: number;
  initiallyRealized: boolean;
  itemKey: string;
  registerWrapper: (key: string, node: HTMLDivElement | null) => void;
  registerController: (
    key: string,
    controller: TimelineWindowItemController | null,
  ) => void;
  registerInteractionPin: (key: string) => void;
  rowId: string | undefined;
}

interface TimelineUnreadDividerProps {
  autoScroll: boolean;
}

interface TimelineRowViewProps {
  activeLatestBundleId: string | null;
  compactActivityIntents: boolean;
  row: ThreadTimelineViewRow;
  scopeActive: boolean;
  showAssistantMessageActions: boolean;
  spacing: TimelineRowsListSpacing;
}

interface TimelineExpandableRowViewProps {
  activeLatestBundleId: string | null;
  compactActivityIntents: boolean;
  scopeActive: boolean;
  showAssistantMessageActions: boolean;
  title: TimelineTitle;
  horizontalPadding: TimelineRowHorizontalPadding;
  row: Exclude<ThreadTimelineViewRow, { kind: "conversation" }>;
}

interface TimelineStaticRowProps {
  children: ReactNode;
  className?: string;
  horizontalPadding?: TimelineRowHorizontalPadding;
}

interface TimelineExpandableBodyProps {
  activeLatestBundleId: string | null;
  compactActivityIntents: boolean;
  row: ThreadTimelineViewRow;
  showAssistantMessageActions: boolean;
}

interface TurnRowBodyProps {
  compactActivityIntents: boolean;
  row: TimelineViewTurnRow;
  showAssistantMessageActions: boolean;
}

type LazyTurnRowBodyProps = TurnRowBodyProps;

interface TimelineSystemDetailBlockProps {
  detail: string;
  streaming: boolean;
}

interface BuildTimelineRowsListItemsArgs {
  rows: readonly ThreadTimelineViewRow[];
  unreadDividerPlacement: ThreadTimelineUnreadDividerPlacement | null;
}

interface FindUnreadDividerIndexArgs {
  rows: readonly ThreadTimelineViewRow[];
  unreadDividerPlacement: ThreadTimelineUnreadDividerPlacement | null;
}

interface IsUnreadDividerCandidateAfterCutoffArgs {
  cutoffAt: number;
  row: ThreadTimelineViewRow;
}

interface ActiveSummaryTreatmentArgs {
  activeLatestBundleId: string | null;
  row: ThreadTimelineViewRow;
  scopeActive: boolean;
}

interface TimelineRowTitleRenderStateArgs extends ActiveSummaryTreatmentArgs {
  compactActivityIntents: boolean;
  spacing: TimelineRowsListSpacing;
}

interface TimelineRowTitleOptionsArgs extends ActiveSummaryTreatmentArgs {}

interface TimelineRowTitleRenderStateCache {
  key: string;
  state: TimelineRowTitleRenderState;
}

interface BuildTurnSummaryDetailsIdentityArgs {
  rowSourceSeqEnd: TimelineViewTurnRow["sourceSeqEnd"];
  rowSourceSeqStart: TimelineViewTurnRow["sourceSeqStart"];
  rowThreadId: TimelineViewTurnRow["threadId"];
  rowTurnId: TimelineViewTurnRow["turnId"];
  threadId: string | undefined;
}

interface TimelineRowsOwnerKeyArgs {
  threadId: string | undefined;
  timelineRows: readonly TimelineRow[];
}

type TimelineConversationViewRow = Extract<
  ThreadTimelineViewRow,
  { kind: "conversation" }
>;

type TimelineRowTitleRenderState =
  | {
      kind: "compact-activity-intents";
      titles: readonly TimelineActivityIntentTitle[];
    }
  | {
      kind: "row-title";
      title: TimelineTitle;
    };

type TimelineRowsListSpacing = "top-level" | "nested" | "bundle";
type TimelineRawRows = readonly TimelineRow[];
type GetTimelineViewRows = (
  rows: TimelineRawRows,
  options?: BuildTimelineViewRowsOptions,
) => ThreadTimelineViewRow[];
type TimelineRowsListItem =
  | {
      kind: "row";
      row: ThreadTimelineViewRow;
    }
  | {
      kind: "unread-divider";
      id: "thread-unread-divider";
    };

const TIMELINE_WINDOWING_MIN_ITEM_COUNT = 40;
const TIMELINE_WINDOW_MARGIN_PX = 1_000;
const TIMELINE_WINDOW_FALLBACK_VIEWPORT_HEIGHT_PX = 800;
// Interaction pins keep rows mounted so their local state (expansion,
// long-message reveal) survives eviction. Cap them so a long session of taps
// cannot keep every heavy row realized forever: the oldest pin releases
// first, and its row derealizes on its next window exit.
const TIMELINE_WINDOW_MAX_INTERACTION_PINS = 24;
// Re-budgeting replaces never-measured placeholder estimates with the running
// average of measured rows once the scroll idles, so the donor pool tracks
// the timeline's real heights instead of draining monotonically.
const TIMELINE_WINDOW_REBUDGET_MIN_SAMPLES = 8;
const TIMELINE_WINDOW_REBUDGET_DRIFT_PX = 24;
const TIMELINE_WINDOW_REBUDGET_IDLE_DELAY_MS = 300;
const TIMELINE_WINDOW_REBUDGET_MAX_ESTIMATE_PX = 1_000;

function timelineListItemKey(item: TimelineRowsListItem): string {
  return item.kind === "row" ? item.row.id : item.id;
}

function estimateTimelineListItemHeight(item: TimelineRowsListItem): number {
  if (item.kind === "unread-divider") {
    return 24;
  }
  if (item.row.kind === "conversation") {
    return 120;
  }
  return 40;
}

function collectTimelineWindowKeys({
  centerIndex,
  items,
}: {
  centerIndex: number;
  items: readonly TimelineRowsListItem[];
}): ReadonlySet<string> {
  if (items.length === 0) {
    return EMPTY_ROW_ID_SET;
  }

  const keys = new Set<string>();
  const boundedCenterIndex = Math.max(
    0,
    Math.min(centerIndex, items.length - 1),
  );
  const coverage =
    TIMELINE_WINDOW_MARGIN_PX + TIMELINE_WINDOW_FALLBACK_VIEWPORT_HEIGHT_PX;

  let beforeHeight = 0;
  for (
    let index = boundedCenterIndex;
    index >= 0 && beforeHeight <= coverage;
    index -= 1
  ) {
    const item = items[index];
    if (item === undefined) {
      break;
    }
    keys.add(timelineListItemKey(item));
    beforeHeight += estimateTimelineListItemHeight(item);
  }

  let afterHeight = 0;
  for (
    let index = boundedCenterIndex + 1;
    index < items.length && afterHeight <= coverage;
    index += 1
  ) {
    const item = items[index];
    if (item === undefined) {
      break;
    }
    keys.add(timelineListItemKey(item));
    afterHeight += estimateTimelineListItemHeight(item);
  }

  return keys;
}

interface ConversationRowProps {
  row: TimelineConversationViewRow;
  showAssistantMessageActions: boolean;
}

const TimelineRendererStaticContext =
  createContext<TimelineRendererStaticContextValue | null>(null);
// Kept out of the static renderer context on purpose: the metadata map covers
// every cached thread, so it changes on cache events unrelated to this
// timeline. A dedicated context keeps those changes from re-rendering every
// row and instead reaches only the conversation rows that resolve senders.
const SenderThreadMetadataContext = createContext<ReadonlyMap<
  string,
  SenderThreadMetadata
> | null>(null);
const TimelineTurnStateContext =
  createContext<TimelineTurnStateContextValue | null>(null);
const LatestActionableAssistantMessageIdContext = createContext<string | null>(
  null,
);
const LatestActionableUserMessageIdContext = createContext<string | null>(null);
const EMPTY_ROW_ID_SET: ReadonlySet<string> = new Set<string>();
const TimelineSearchExpansionContext =
  createContext<ReadonlySet<string>>(EMPTY_ROW_ID_SET);
const SKILL_FILE_NAME = "SKILL.md";

function useTimelineRendererStaticContext(): TimelineRendererStaticContextValue {
  const context = useContext(TimelineRendererStaticContext);
  if (!context) {
    throw new Error("Thread timeline renderer context is missing");
  }
  return context;
}

function useSenderThreadMetadataContext(): ReadonlyMap<
  string,
  SenderThreadMetadata
> {
  const context = useContext(SenderThreadMetadataContext);
  if (!context) {
    throw new Error("Thread timeline sender metadata context is missing");
  }
  return context;
}

function useTimelineTurnStateContext(): TimelineTurnStateContextValue {
  const context = useContext(TimelineTurnStateContext);
  if (!context) {
    throw new Error("Thread timeline turn-state context is missing");
  }
  return context;
}

function timelineRowTitleRenderStateKey({
  activeLatestBundleId,
  compactActivityIntents,
  row,
  scopeActive,
}: TimelineRowTitleRenderStateArgs): string {
  return joinSignatureParts([
    timelineRowRenderSignature(row),
    compactActivityIntents,
    scopeActive,
    activeLatestBundleId === row.id,
  ]);
}

function buildTimelineRowTitleRenderState({
  activeLatestBundleId,
  compactActivityIntents,
  row,
  scopeActive,
  spacing,
}: TimelineRowTitleRenderStateArgs): TimelineRowTitleRenderState {
  if (compactActivityIntents && shouldRenderCompactActivityIntentRows(row)) {
    const titles = buildTimelineActivityIntentTitles(row);
    if (titles.length > 0) {
      return {
        kind: "compact-activity-intents",
        titles,
      };
    }
  }

  const title = buildTimelineRowTitle(
    row,
    timelineRowTitleOptions({
      activeLatestBundleId,
      row,
      scopeActive,
    }),
  );
  return {
    kind: "row-title",
    title,
  };
}

function useTimelineRowTitleRenderState(
  args: TimelineRowTitleRenderStateArgs,
): TimelineRowTitleRenderState {
  const cacheRef = useRef<TimelineRowTitleRenderStateCache | null>(null);
  const key = timelineRowTitleRenderStateKey(args);
  const cached = cacheRef.current;
  if (cached?.key === key) {
    return cached.state;
  }

  const state = buildTimelineRowTitleRenderState(args);
  cacheRef.current = {
    key,
    state,
  };
  return state;
}

function areTimelineRowViewPropsEqual(
  previous: TimelineRowViewProps,
  next: TimelineRowViewProps,
): boolean {
  return (
    previous.compactActivityIntents === next.compactActivityIntents &&
    previous.scopeActive === next.scopeActive &&
    previous.showAssistantMessageActions === next.showAssistantMessageActions &&
    previous.spacing === next.spacing &&
    previous.activeLatestBundleId === next.activeLatestBundleId &&
    // The view-row cache keys by the raw rows array, so unchanged query data
    // preserves row object identity and can skip recursive signature work.
    (previous.row === next.row ||
      timelineRowRenderSignature(previous.row) ===
        timelineRowRenderSignature(next.row))
  );
}

function areTimelineExpandableRowViewPropsEqual(
  previous: TimelineExpandableRowViewProps,
  next: TimelineExpandableRowViewProps,
): boolean {
  return (
    previous.activeLatestBundleId === next.activeLatestBundleId &&
    previous.compactActivityIntents === next.compactActivityIntents &&
    previous.scopeActive === next.scopeActive &&
    previous.showAssistantMessageActions === next.showAssistantMessageActions &&
    previous.title === next.title &&
    previous.horizontalPadding === next.horizontalPadding &&
    // The view-row cache keys by the raw rows array, so unchanged query data
    // preserves row object identity and can skip recursive signature work.
    (previous.row === next.row ||
      timelineRowRenderSignature(previous.row) ===
        timelineRowRenderSignature(next.row))
  );
}

function areReadonlySetsEqual(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

function useStableReadonlySet(
  values: ReadonlySet<string>,
): ReadonlySet<string> {
  const valuesRef = useRef(values);
  if (!areReadonlySetsEqual(valuesRef.current, values)) {
    valuesRef.current = values;
  }
  return valuesRef.current;
}

function useTimelineSearchExpansionRowIds(
  rows: readonly ThreadTimelineViewRow[],
): ReadonlySet<string> {
  const inheritedRowIds = useContext(TimelineSearchExpansionContext);
  const { threadId } = useTimelineRendererStaticContext();
  const location = useLocation();
  return useMemo(() => {
    const target = readSearchMessageTarget(location.state);
    if (target === null) {
      return inheritedRowIds;
    }
    if (
      threadId !== undefined &&
      target.threadId !== null &&
      target.threadId !== threadId
    ) {
      return inheritedRowIds;
    }
    const localRowIds = collectSearchedMessageAncestorRowIds(rows, target.seq);
    if (localRowIds.size === 0) {
      return inheritedRowIds;
    }
    const combinedRowIds = new Set<string>(inheritedRowIds);
    for (const id of localRowIds) {
      combinedRowIds.add(id);
    }
    return combinedRowIds;
  }, [inheritedRowIds, location.state, rows, threadId]);
}

function buildTurnSummaryDetailsIdentity({
  rowSourceSeqEnd,
  rowSourceSeqStart,
  rowThreadId,
  rowTurnId,
  threadId,
}: BuildTurnSummaryDetailsIdentityArgs): ThreadTimelineTurnSummaryDetailsQueryIdentity {
  return {
    sourceSeqEnd: rowSourceSeqEnd,
    sourceSeqStart: rowSourceSeqStart,
    threadId: threadId ?? rowThreadId,
    turnId: rowTurnId,
  };
}

function timelineRowsOwnerKey({
  threadId,
  timelineRows,
}: TimelineRowsOwnerKeyArgs): string {
  const ownerThreadId = threadId ?? timelineRows[0]?.threadId ?? "";
  return ownerThreadId;
}

function useTimelineViewRowsCache(): GetTimelineViewRows {
  // Each `rawRows` reference is consumed under exactly one scope: the
  // top-level prop ("open" — pending work may still arrive) or a lazily
  // loaded turn-detail array ("closed" — the turn is complete and won't
  // grow). Caching by identity is correct because the per-array scope is
  // stable; passing a different `closedScope` for the same `rawRows`
  // reference would be a bug. The cache also covers nested recursion —
  // delegation `childRows` and lazy turn `children` — so a streaming update
  // that replaces the top-level rows array doesn't reproject every untouched
  // delegation subtree.
  const cacheRef = useRef(createTimelineViewRowsCache());
  return useCallback<GetTimelineViewRows>(
    (rawRows, options) =>
      buildTimelineViewRows(rawRows, { ...options, cache: cacheRef.current }),
    [],
  );
}

function shouldRenderCompactActivityIntentRows(
  row: ThreadTimelineViewRow,
): row is Extract<TimelineViewWorkRow, { workKind: "command" | "tool" }> {
  return (
    row.kind === "work" &&
    (row.workKind === "command" || row.workKind === "tool") &&
    row.approvalStatus === null
  );
}

function isActiveLatestBundleSummary({
  activeLatestBundleId,
  row,
  scopeActive,
}: ActiveSummaryTreatmentArgs): boolean {
  return (
    row.kind === "bundle-summary" &&
    scopeActive &&
    row.id === activeLatestBundleId
  );
}

function timelineRowTitleOptions({
  activeLatestBundleId,
  row,
  scopeActive,
}: TimelineRowTitleOptionsArgs): BuildTimelineRowTitleOptions {
  const useActiveBundleLabel = isActiveLatestBundleSummary({
    activeLatestBundleId,
    row,
    scopeActive,
  });
  // Bundle summaries always render with the bundle (verb + rest) split so the
  // verb can shimmer and the rest can carry em when the bundle is the
  // active-latest. Step summaries collapse to the flat muted single-segment
  // "background" style — they're a recap of finished work, not a frontier.
  return {
    summaryStyle: row.kind === "step-summary" ? "background" : "bundle",
    workStyle: row.kind === "work" && row.inClosedStep ? "summary" : "default",
    isActiveLatestBundle: useActiveBundleLabel,
  };
}

function timelineRowHorizontalPadding(
  spacing: TimelineRowsListSpacing,
): TimelineRowHorizontalPadding {
  switch (spacing) {
    case "top-level":
    case "nested":
      return "default";
    case "bundle":
      return "flush";
  }
}

function TimelineStaticRow({
  children,
  className,
  horizontalPadding = "default",
}: TimelineStaticRowProps) {
  return (
    <TimelineStaticRowHeader
      horizontalPadding={horizontalPadding}
      className={className}
    >
      {children}
    </TimelineStaticRowHeader>
  );
}

function timelineRowsListGapClassName(
  spacing: TimelineRowsListSpacing,
): string {
  switch (spacing) {
    case "top-level":
      return "gap-4";
    case "nested":
      return "gap-3";
    case "bundle":
      return "gap-0";
  }
}

/**
 * Whether a conversation row is the fork's seed anchor — the thread-start turn
 * rendered as "Message from {source}". The thread-start user message is
 * agent-initiated with a sender thread and carries no turn id (it predates the
 * first executed turn), which distinguishes it from a *later* cross-thread agent
 * message in the same thread (those belong to a turn, so `turnId` is non-null).
 * Only this row should take the fork leading icon; later cross-thread agent rows
 * keep their per-sourceKind icon even though the thread's `childOrigin` is fork.
 */
function isForkSeedAnchorRow(row: TimelineConversationViewRow): boolean {
  return (
    row.role === "user" &&
    row.initiator === "agent" &&
    row.senderThreadId !== null &&
    row.turnId === null
  );
}

/**
 * Finds the final assistant row whose action bar is available in the rendered
 * timeline. Completed turn details and delegated-agent output intentionally do
 * not expose message actions, so they cannot claim the mobile inline footer.
 */
export function findLastActionableAssistantMessageId(
  rows: readonly ThreadTimelineViewRow[],
): string | null {
  let lastMessageId: string | null = null;

  const visitRows = (candidateRows: readonly ThreadTimelineViewRow[]): void => {
    for (const row of candidateRows) {
      if (row.kind === "conversation") {
        if (row.role === "assistant") {
          lastMessageId = row.id;
        }
        continue;
      }

      if (
        row.kind === "turn" &&
        row.status === "pending" &&
        row.children !== null
      ) {
        visitRows(row.children);
      }
    }
  };

  visitRows(rows);
  return lastMessageId;
}

/** Finds the final regular user-authored message with a mobile action footer. */
export function findLastActionableUserMessageId(
  rows: readonly ThreadTimelineViewRow[],
  canAddAttachments: boolean,
): string | null {
  let lastMessageId: string | null = null;

  const visitRows = (candidateRows: readonly ThreadTimelineViewRow[]): void => {
    for (const row of candidateRows) {
      if (row.kind === "conversation") {
        const hasReusableAttachment =
          row.role === "user" &&
          ((row.attachments?.localFilePaths.length ?? 0) > 0 ||
            (row.attachments?.localImagePaths.length ?? 0) > 0);
        if (
          row.role === "user" &&
          row.initiator === "user" &&
          (row.text.trim().length > 0 ||
            (canAddAttachments && hasReusableAttachment))
        ) {
          lastMessageId = row.id;
        }
        continue;
      }

      if (
        row.kind === "turn" &&
        row.status === "pending" &&
        row.children !== null
      ) {
        visitRows(row.children);
      }
    }
  };

  visitRows(rows);
  return lastMessageId;
}

const EMPTY_CONSUMER_MESSAGE_ACTIONS: readonly ThreadTimelineConsumerMessageAction[] =
  [];

/**
 * Resolve the registered plugin `messageAction`s into concrete per-message
 * actions for one row. Undefined (no actions rendered) when the surface has
 * no thread identity or nothing is registered; invocation errors are
 * contained by `runPluginMessageAction`, never breaking the timeline.
 */
function buildRowPluginMessageActions(args: {
  slots: readonly PluginMessageActionSlot[];
  timelineThreadId: string | undefined;
  message: ThreadChatMessageReference;
  openThreadPanel: ThreadTimelineOpenPluginPanelHandler | undefined;
}): readonly ThreadTimelinePluginMessageAction[] | undefined {
  const { slots, timelineThreadId, message, openThreadPanel } = args;
  if (timelineThreadId === undefined || slots.length === 0) {
    return undefined;
  }
  return slots.map((slot) => ({
    key: `${slot.pluginId}/${slot.id}/${slot.generation}`,
    pluginId: slot.pluginId,
    icon: slot.icon ?? null,
    label: slot.title,
    onSelect: () =>
      runPluginMessageAction({
        slot,
        threadId: timelineThreadId,
        message,
        openThreadPanel,
      }),
  }));
}

/**
 * Resolve the surface-scoped consumer actions (the `ThreadChat`
 * `messageActions` prop) for one row: filter by the row's role and contain
 * `run` errors like the slot-registered plugin actions.
 */
function buildRowConsumerMessageActions(args: {
  actions: readonly ThreadTimelineConsumerMessageAction[];
  message: ThreadChatMessageReference;
}): readonly ThreadTimelinePluginMessageAction[] {
  const { actions, message } = args;
  return actions
    .filter(
      (action) =>
        action.roles === undefined || action.roles.includes(message.role),
    )
    .map((action) => ({
      key: `consumer/${action.id}`,
      pluginId: action.pluginId,
      icon: action.icon,
      label: action.label,
      onSelect: () => {
        const warn = (error: unknown) => {
          console.warn(
            `ThreadChat messageAction "${action.id}" failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        };
        try {
          const result = action.run(message);
          if (result instanceof Promise) {
            result.catch(warn);
          }
        } catch (error) {
          warn(error);
        }
      },
    }));
}

function ConversationRow({
  row,
  showAssistantMessageActions,
}: ConversationRowProps) {
  const latestActionableAssistantMessageId = useContext(
    LatestActionableAssistantMessageIdContext,
  );
  const latestActionableUserMessageId = useContext(
    LatestActionableUserMessageIdContext,
  );
  const {
    canSpawnChild,
    inlineMessageEditor,
    onEditMessage,
    onForkMessage,
    onMessageAddToChat,
    onSendToMainMessage,
    onSelectionAddToChat,
    pluginMessageActions,
    consumerMessageActions,
    reportProseSelection,
    threadOriginKind,
    onOpenLink,
    onOpenLocalFileLink,
    onOpenPluginPanel,
    onTitleAction,
    projectId,
    resolveMentionLink,
    resolveSegmentLinkHref,
    resolveUserAttachmentImageSrc,
    threadId,
    workspaceRootPath,
  } = useTimelineRendererStaticContext();
  const senderThreadMetadataById = useSenderThreadMetadataContext();
  if (
    row.role === "user" &&
    inlineMessageEditor !== undefined &&
    inlineMessageEditor.messageId === row.id
  ) {
    return (
      <div className="ml-auto w-full max-w-[70%] max-md:max-w-full">
        <div
          ref={inlineMessageEditor.onHostElementChange}
          data-sent-message-inline-editor-host=""
        />
      </div>
    );
  }
  // The narrow, stable message reference plugin actions receive — sourced
  // from row fields, never the row object itself.
  const messageReference: ThreadChatMessageReference = {
    id: row.id,
    threadId: row.threadId,
    role: row.role,
    text: row.text,
    sourceSeqEnd: row.sourceSeqEnd,
  };
  const rowSlotActions = buildRowPluginMessageActions({
    slots: pluginMessageActions,
    timelineThreadId: threadId,
    message: messageReference,
    openThreadPanel: onOpenPluginPanel,
  });
  const rowConsumerActions =
    consumerMessageActions.length === 0
      ? []
      : buildRowConsumerMessageActions({
          actions: consumerMessageActions,
          message: messageReference,
        });
  const rowPluginActions =
    rowConsumerActions.length === 0
      ? rowSlotActions
      : [...(rowSlotActions ?? []), ...rowConsumerActions];
  if (row.role === "user") {
    const senderThreadMetadata =
      row.senderThreadId === null
        ? null
        : (senderThreadMetadataById.get(row.senderThreadId) ?? null);
    // The fork leading icon is the thread's `childOrigin`, but only on the seed
    // anchor (thread-start) row — pass null for every other generated row so a
    // later cross-thread agent message in a forked thread keeps its own icon.
    const originKind = isForkSeedAnchorRow(row) ? threadOriginKind : null;
    const canEditMessage =
      onEditMessage !== undefined &&
      row.initiator === "user" &&
      !row.turnRequest.isGrouped &&
      row.turnRequest.kind === "message" &&
      row.turnRequest.status === "accepted" &&
      (row.attachments?.imageUrls.length ?? 0) === 0;
    const onEdit = canEditMessage
      ? () => {
          const input: PromptInput[] = [];
          if (row.text.trim().length > 0) {
            input.push({
              type: "text",
              text: row.text,
              mentions: [...row.mentions],
            });
          }
          for (const path of row.attachments?.localImagePaths ?? []) {
            input.push({ type: "localImage", path });
          }
          for (const path of row.attachments?.localFilePaths ?? []) {
            input.push({ type: "localFile", path });
          }
          onEditMessage({
            messageId: row.id,
            expectedRequestSequence: row.sourceSeqStart,
            input,
          });
        }
      : undefined;
    return (
      <ConversationMessageContent
        attachments={row.attachments}
        originKind={originKind}
        initiator={row.initiator}
        mentions={row.mentions}
        mobileActionDisplay={
          row.id === latestActionableUserMessageId ? "inline" : "overflow"
        }
        onAddToChat={onSelectionAddToChat}
        onEdit={onEdit}
        onOpenLink={onOpenLink}
        onOpenLocalFileLink={onOpenLocalFileLink}
        projectId={projectId}
        resolveMentionLink={resolveMentionLink}
        resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
        role="user"
        resolveSegmentLinkHref={resolveSegmentLinkHref}
        onTitleAction={onTitleAction}
        senderThreadId={row.senderThreadId}
        senderThreadTitle={senderThreadMetadata?.title ?? null}
        senderIsPluginSideChat={isPluginSideChatSenderThread(
          senderThreadMetadata,
        )}
        systemMessageKind={row.systemMessageKind}
        systemMessageSubject={row.systemMessageSubject}
        pluginActions={rowPluginActions}
        text={row.text}
        turnRequest={row.turnRequest}
      />
    );
  }
  // Fork clones provider history through this row's source sequence. Omit the
  // handler entirely when no host can fork, which keeps the Fork button out of
  // the action bar rather than rendering it dead.
  const onFork =
    onForkMessage === undefined
      ? undefined
      : () => onForkMessage({ sourceSeqEnd: row.sourceSeqEnd });
  // Side chats supply this so each agent message can be handed back to the main
  // thread; omitted on the main timeline, which keeps the action out of the bar.
  const onSendToMain =
    onSendToMainMessage === undefined
      ? undefined
      : () => onSendToMainMessage({ messageText: row.text });
  const onSelectProse =
    reportProseSelection === undefined
      ? undefined
      : (selection: MessageProseSelection | null) =>
          reportProseSelection(
            row.id,
            selection === null
              ? null
              : { ...selection, sourceSeqEnd: row.sourceSeqEnd },
            messageReference,
          );
  return (
    <ConversationMessageContent
      attachments={row.attachments}
      id={row.id}
      onAddToChat={onMessageAddToChat}
      onFork={onFork}
      onSendToMain={onSendToMain}
      forkDisabled={!canSpawnChild}
      onSelectProse={onSelectProse}
      onOpenLink={onOpenLink}
      onOpenLocalFileLink={onOpenLocalFileLink}
      onOpenPluginPanel={onOpenPluginPanel}
      pluginActions={rowPluginActions}
      projectId={projectId}
      resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
      role="assistant"
      showActions={showAssistantMessageActions}
      mobileActionDisplay={
        row.id === latestActionableAssistantMessageId ? "inline" : "overflow"
      }
      sourceSeqEnd={row.sourceSeqEnd}
      sourceSeqStart={row.sourceSeqStart}
      text={row.text}
      threadId={row.threadId}
      turnId={row.turnId}
      turnRequest={row.turnRequest}
      workspaceRootPath={workspaceRootPath}
    />
  );
}

function TimelineUnreadDivider({ autoScroll }: TimelineUnreadDividerProps) {
  const bottomAnchor = useBottomAnchoredScroll();
  const dividerRef = useRef<HTMLDivElement>(null);
  const hasScrolledRef = useRef(false);

  useEffect(() => {
    if (!autoScroll || !bottomAnchor || hasScrolledRef.current) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const divider = dividerRef.current;
      if (!divider) {
        return;
      }

      hasScrolledRef.current = true;
      bottomAnchor.scrollElementIntoViewClampedToMaxScroll({
        element: divider,
      });
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [autoScroll, bottomAnchor]);

  return (
    <div
      ref={dividerRef}
      role="separator"
      aria-label="New messages"
      className={cn(
        "flex items-center gap-2 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-timeline-accent",
      )}
      data-testid="thread-unread-divider"
    >
      <span className="shrink-0">New</span>
      <span className="h-px min-w-0 flex-1 bg-timeline-accent" aria-hidden />
    </div>
  );
}

function TimelineSystemDetailBlock({
  detail,
  streaming,
}: TimelineSystemDetailBlockProps) {
  // Mirror the card chrome from TerminalOutputBlock so every system detail body
  // (provisioning transcripts, provider-unhandled payloads, error messages)
  // reads as the same neutral "output" surface as command output. Errors are
  // flagged by the title status annotation, not by recoloring the body — that
  // keeps system errors visually consistent with failed command/tool rows.
  return (
    <TimelineDetailScroll
      size="base"
      streaming={streaming}
      contentKey={detail}
      className="overflow-hidden rounded-lg border border-border bg-card"
    >
      <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-tight text-subtle-foreground opacity-70">
        {detail}
      </pre>
    </TimelineDetailScroll>
  );
}

function TimelineExpandableBody({
  activeLatestBundleId,
  compactActivityIntents,
  row,
  showAssistantMessageActions,
}: TimelineExpandableBodyProps) {
  const {
    onOpenLink,
    onOpenLocalFileLink,
    projectId,
    resolveUserAttachmentImageSrc,
    themeType,
    workspaceRootPath,
    resolveImageViewSrc,
  } = useTimelineRendererStaticContext();

  switch (row.kind) {
    case "bundle-summary":
    case "step-summary": {
      const list = (
        <TimelineRowsList
          rows={row.children}
          scopeActive={false}
          showAssistantMessageActions={showAssistantMessageActions}
          compactActivityIntents={true}
          spacing="bundle"
          unreadDividerAutoScroll={false}
          unreadDividerPlacement={null}
        />
      );
      // Summaries whose children are themselves expandable (commands, tools
      // without exploration intents, file-changes, delegations, or any mix
      // including those) leave the cap off — capping would force a child's
      // own scroll body to live inside a parent scroll, and nested
      // scrollbars are bad UX. Only summaries whose children are all flat
      // and non-expandable (exploration intent listings, web search/fetch)
      // keep the base cap with overflow fades.
      if (!isNonExpandableSummary(row.children)) {
        return list;
      }
      // Streaming follows the agent's frontier rather than the bundle's
      // reduced child status. A bundle that's still being appended to may
      // momentarily look "completed" between events (replays compress this
      // window to zero), so deriving sticky-bottom from `row.status` would
      // miss most updates. `activeLatestBundleId` is null once the timeline
      // settles past a non-bundle frontier, so streaming naturally shuts off.
      const isFrontier =
        row.kind === "bundle-summary" && row.id === activeLatestBundleId;
      return (
        <TimelineDetailScroll
          size="summary"
          streaming={isFrontier}
          contentKey={timelineRowsSignature(row.children)}
        >
          {list}
        </TimelineDetailScroll>
      );
    }
    case "turn":
      return (
        <TurnRowBody
          row={row}
          compactActivityIntents={compactActivityIntents}
          // Completed turn details live under "Worked for..." as archival
          // context; pending "Working" rows keep the streaming affordance.
          showAssistantMessageActions={
            showAssistantMessageActions && row.status === "pending"
          }
        />
      );
    case "work":
      if (row.workKind === "delegation") {
        const delegationActive = row.status === "pending";
        return (
          <TimelineDetailScroll
            size="delegation"
            streaming={delegationActive}
            contentKey={`${timelineRowsSignature(row.childRows)}|${row.output.length}`}
            className={NESTED_TIMELINE_GROUP_LINE_CLASS_NAME}
          >
            <div className="flex flex-col gap-3">
              {row.childRows.length > 0 ? (
                <TimelineRowsList
                  rows={row.childRows}
                  scopeActive={delegationActive}
                  showAssistantMessageActions={false}
                  compactActivityIntents={false}
                  spacing="nested"
                  unreadDividerAutoScroll={false}
                  unreadDividerPlacement={null}
                />
              ) : null}
              {row.output.trim().length > 0 ? (
                <ConversationMessageContent
                  attachments={null}
                  id={row.id}
                  onOpenLink={onOpenLink}
                  onOpenLocalFileLink={onOpenLocalFileLink}
                  projectId={projectId}
                  resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
                  role="assistant"
                  showActions={false}
                  mobileActionDisplay="overflow"
                  sourceSeqEnd={row.sourceSeqEnd}
                  sourceSeqStart={row.sourceSeqStart}
                  text={row.output}
                  threadId={row.threadId}
                  turnId={row.turnId}
                  turnRequest={null}
                  workspaceRootPath={workspaceRootPath}
                />
              ) : null}
            </div>
          </TimelineDetailScroll>
        );
      }
      return (
        <WorkRowBody
          row={row}
          resolveImageViewSrc={resolveImageViewSrc}
          themeType={themeType}
          workspaceRootPath={workspaceRootPath}
        />
      );
    case "system":
      return row.detail ? (
        <TimelineSystemDetailBlock
          detail={row.detail}
          streaming={row.status === "pending"}
        />
      ) : null;
    case "conversation":
      return null;
    default:
      return assertNever(row);
  }
}

function TurnRowBody({
  compactActivityIntents,
  row,
  showAssistantMessageActions,
}: TurnRowBodyProps) {
  if (row.children === null) {
    return (
      <LazyTurnRowBody
        compactActivityIntents={compactActivityIntents}
        row={row}
        showAssistantMessageActions={showAssistantMessageActions}
      />
    );
  }

  return (
    <TimelineRowsList
      rows={row.children}
      scopeActive={false}
      showAssistantMessageActions={showAssistantMessageActions}
      compactActivityIntents={compactActivityIntents}
      spacing="nested"
      className={NESTED_TIMELINE_GROUP_LINE_CLASS_NAME}
      unreadDividerAutoScroll={false}
      unreadDividerPlacement={null}
    />
  );
}

function LazyTurnRowBody({
  compactActivityIntents,
  row,
  showAssistantMessageActions,
}: LazyTurnRowBodyProps) {
  const { getViewRows, threadId } = useTimelineRendererStaticContext();
  const {
    sourceSeqEnd: rowSourceSeqEnd,
    sourceSeqStart: rowSourceSeqStart,
    threadId: rowThreadId,
    turnId: rowTurnId,
  } = row;
  const identity = useMemo<ThreadTimelineTurnSummaryDetailsQueryIdentity>(
    () =>
      buildTurnSummaryDetailsIdentity({
        rowSourceSeqEnd,
        rowSourceSeqStart,
        rowThreadId,
        rowTurnId,
        threadId,
      }),
    [rowSourceSeqEnd, rowSourceSeqStart, rowThreadId, rowTurnId, threadId],
  );
  const {
    data: detail,
    isError,
    refetch,
  } = useThreadTimelineTurnSummaryDetails(identity);
  const handleRetry = useCallback((): void => {
    void refetch();
  }, [refetch]);
  const rows = detail
    ? // Lazy turn-detail children belong to a completed turn — flag the
      // scope as closed so trailing work in the children collapses into a
      // step-summary at end-of-input, matching the inline-children path.
      getViewRows(detail.rows, { closedScope: true })
    : null;

  if (!rows && isError) {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive-text">
        <span>Failed to load turn details.</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleRetry}
          className="h-7 cursor-pointer border-destructive px-2 text-destructive hover:text-destructive"
        >
          <Icon name="RotateCcw" />
          Retry
        </Button>
      </div>
    );
  }
  if (rows) {
    return (
      <TimelineRowsList
        rows={rows}
        scopeActive={false}
        showAssistantMessageActions={showAssistantMessageActions}
        compactActivityIntents={compactActivityIntents}
        spacing="nested"
        className={NESTED_TIMELINE_GROUP_LINE_CLASS_NAME}
        unreadDividerAutoScroll={false}
        unreadDividerPlacement={null}
      />
    );
  }
  return (
    <div className="text-sm text-muted-foreground">Loading turn details...</div>
  );
}

/**
 * Opacity for the receded "past" layer — the bottom step of the timeline's
 * three-tier prominence ramp:
 *
 *   tier 1 — agent prose ........ `text-foreground`, opacity 100   (most prominent)
 *   tier 2 — live / active rows .. their title tones, opacity 100   (next)
 *   tier 3 — finished / past rows  those same tones × this opacity  (least)
 *
 * The gap this controls — active vs. done — is the one that has to read
 * clearly, since most of a timeline is finished work sitting next to a live
 * row. It's a whole-row opacity step, so the contrast is identical in light and
 * dark (unlike a tone step: the muted-vs-foreground token gap is wide in light
 * but nearly nothing in dark). Pushed deep — `opacity-70` (~30% nudge) read
 * "too tight", so finished work now drops well below the live frontier; a
 * running verb additionally shimmers (`animate-shine`) so active reads as more
 * alive still. Tune here if active vs. done needs more or less separation.
 */
export const PAST_ROW_DIM_CLASS_NAME = "opacity-40";

/**
 * Whether a row sits in the receded past layer, and so takes
 * `PAST_ROW_DIM_CLASS_NAME`. Applied uniformly across every timeline row kind so
 * the active/inactive ramp is consistent — leaf tool/command/file rows, their
 * rolled-up bundle/step/turn summaries, and operational system rows all recede
 * together once finished. A row recedes only once it is done AND no longer the
 * live frontier:
 *  - completed `work` and `system` rows — errors, interruptions, and still-
 *    pending rows stay at full strength so failures and live work keep
 *    attention;
 *  - turn headers and step-summaries, which only ever render as finished
 *    recaps;
 *  - bundle-summaries, EXCEPT the active-latest one (the live frontier), which
 *    stays prominent.
 * Conversation prose (the top tier) never recedes.
 */
export function pastRowDimClassName({
  activeLatestBundleId,
  row,
  scopeActive,
}: ActiveSummaryTreatmentArgs): string | undefined {
  // The live frontier never recedes: the active-latest bundle stays prominent
  // even once its children have finished, because more work may still land in
  // it.
  if (
    row.kind === "bundle-summary" &&
    isActiveLatestBundleSummary({ activeLatestBundleId, row, scopeActive })
  ) {
    return undefined;
  }
  switch (row.kind) {
    case "work":
    case "system":
    case "turn":
    case "bundle-summary":
    case "step-summary":
      // Finished rows recede; still-running, errored, and interrupted rows —
      // whether a single leaf or a rolled-up summary that merged a failure —
      // stay at full strength so live work and failures keep attention.
      return row.status === "completed" ? PAST_ROW_DIM_CLASS_NAME : undefined;
    case "conversation":
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Per-intent glyph for an exploration row, shared by the bundled compact-intent
 * listing and the unbundled standalone row so the icon for a given intent kind
 * (search / read / list_files) is identical in both surfaces.
 */
function explorationIntentIcon(
  intentType: "read" | "list_files" | "search",
): IconName {
  switch (intentType) {
    case "search":
      return "Search";
    case "read":
      return "FileText";
    case "list_files":
      return "Folder";
    default:
      return assertNever(intentType);
  }
}

/**
 * A leading glyph for every tool-call (work) row, keyed by its kind so the eye
 * can tell edits from explores from commands at a glance.
 */
function leadingIconForWorkRow(
  row: ThreadTimelineViewRow,
): IconName | undefined {
  if (row.kind !== "work") {
    return undefined;
  }
  if ("activityIntents" in row && row.activityIntents.some(isSkillReadIntent)) {
    return "Zap";
  }
  // A command/tool row that carries a single exploration intent renders as a
  // flat, non-expandable row, so the per-intent search/read/folder glyph must
  // come from here (not the bundled compact-intent path) — otherwise it would
  // fall through to the generic Terminal icon.
  if (row.workKind === "command" || row.workKind === "tool") {
    const intent = primaryTimelineActivityIntent(row);
    if (intent !== null && intent.type !== "unknown") {
      return explorationIntentIcon(intent.type);
    }
  }
  switch (row.workKind) {
    case "file-change":
      return "EditFile";
    case "command":
      return "Terminal";
    case "tool":
      return "Terminal";
    case "web-search":
      return "Search";
    case "web-fetch":
      return "Globe";
    case "image-view":
      return "File";
    case "delegation":
      return "UserRoundPlus";
    case "workflow":
      // Background tasks reuse the workflow row shape but read by task type.
      if (isBackgroundCommandTaskType(row.taskType)) {
        return "Terminal";
      }
      if (isBackgroundAgentTaskType(row.taskType)) {
        return "UserRoundPlus";
      }
      return "ListTodo";
    case "approval":
      return "Lock";
    case "question":
      return "CircleQuestion";
    default:
      return undefined;
  }
}

/**
 * Per-action leading glyph for system operation rows, keyed by `operationKind`
 * (and the parent-change action) so each lifecycle event reads at a glance.
 * Warning / deprecation / provider-unhandled / generic and non-operation system
 * rows keep no leading glyph.
 */
// Pure operation-kind → leading-icon mapping (exported for exhaustive testing).
// Warning / deprecation / provider-unhandled / generic keep no leading glyph.
export function systemOperationLeadingIcon(
  operationKind: TimelineSystemOperationKind,
  parentChangeAction: TimelineParentChange["action"] | null,
): IconName | undefined {
  switch (operationKind) {
    case "parent-change":
      return parentChangeAction === "release" ? "UserRound" : "UserRoundPlus";
    case "thread-provisioning":
      return "Terminal";
    case "thread-interrupted":
      return "AlertCircle";
    case "compaction":
      return "CircleArrowShrink";
    case "context-clear":
      return "Clean";
    case "generic":
    case "warning":
    case "deprecation":
    case "provider-unhandled":
      return undefined;
    default:
      return assertNever(operationKind);
  }
}

function leadingIconForSystemRow(
  row: ThreadTimelineViewRow,
): IconName | undefined {
  if (row.kind !== "system" || row.systemKind !== "operation") {
    return undefined;
  }
  return systemOperationLeadingIcon(
    row.operationKind,
    row.operationKind === "parent-change" ? row.parentChange.action : null,
  );
}

/** Leading glyph for any timeline row: work rows by kind, system rows by action. */
function leadingIconForRow(row: ThreadTimelineViewRow): IconName | undefined {
  return leadingIconForWorkRow(row) ?? leadingIconForSystemRow(row);
}

function isSkillReadIntent(intent: TimelineActivityIntent): boolean {
  if (intent.type !== "read") {
    return false;
  }
  const target = (intent.path ?? intent.name).replaceAll("\\", "/");
  return target.split("/").pop() === SKILL_FILE_NAME;
}

function leadingIconForActivityIntentTitle(
  entry: TimelineActivityIntentTitle,
): IconName {
  if (isSkillReadIntent(entry.intent)) {
    return "Zap";
  }
  return explorationIntentIcon(entry.intentType);
}

function TimelineRowView({
  activeLatestBundleId,
  compactActivityIntents,
  row,
  scopeActive,
  showAssistantMessageActions,
  spacing,
}: TimelineRowViewProps) {
  const horizontalPadding = timelineRowHorizontalPadding(spacing);
  const { onTitleAction, resolveSegmentLinkHref } =
    useTimelineRendererStaticContext();
  const titleState = useTimelineRowTitleRenderState({
    activeLatestBundleId,
    compactActivityIntents,
    row,
    scopeActive,
    spacing,
  });

  if (row.kind === "conversation") {
    return (
      <ConversationRow
        row={row}
        showAssistantMessageActions={showAssistantMessageActions}
      />
    );
  }

  if (titleState.kind === "compact-activity-intents") {
    return (
      <>
        {titleState.titles.map((entry) => (
          <TimelineStaticRow
            key={entry.id}
            horizontalPadding={horizontalPadding}
            className={pastRowDimClassName({
              activeLatestBundleId,
              row,
              scopeActive,
            })}
          >
            <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
              <Icon
                name={leadingIconForActivityIntentTitle(entry)}
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <TimelineTitleView
                title={entry.title}
                onTitleAction={onTitleAction}
                resolveSegmentLinkHref={resolveSegmentLinkHref}
              />
            </span>
          </TimelineStaticRow>
        ))}
      </>
    );
  }

  if (!isRowExpandable(row)) {
    const staticLeadingIcon = leadingIconForRow(row);
    return (
      <TimelineStaticRow
        horizontalPadding={horizontalPadding}
        className={pastRowDimClassName({
          activeLatestBundleId,
          row,
          scopeActive,
        })}
      >
        <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
          {staticLeadingIcon ? (
            <Icon
              name={staticLeadingIcon}
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-hidden
            />
          ) : null}
          <TimelineTitleView
            title={titleState.title}
            onTitleAction={onTitleAction}
            resolveSegmentLinkHref={resolveSegmentLinkHref}
          />
        </span>
      </TimelineStaticRow>
    );
  }

  return (
    <MemoizedTimelineExpandableRowView
      activeLatestBundleId={activeLatestBundleId}
      row={row}
      scopeActive={scopeActive}
      showAssistantMessageActions={showAssistantMessageActions}
      title={titleState.title}
      horizontalPadding={horizontalPadding}
      compactActivityIntents={compactActivityIntents}
    />
  );
}

const MemoizedTimelineRowView = memo(
  TimelineRowView,
  areTimelineRowViewPropsEqual,
);

function TimelineExpandableRowView({
  activeLatestBundleId,
  compactActivityIntents,
  scopeActive,
  showAssistantMessageActions,
  title,
  horizontalPadding,
  row,
}: TimelineExpandableRowViewProps) {
  const { onTitleAction, resolveSegmentLinkHref } =
    useTimelineRendererStaticContext();
  const {
    initialAutoExpandedRowIds,
    liveAutoExpandedRowIds,
    terminalAutoExpandedRowIds,
  } = useTimelineTurnStateContext();
  const searchExpandedRowIds = useContext(TimelineSearchExpansionContext);
  const renderBody = useCallback(
    () => (
      <TimelineExpandableBody
        activeLatestBundleId={activeLatestBundleId}
        row={row}
        compactActivityIntents={compactActivityIntents}
        showAssistantMessageActions={showAssistantMessageActions}
      />
    ),
    [
      activeLatestBundleId,
      compactActivityIntents,
      row,
      showAssistantMessageActions,
    ],
  );

  const leadingIcon = leadingIconForRow(row);

  return (
    <ExpandableTimelineRow
      title={title}
      // Dim the row's title content (not the whole row) so the disclosure caret
      // keeps a uniform opacity across completed/header/normal rows instead of
      // compounding the row-level dim onto the caret.
      summaryClassName={pastRowDimClassName({
        activeLatestBundleId,
        row,
        scopeActive,
      })}
      horizontalPadding={horizontalPadding}
      leadingIcon={leadingIcon}
      autoExpanded={
        liveAutoExpandedRowIds.has(row.id) ||
        initialAutoExpandedRowIds.has(row.id)
      }
      forceExpanded={searchExpandedRowIds.has(row.id)}
      terminalAutoExpanded={terminalAutoExpandedRowIds.has(row.id)}
      onTitleAction={onTitleAction}
      resolveSegmentLinkHref={resolveSegmentLinkHref}
      renderBody={renderBody}
    />
  );
}

const MemoizedTimelineExpandableRowView = memo(
  TimelineExpandableRowView,
  areTimelineExpandableRowViewPropsEqual,
);

function findUnreadDividerIndex({
  rows,
  unreadDividerPlacement,
}: FindUnreadDividerIndexArgs): number {
  if (unreadDividerPlacement === null) {
    return -1;
  }

  switch (unreadDividerPlacement.kind) {
    case "before-first":
      return rows.length > 0 ? 0 : -1;
    case "after-cutoff":
      return rows.findIndex((row) =>
        isUnreadDividerCandidateAfterCutoff({
          cutoffAt: unreadDividerPlacement.cutoffAt,
          row,
        }),
      );
    default:
      assertNever(unreadDividerPlacement);
  }
}

function isUserAuthoredConversationRow(row: ThreadTimelineViewRow): boolean {
  return (
    row.kind === "conversation" &&
    row.role === "user" &&
    row.initiator === "user"
  );
}

function isUnreadDividerCandidateAfterCutoff({
  cutoffAt,
  row,
}: IsUnreadDividerCandidateAfterCutoffArgs): boolean {
  if (row.createdAt <= cutoffAt) {
    return false;
  }

  return !isUserAuthoredConversationRow(row);
}

function buildTimelineRowsListItems({
  rows,
  unreadDividerPlacement,
}: BuildTimelineRowsListItemsArgs): TimelineRowsListItem[] {
  const items: TimelineRowsListItem[] = [];
  const dividerIndex = findUnreadDividerIndex({
    rows,
    unreadDividerPlacement,
  });

  for (const [index, row] of rows.entries()) {
    if (index === dividerIndex) {
      items.push({ kind: "unread-divider", id: "thread-unread-divider" });
    }
    items.push({ kind: "row", row });
  }

  return items;
}

function TimelineWindowedListItem({
  alwaysRealized,
  children,
  estimatedHeight,
  initiallyRealized,
  itemKey,
  registerWrapper,
  registerController,
  registerInteractionPin,
  rowId,
}: TimelineWindowedListItemProps) {
  const [locallyRealized, setLocallyRealized] = useState(initiallyRealized);
  const [placeholderHeight, setPlaceholderHeight] = useState(estimatedHeight);
  // Mirrors the placeholder-height state so the window controller can read
  // and adjust it synchronously between two flushSync commits in one task.
  const placeholderHeightRef = useRef(estimatedHeight);
  const locallyRealizedRef = useRef(locallyRealized);
  const alwaysRealizedRef = useRef(alwaysRealized);
  const everRealizedRef = useRef(initiallyRealized || alwaysRealized);
  const interactionPinnedRef = useRef(false);
  const lastIntersectionRef = useRef<boolean | null>(null);
  useLayoutEffect(() => {
    locallyRealizedRef.current = locallyRealized;
    alwaysRealizedRef.current = alwaysRealized;
  }, [alwaysRealized, locallyRealized]);

  const updateLocallyRealized = useCallback((next: boolean) => {
    if (next) {
      everRealizedRef.current = true;
    }
    if (locallyRealizedRef.current === next) {
      return;
    }
    locallyRealizedRef.current = next;
    setLocallyRealized(next);
  }, []);
  const applyPlaceholderHeight = useCallback((next: number) => {
    placeholderHeightRef.current = next;
    setPlaceholderHeight(next);
  }, []);
  const controller = useMemo<TimelineWindowItemController>(
    () => ({
      handleIntersection: (entry) => {
        lastIntersectionRef.current = entry.isIntersecting;
        if (entry.isIntersecting) {
          updateLocallyRealized(true);
          return;
        }
        if (entry.boundingClientRect.height > 0) {
          applyPlaceholderHeight(entry.boundingClientRect.height);
        }
        if (!alwaysRealizedRef.current && !interactionPinnedRef.current) {
          updateLocallyRealized(false);
        }
      },
      // Applies a realization outside an intersection entry (scroll-time
      // realization or the idle flush). The item is intersecting when this
      // runs, so the last-intersection state matches what handleIntersection
      // would have set.
      realize: () => {
        lastIntersectionRef.current = true;
        updateLocallyRealized(true);
      },
      derealize: () => {
        updateLocallyRealized(false);
      },
      peekPlaceholderHeight: () =>
        alwaysRealizedRef.current || locallyRealizedRef.current
          ? null
          : placeholderHeightRef.current,
      adjustPlaceholderHeight: (delta) => {
        applyPlaceholderHeight(
          Math.max(0, placeholderHeightRef.current + delta),
        );
      },
      hasEverRealized: () => everRealizedRef.current,
      unpin: () => {
        interactionPinnedRef.current = false;
      },
    }),
    [applyPlaceholderHeight, updateLocallyRealized],
  );
  useLayoutEffect(() => {
    registerController(itemKey, controller);
    return () => registerController(itemKey, null);
  }, [controller, itemKey, registerController]);
  useLayoutEffect(() => {
    if (
      !alwaysRealized &&
      lastIntersectionRef.current === false &&
      !interactionPinnedRef.current
    ) {
      const frame = requestAnimationFrame(() => updateLocallyRealized(false));
      return () => cancelAnimationFrame(frame);
    }
  }, [alwaysRealized, updateLocallyRealized]);

  const pinInteractedItem = useCallback(() => {
    interactionPinnedRef.current = true;
    // Reporting every interaction (not just the first) keeps the list-level
    // pin order in recency order, so the least-recently-touched pin evicts.
    registerInteractionPin(itemKey);
  }, [itemKey, registerInteractionPin]);
  const handleWrapperRef = useCallback(
    (node: HTMLDivElement | null) => registerWrapper(itemKey, node),
    [itemKey, registerWrapper],
  );
  const isRealized = alwaysRealized || locallyRealized;

  return (
    <div
      ref={handleWrapperRef}
      data-timeline-row-id={rowId}
      data-timeline-row-realized={isRealized ? "true" : "false"}
      aria-hidden={isRealized ? undefined : true}
      style={isRealized ? undefined : { height: placeholderHeight }}
      onClickCapture={pinInteractedItem}
      onFocusCapture={pinInteractedItem}
    >
      {isRealized ? children : null}
    </div>
  );
}

function captureTimelineVisibleAnchor({
  orderedKeys,
  scrollElement,
  wrapperByKey,
}: {
  orderedKeys: readonly string[];
  scrollElement: HTMLElement;
  wrapperByKey: ReadonlyMap<string, HTMLDivElement>;
}): TimelineVisibleAnchor | null {
  const scrollRect = scrollElement.getBoundingClientRect();
  let low = 0;
  let high = orderedKeys.length - 1;
  let firstVisibleIndex = orderedKeys.length;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const key = orderedKeys[middle];
    const element = key === undefined ? undefined : wrapperByKey.get(key);
    if (element === undefined) {
      return null;
    }
    if (element.getBoundingClientRect().bottom > scrollRect.top) {
      firstVisibleIndex = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  const key = orderedKeys[firstVisibleIndex];
  const element = key === undefined ? undefined : wrapperByKey.get(key);
  if (element === undefined) {
    return null;
  }
  const rect = element.getBoundingClientRect();
  return rect.top < scrollRect.bottom ? { element, top: rect.top } : null;
}

function restoreTimelineVisibleAnchor({
  anchor,
  scrollElement,
  wasAtBottom,
}: {
  anchor: TimelineVisibleAnchor | null;
  scrollElement: HTMLElement;
  wasAtBottom: boolean;
}): void {
  if (wasAtBottom) {
    scrollElement.scrollTop = Math.max(
      0,
      scrollElement.scrollHeight - scrollElement.clientHeight,
    );
    return;
  }
  if (anchor === null || !anchor.element.isConnected) {
    return;
  }
  const topDelta = anchor.element.getBoundingClientRect().top - anchor.top;
  if (Math.abs(topDelta) > 0.5) {
    scrollElement.scrollTop += topDelta;
  }
}

function TimelineRowsList({
  compactActivityIntents,
  hasOlderTimelineRows,
  isLoadingOlderTimelineRows,
  onLoadOlderRows,
  rows,
  scopeActive,
  showAssistantMessageActions,
  spacing,
  className,
  unreadDividerAutoScroll,
  unreadDividerPlacement,
}: TimelineRowsListProps) {
  const { threadId } = useTimelineRendererStaticContext();
  const isCompactViewport = useIsCompactViewport();
  const bottomAnchor = useBottomAnchoredScroll();
  const store = useStore();
  const location = useLocation();
  const searchExpandedRowIds = useTimelineSearchExpansionRowIds(rows);
  const stableSearchExpandedRowIds = useStableReadonlySet(searchExpandedRowIds);
  const activeLatestBundleId = useMemo(
    () => findActiveLatestBundleId(rows),
    [rows],
  );
  const items = useMemo(
    () => buildTimelineRowsListItems({ rows, unreadDividerPlacement }),
    [rows, unreadDividerPlacement],
  );
  const itemKeys = useMemo(() => items.map(timelineListItemKey), [items]);
  const shouldWindow =
    spacing === "top-level" &&
    isCompactViewport &&
    bottomAnchor !== null &&
    typeof IntersectionObserver !== "undefined" &&
    items.length >= TIMELINE_WINDOWING_MIN_ITEM_COUNT;
  const searchTarget = useMemo(
    () => readSearchMessageTarget(location.state),
    [location.state],
  );
  const searchTargetsTimeline =
    searchTarget !== null &&
    (threadId === undefined ||
      searchTarget.threadId === null ||
      searchTarget.threadId === threadId);
  const initialWindowCenterIndex = useMemo(() => {
    if (searchTarget !== null && searchTargetsTimeline) {
      const searchIndex = items.findIndex(
        (item) =>
          item.kind === "row" &&
          item.row.sourceSeqStart <= searchTarget.seq &&
          searchTarget.seq <= item.row.sourceSeqEnd,
      );
      if (searchIndex >= 0) {
        return searchIndex;
      }
    }

    if (unreadDividerAutoScroll) {
      const dividerIndex = items.findIndex(
        (item) => item.kind === "unread-divider",
      );
      if (dividerIndex >= 0) {
        return dividerIndex;
      }
    }

    if (threadId !== undefined) {
      const anchor = store.get(threadTimelineScrollAnchorAtomFamily(threadId));
      if (anchor !== null && !anchor.atBottom && anchor.rowId.length > 0) {
        const anchorIndex = items.findIndex(
          (item) => item.kind === "row" && item.row.id === anchor.rowId,
        );
        if (anchorIndex >= 0) {
          return anchorIndex;
        }
      }
    }

    return Math.max(0, items.length - 1);
  }, [
    items,
    searchTarget,
    searchTargetsTimeline,
    store,
    threadId,
    unreadDividerAutoScroll,
  ]);
  const initiallyRealizedKeys = useMemo(
    () =>
      shouldWindow
        ? collectTimelineWindowKeys({
            centerIndex: initialWindowCenterIndex,
            items,
          })
        : EMPTY_ROW_ID_SET,
    [initialWindowCenterIndex, items, shouldWindow],
  );
  const wrapperByKeyRef = useRef(new Map<string, HTMLDivElement>());
  const keyByWrapperRef = useRef(new Map<Element, string>());
  const controllerByKeyRef = useRef(
    new Map<string, TimelineWindowItemController>(),
  );
  const intersectionObserverRef = useRef<IntersectionObserver | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  // Last committed content height of each realized wrapper. Late growth
  // (lazy images, async rendering) diffs against this baseline so it can be
  // compensated the same way as the mount-time delta.
  const realizedHeightByKeyRef = useRef(new Map<string, number>());
  // Interaction-pinned keys in recency order, capped so pins cannot
  // accumulate without bound over a long session.
  const pinnedKeysRef = useRef<string[]>([]);
  // The observers outlive row streaming, so their callbacks read the current
  // key order through this ref instead of re-creating per rows change.
  const itemKeysRef = useRef(itemKeys);
  useLayoutEffect(() => {
    itemKeysRef.current = itemKeys;
  }, [itemKeys]);
  const alwaysRealizedKeys = useMemo(() => {
    if (!shouldWindow) {
      return EMPTY_ROW_ID_SET;
    }
    const keys = new Set<string>();
    if (searchTarget !== null && searchTargetsTimeline) {
      const searchIndex = items.findIndex(
        (item) =>
          item.kind === "row" &&
          item.row.sourceSeqStart <= searchTarget.seq &&
          searchTarget.seq <= item.row.sourceSeqEnd,
      );
      const searchItem = items[searchIndex];
      if (searchItem !== undefined) {
        keys.add(timelineListItemKey(searchItem));
      }
    }
    if (unreadDividerAutoScroll) {
      const dividerIndex = items.findIndex(
        (item) => item.kind === "unread-divider",
      );
      const divider = items[dividerIndex];
      if (divider !== undefined) {
        keys.add(timelineListItemKey(divider));
      }
    }
    return keys;
  }, [
    items,
    searchTarget,
    searchTargetsTimeline,
    shouldWindow,
    unreadDividerAutoScroll,
  ]);

  const registerWrapper = useCallback(
    (key: string, node: HTMLDivElement | null) => {
      const previous = wrapperByKeyRef.current.get(key);
      if (previous !== undefined && previous !== node) {
        keyByWrapperRef.current.delete(previous);
        intersectionObserverRef.current?.unobserve(previous);
        resizeObserverRef.current?.unobserve(previous);
      }
      if (node === null) {
        wrapperByKeyRef.current.delete(key);
        realizedHeightByKeyRef.current.delete(key);
        return;
      }
      wrapperByKeyRef.current.set(key, node);
      keyByWrapperRef.current.set(node, key);
      intersectionObserverRef.current?.observe(node);
      resizeObserverRef.current?.observe(node);
    },
    [],
  );
  const registerController = useCallback(
    (key: string, controller: TimelineWindowItemController | null) => {
      if (controller === null) {
        controllerByKeyRef.current.delete(key);
        return;
      }
      controllerByKeyRef.current.set(key, controller);
    },
    [],
  );
  const registerInteractionPin = useCallback((key: string) => {
    const pinned = pinnedKeysRef.current;
    const existing = pinned.indexOf(key);
    if (existing >= 0) {
      pinned.splice(existing, 1);
    }
    pinned.push(key);
    while (pinned.length > TIMELINE_WINDOW_MAX_INTERACTION_PINS) {
      const evicted = pinned.shift();
      if (evicted !== undefined) {
        controllerByKeyRef.current.get(evicted)?.unpin();
      }
    }
  }, []);

  const getScrollElement = bottomAnchor?.getScrollElement;
  useEffect(() => {
    if (!shouldWindow || typeof IntersectionObserver === "undefined") {
      return;
    }
    const scrollElement = getScrollElement?.() ?? null;
    if (scrollElement === null) {
      return;
    }
    const realizedHeightByKey = realizedHeightByKeyRef.current;

    const applyWithScrollCompensation = (apply: () => void) => {
      const maxScrollTop = Math.max(
        0,
        scrollElement.scrollHeight - scrollElement.clientHeight,
      );
      const wasAtBottom = maxScrollTop - scrollElement.scrollTop <= 2;
      const anchor = wasAtBottom
        ? null
        : captureTimelineVisibleAnchor({
            scrollElement,
            orderedKeys: itemKeysRef.current,
            wrapperByKey: wrapperByKeyRef.current,
          });
      flushSync(apply);
      restoreTimelineVisibleAnchor({ anchor, scrollElement, wasAtBottom });
    };

    // Distributes one above-viewport height delta into placeholder donors
    // that sit earlier in the list (and therefore also fully above the
    // viewport). Positive deltas shrink donors topmost-first so placeholders
    // nearest the viewport keep accurate heights; negative deltas hand the
    // slack to the topmost donor. All-or-nothing: donors change only when
    // the whole delta is covered, so the swap is exactly net zero. Must run
    // inside flushSync so donor commits paint atomically with the change
    // they balance.
    const tryCompensateAboveViewportDelta = (
      candidateIndex: number,
      delta: number,
    ): boolean => {
      const keys = itemKeysRef.current;
      if (delta < 0) {
        for (let index = 0; index < candidateIndex; index += 1) {
          const key = keys[index];
          if (key === undefined) {
            continue;
          }
          const controller = controllerByKeyRef.current.get(key);
          if ((controller?.peekPlaceholderHeight() ?? null) !== null) {
            controller?.adjustPlaceholderHeight(-delta);
            return true;
          }
        }
        return false;
      }
      let remaining = delta;
      const takes: Array<[TimelineWindowItemController, number]> = [];
      for (
        let index = 0;
        index < candidateIndex && remaining > 0.5;
        index += 1
      ) {
        const key = keys[index];
        if (key === undefined) {
          continue;
        }
        const controller = controllerByKeyRef.current.get(key);
        if (controller === undefined) {
          continue;
        }
        const available = controller.peekPlaceholderHeight();
        if (available === null || available <= 0) {
          continue;
        }
        const take = Math.min(available, remaining);
        takes.push([controller, take]);
        remaining -= take;
      }
      if (remaining > 0.5) {
        return false;
      }
      for (const [controller, take] of takes) {
        controller.adjustPlaceholderHeight(-take);
      }
      return true;
    };

    // Realizations that found no donor capacity while scrolling. They keep
    // their unchanged placeholders (nothing on screen moves) and mount at
    // the next idle pass, where a compensating scrollTop write is free.
    // During an active scroll the ONLY geometry this component changes is
    // the exact net-zero donor swap — no scrollTop writes, no tolerated
    // drift. Anything that cannot satisfy that invariant waits for idle.
    const pendingRealizeKeys = new Set<string>();

    // Running average of first-measured item heights. Never-realized
    // placeholders start from a static estimate that real content usually
    // exceeds, so donor capacity would otherwise drain monotonically during
    // upward scrolling. Re-budgeting those estimates to the measured average
    // at idle keeps the donor pool solvent, which keeps insolvency reverts
    // (and their brief near-top blanks) rare.
    const measuredSampleKeys = new Set<string>();
    let measuredSampleSum = 0;
    let lastRebudgetAverage: number | null = null;
    const computeRebudgetAdjustments = (): Array<
      [TimelineWindowItemController, number]
    > => {
      if (measuredSampleKeys.size < TIMELINE_WINDOW_REBUDGET_MIN_SAMPLES) {
        return [];
      }
      const average = Math.min(
        TIMELINE_WINDOW_REBUDGET_MAX_ESTIMATE_PX,
        measuredSampleSum / measuredSampleKeys.size,
      );
      if (
        lastRebudgetAverage !== null &&
        Math.abs(average - lastRebudgetAverage) <
          TIMELINE_WINDOW_REBUDGET_DRIFT_PX
      ) {
        return [];
      }
      lastRebudgetAverage = average;
      const adjustments: Array<[TimelineWindowItemController, number]> = [];
      for (const key of itemKeysRef.current) {
        const controller = controllerByKeyRef.current.get(key);
        if (controller === undefined || controller.hasEverRealized()) {
          continue;
        }
        const current = controller.peekPlaceholderHeight();
        if (current === null) {
          continue;
        }
        const delta = average - current;
        if (Math.abs(delta) < 1) {
          continue;
        }
        adjustments.push([controller, delta]);
      }
      return adjustments;
    };

    // One idle pass covers both deferred works: mount the insolvent
    // realizations and re-seed estimate placeholders, in a single
    // anchor-compensated commit.
    const runIdlePass = () => {
      const pending = [...pendingRealizeKeys];
      pendingRealizeKeys.clear();
      const adjustments = computeRebudgetAdjustments();
      if (pending.length === 0 && adjustments.length === 0) {
        return;
      }
      applyWithScrollCompensation(() => {
        for (const key of pending) {
          controllerByKeyRef.current.get(key)?.realize();
        }
        for (const [controller, delta] of adjustments) {
          controller.adjustPlaceholderHeight(delta);
        }
      });
    };
    let idlePassTimeout: number | null = null;
    const scheduleIdlePass = () => {
      if (idlePassTimeout !== null) {
        window.clearTimeout(idlePassTimeout);
      }
      idlePassTimeout = window.setTimeout(() => {
        idlePassTimeout = null;
        if (scrollElement.dataset.scrollbarScrolling === "true") {
          scheduleIdlePass();
          return;
        }
        runIdlePass();
      }, TIMELINE_WINDOW_REBUDGET_IDLE_DELAY_MS);
    };
    const recordMeasuredSample = (key: string, height: number) => {
      if (height <= 0 || measuredSampleKeys.has(key)) {
        return;
      }
      measuredSampleKeys.add(key);
      measuredSampleSum += height;
      scheduleIdlePass();
    };

    // Realize items whose top sits above the viewport while a scroll is
    // active. Mount their content in one synchronous commit, measure each
    // realized height, then balance every height delta against placeholder
    // donors in a second commit in the same task (so nothing paints in
    // between). The net height change above the viewport stays zero, which
    // keeps visible content still without a momentum-killing scrollTop
    // write. Donor placeholders self-correct: they re-measure whenever they
    // realize or derealize later.
    const realizeAboveViewportDuringScroll = (keys: readonly string[]) => {
      const itemKeysNow = itemKeysRef.current;
      const candidates = keys.flatMap((key) => {
        const controller = controllerByKeyRef.current.get(key);
        const wrapper = wrapperByKeyRef.current.get(key);
        const index = itemKeysNow.indexOf(key);
        const placeholderHeight = controller?.peekPlaceholderHeight() ?? null;
        if (
          controller === undefined ||
          wrapper === undefined ||
          index < 0 ||
          placeholderHeight === null
        ) {
          return [];
        }
        return [{ controller, index, key, placeholderHeight, wrapper }];
      });
      if (candidates.length === 0) {
        return;
      }

      flushSync(() => {
        for (const candidate of candidates) {
          candidate.controller.realize();
        }
      });

      flushSync(() => {
        for (const candidate of candidates) {
          const measured = candidate.wrapper.getBoundingClientRect().height;
          recordMeasuredSample(candidate.key, measured);
          const delta = measured - candidate.placeholderHeight;
          if (
            delta !== 0 &&
            !tryCompensateAboveViewportDelta(candidate.index, delta)
          ) {
            // No donor capacity (near the top of the timeline): revert to
            // the unchanged placeholder — net zero, nothing painted in
            // between — and mount at the idle pass instead.
            candidate.controller.derealize();
            pendingRealizeKeys.add(candidate.key);
            scheduleIdlePass();
            continue;
          }
          realizedHeightByKey.set(candidate.key, measured);
        }
      });
    };

    const observer = new IntersectionObserver(
      (entries) => {
        // A programmatic scrollTop write stops WebKit's native momentum
        // scrolling, and WebKit — the only engine this compact-viewport list
        // runs on for mobile — has no scroll anchoring to absorb layout
        // shifts. While a scroll is active (the scroll owner keeps this
        // marker present through the inertial tail), apply derealizations
        // and at-or-below-viewport realizations directly: derealizations
        // swap in their just-measured height, and an item whose top edge is
        // at or below the viewport top only pushes layout below that edge
        // when it grows. Items whose top is above the viewport realize with
        // donor compensation instead.
        if (scrollElement.dataset.scrollbarScrolling === "true") {
          let viewportTop: number | null = null;
          const growUpKeys: string[] = [];
          for (const entry of entries) {
            const key = keyByWrapperRef.current.get(entry.target);
            if (key === undefined) {
              continue;
            }
            const controller = controllerByKeyRef.current.get(key);
            if (controller === undefined) {
              continue;
            }
            if (!entry.isIntersecting) {
              realizedHeightByKey.delete(key);
              pendingRealizeKeys.delete(key);
              controller.handleIntersection(entry);
              continue;
            }
            const alreadyRealized =
              wrapperByKeyRef.current.get(key)?.dataset
                .timelineRowRealized === "true";
            if (alreadyRealized) {
              controller.handleIntersection(entry);
              continue;
            }
            // rootBounds already includes the rootMargin expansion; strip it
            // to recover the true viewport edge without forcing a layout.
            const rootTop = entry.rootBounds?.top;
            viewportTop ??=
              rootTop !== undefined
                ? rootTop + TIMELINE_WINDOW_MARGIN_PX
                : scrollElement.getBoundingClientRect().top;
            if (entry.boundingClientRect.top >= viewportTop) {
              controller.handleIntersection(entry);
              continue;
            }
            growUpKeys.push(key);
          }
          if (growUpKeys.length > 0) {
            realizeAboveViewportDuringScroll(growUpKeys);
          }
          return;
        }

        applyWithScrollCompensation(() => {
          for (const entry of entries) {
            const key = keyByWrapperRef.current.get(entry.target);
            if (key === undefined) {
              continue;
            }
            if (entry.isIntersecting) {
              pendingRealizeKeys.delete(key);
            } else {
              realizedHeightByKey.delete(key);
              pendingRealizeKeys.delete(key);
            }
            controllerByKeyRef.current.get(key)?.handleIntersection(entry);
          }
        });
      },
      {
        root: scrollElement,
        rootMargin: `${TIMELINE_WINDOW_MARGIN_PX}px 0px`,
      },
    );
    intersectionObserverRef.current = observer;

    // Late content growth in a realized row above the viewport (a lazy image
    // decoding, async rendering settling) shifts visible content, because
    // WebKit has no scroll anchoring. Compensate with a direct scrollTop
    // nudge — but only while the scroll is idle, where the write is free.
    // During an active scroll only the baseline updates: mutating geometry
    // mid-gesture is exactly what reads as snapping. Growth in or below the
    // viewport stays uncompensated: a visible image expanding in place is
    // expected content behavior.
    let contentGrowthObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      contentGrowthObserver = new ResizeObserver((entries) => {
        let viewportTop: number | null = null;
        let idleAdjustment = 0;
        const scrolling =
          scrollElement.dataset.scrollbarScrolling === "true";
        for (const entry of entries) {
          const key = keyByWrapperRef.current.get(entry.target);
          if (key === undefined) {
            continue;
          }
          const wrapper = wrapperByKeyRef.current.get(key);
          if (wrapper === undefined) {
            continue;
          }
          if (wrapper.dataset.timelineRowRealized !== "true") {
            // Placeholder height changes are this component's own writes
            // (donor adjustments, derealization measurements) — already
            // balanced, never compensated again.
            realizedHeightByKey.delete(key);
            continue;
          }
          const height =
            entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
          const previous = realizedHeightByKey.get(key);
          realizedHeightByKey.set(key, height);
          recordMeasuredSample(key, height);
          if (previous === undefined || scrolling) {
            // First observation after an already-balanced realization, or a
            // mid-scroll change that must not mutate geometry.
            continue;
          }
          const delta = height - previous;
          if (Math.abs(delta) < 0.5) {
            continue;
          }
          viewportTop ??= scrollElement.getBoundingClientRect().top;
          if (wrapper.getBoundingClientRect().bottom > viewportTop) {
            continue;
          }
          idleAdjustment += delta;
        }
        if (idleAdjustment !== 0) {
          scrollElement.scrollTop = Math.max(
            0,
            scrollElement.scrollTop + idleAdjustment,
          );
        }
      });
    }
    resizeObserverRef.current = contentGrowthObserver;

    for (const wrapper of wrapperByKeyRef.current.values()) {
      observer.observe(wrapper);
      contentGrowthObserver?.observe(wrapper);
    }
    // Scroll events push the pending idle pass out to the next quiet moment.
    scrollElement.addEventListener("scroll", scheduleIdlePass, {
      passive: true,
    });

    return () => {
      intersectionObserverRef.current = null;
      resizeObserverRef.current = null;
      observer.disconnect();
      contentGrowthObserver?.disconnect();
      scrollElement.removeEventListener("scroll", scheduleIdlePass);
      if (idlePassTimeout !== null) {
        window.clearTimeout(idlePassTimeout);
      }
      pendingRealizeKeys.clear();
      realizedHeightByKey.clear();
    };
  }, [getScrollElement, shouldWindow]);

  const renderedRowsKey = shouldWindow
    ? [...alwaysRealizedKeys].sort().join("\u0000")
    : "all";

  useScrollToSearchedMessage(rows, threadId, {
    hasOlderRows: hasOlderTimelineRows,
    isLoadingOlderRows: isLoadingOlderTimelineRows,
    onLoadOlderRows,
    renderedRowsKey,
  });

  const renderItem = (item: TimelineRowsListItem) => {
    if (item.kind === "unread-divider") {
      return <TimelineUnreadDivider autoScroll={unreadDividerAutoScroll} />;
    }
    return (
      <MemoizedTimelineRowView
        activeLatestBundleId={activeLatestBundleId}
        row={item.row}
        scopeActive={scopeActive}
        showAssistantMessageActions={showAssistantMessageActions}
        spacing={spacing}
        compactActivityIntents={compactActivityIntents}
      />
    );
  };

  if (shouldWindow) {
    return (
      <TimelineSearchExpansionContext.Provider
        value={stableSearchExpandedRowIds}
      >
        <div
          className={cn(
            "flex min-w-0 flex-col [&_button:not(:disabled)]:cursor-pointer",
            timelineRowsListGapClassName(spacing),
            className,
          )}
          data-timeline-row-list={spacing}
          data-timeline-windowed="true"
        >
          {items.map((item) => {
            const itemKey = timelineListItemKey(item);
            return (
              <TimelineWindowedListItem
                key={itemKey}
                alwaysRealized={alwaysRealizedKeys.has(itemKey)}
                estimatedHeight={estimateTimelineListItemHeight(item)}
                initiallyRealized={initiallyRealizedKeys.has(itemKey)}
                itemKey={itemKey}
                registerController={registerController}
                registerInteractionPin={registerInteractionPin}
                registerWrapper={registerWrapper}
                rowId={item.kind === "row" ? item.row.id : undefined}
              >
                {renderItem(item)}
              </TimelineWindowedListItem>
            );
          })}
        </div>
      </TimelineSearchExpansionContext.Provider>
    );
  }

  const list = (
    <TimelineSearchExpansionContext.Provider value={stableSearchExpandedRowIds}>
      <div
        className={cn(
          "flex min-w-0 flex-col [&_button:not(:disabled)]:cursor-pointer",
          timelineRowsListGapClassName(spacing),
          className,
        )}
        data-timeline-row-list={spacing}
      >
        {items.map((item) => {
          if (item.kind === "unread-divider") {
            return (
              <TimelineUnreadDivider
                key={item.id}
                autoScroll={unreadDividerAutoScroll}
              />
            );
          }

          return (
            <div
              key={item.row.id}
              data-timeline-row-id={item.row.id}
              data-timeline-row-realized="true"
            >
              {renderItem(item)}
            </div>
          );
        })}
      </div>
    </TimelineSearchExpansionContext.Provider>
  );
  return spacing === "top-level" ? (
    <AutoHeightContainer>{list}</AutoHeightContainer>
  ) : (
    list
  );
}

function ThreadTimelineRowsComponent(props: ThreadTimelineRowsProps) {
  const ownerKey = timelineRowsOwnerKey({
    threadId: props.threadId,
    timelineRows: props.timelineRows,
  });
  return <ThreadTimelineRowsForTimelineView key={ownerKey} {...props} />;
}

function ThreadTimelineRowsForTimelineView(props: ThreadTimelineRowsProps) {
  const getViewRows = useTimelineViewRowsCache();
  const rows = useMemo(
    () => getViewRows(props.timelineRows),
    [getViewRows, props.timelineRows],
  );
  const latestActionableAssistantMessageId = useMemo(
    () => findLastActionableAssistantMessageId(rows),
    [rows],
  );
  const latestActionableUserMessageId = useMemo(
    () =>
      findLastActionableUserMessageId(
        rows,
        props.onSelectionAddToChat !== undefined ||
          props.onEditMessage !== undefined,
      ),
    [props.onEditMessage, props.onSelectionAddToChat, rows],
  );
  const scopeActive = isRunningThreadRuntimeDisplayStatus(
    props.threadRuntimeDisplayStatus,
  );
  const themeType = props.themeType ?? "light";
  const computedAutoExpansionRowIds = useMemo(
    () => collectTimelineAutoExpansionRowIds({ rows, scopeActive }),
    [rows, scopeActive],
  );
  const liveAutoExpandedRowIds = useStableReadonlySet(
    computedAutoExpansionRowIds.liveFrontierRowIds,
  );
  // Terminal auto-expansion is a one-shot latch per row, and the latch lives
  // in row-local state that windowed eviction unmounts. Accumulate every id
  // that has ever latched so an evicted frontier-error row re-expands when it
  // remounts. A row the user manually collapses stays collapsed: collapsing
  // is an interaction, which pins the row against eviction, so its manual
  // override survives.
  const accumulatedTerminalRowIdsRef = useRef(new Set<string>());
  const accumulatedTerminalRowIds = useMemo(() => {
    const accumulated = accumulatedTerminalRowIdsRef.current;
    for (const id of computedAutoExpansionRowIds.terminalFrontierRowIds) {
      accumulated.add(id);
    }
    return new Set(accumulated);
  }, [computedAutoExpansionRowIds.terminalFrontierRowIds]);
  const terminalAutoExpandedRowIds = useStableReadonlySet(
    accumulatedTerminalRowIds,
  );
  const initialAutoExpandedRowIds = useStableReadonlySet(
    props.initialExpanded ?? EMPTY_ROW_ID_SET,
  );
  const projectId = props.projectId;
  const senderThreadMetadataById = useSenderThreadMetadataById();
  // Single plugin-slot subscription for the whole timeline; messages read the
  // stable registry from context instead of each opening a store subscription.
  // Provide getServerSnapshot so renderToStaticMarkup / SSR tests work.
  const messageDirectiveSlots = useSyncExternalStore(
    subscribePluginSlots,
    () => getPluginSlotSnapshot().messageDirectives,
    () => EMPTY_PLUGIN_SLOT_SNAPSHOT.messageDirectives,
  );
  const messageActionSlots = useSyncExternalStore(
    subscribePluginSlots,
    () => getPluginSlotSnapshot().messageActions,
    () => EMPTY_PLUGIN_SLOT_SNAPSHOT.messageActions,
  );
  const messageDirectiveRegistry = useMemo(
    () => buildMessageDirectiveRegistry(messageDirectiveSlots),
    [messageDirectiveSlots],
  );
  const resolveSegmentLinkHref = useMemo<TimelineTitleLinkResolver>(() => {
    return (link) => {
      // Thread routes are project-scoped; without a project context the
      // segment renders as plain text.
      return projectId !== undefined
        ? getThreadRoutePath({ projectId, threadId: link.threadId })
        : null;
    };
  }, [projectId]);
  // One selection controller for the whole timeline: any assistant message that
  // reports a non-null selection replaces it (single open menu), and a report of
  // `null` (only emitted by a message that previously had a selection) clears it.
  const onSelectionAddToChat = props.onSelectionAddToChat;
  const timelineThreadId = props.threadId;
  const hasPluginSelectionActions =
    timelineThreadId !== undefined && messageActionSlots.length > 0;
  const hasSelectionActions =
    onSelectionAddToChat !== undefined || hasPluginSelectionActions;
  const [activeSelection, setActiveSelection] = useState<{
    rowId: string;
    selection: MessageProseSelection;
    message: ThreadChatMessageReference;
  } | null>(null);
  // Only hand a reporter to the messages when an action exists; otherwise the
  // wrapper stays inert and the floating menu never mounts.
  const reportProseSelection = useMemo<
    | ((
        rowId: string,
        selection: MessageProseSelection | null,
        message: ThreadChatMessageReference,
      ) => void)
    | undefined
  >(
    () =>
      hasSelectionActions
        ? (rowId, selection, message) => {
            setActiveSelection((current) => {
              if (selection !== null) {
                return { rowId, selection, message };
              }
              return current?.rowId === rowId ? null : current;
            });
          }
        : undefined,
    [hasSelectionActions],
  );
  const dismissSelection = useCallback(() => {
    setActiveSelection(null);
  }, []);
  // "Add to chat" quotes the SELECTION text, not the whole message, so the
  // quoted context is exactly what the user highlighted.
  const handleSelectionAddToChat = useCallback(
    (
      text: string,
      attachments?: Parameters<ThreadTimelineAddToChatHandler>[1],
    ) => {
      if (attachments === undefined) {
        onSelectionAddToChat?.(text);
      } else {
        onSelectionAddToChat?.(text, attachments);
      }
      setActiveSelection(null);
    },
    [onSelectionAddToChat],
  );
  const selectionAddToChatHandler =
    onSelectionAddToChat === undefined ? undefined : handleSelectionAddToChat;
  // Plugin actions for the CURRENT selection: `selectedText` is exactly what
  // the user highlighted; the message reference travels with the selection.
  const onOpenPluginPanel = props.onOpenPluginPanel;
  const selectionPluginActions = useMemo<
    readonly ThreadTimelinePluginMessageAction[]
  >(() => {
    if (
      activeSelection === null ||
      timelineThreadId === undefined ||
      messageActionSlots.length === 0
    ) {
      return [];
    }
    return messageActionSlots.map((slot) => ({
      key: `${slot.pluginId}/${slot.id}/${slot.generation}`,
      pluginId: slot.pluginId,
      icon: slot.icon ?? null,
      label: slot.title,
      onSelect: () =>
        runPluginMessageAction({
          slot,
          threadId: timelineThreadId,
          message: activeSelection.message,
          selectedText: activeSelection.selection.text,
          openThreadPanel: onOpenPluginPanel,
        }),
    }));
  }, [
    activeSelection,
    messageActionSlots,
    onOpenPluginPanel,
    timelineThreadId,
  ]);
  const staticContextValue = useMemo<TimelineRendererStaticContextValue>(
    () => ({
      canSpawnChild: props.canSpawnChild ?? false,
      getViewRows,
      onForkMessage: props.onForkMessage,
      onEditMessage: props.onEditMessage,
      inlineMessageEditor: props.inlineMessageEditor,
      onMessageAddToChat: props.onMessageAddToChat,
      onSendToMainMessage: props.onSendToMainMessage,
      onSelectionAddToChat: selectionAddToChatHandler,
      pluginMessageActions:
        timelineThreadId === undefined ||
        props.includePluginMessageActions === false
          ? EMPTY_PLUGIN_SLOT_SNAPSHOT.messageActions
          : messageActionSlots,
      consumerMessageActions:
        props.consumerMessageActions ?? EMPTY_CONSUMER_MESSAGE_ACTIONS,
      reportProseSelection,
      threadOriginKind: props.threadOriginKind ?? null,
      onOpenLink: props.onOpenLink,
      onOpenLocalFileLink: props.onOpenLocalFileLink,
      onOpenPluginPanel: props.onOpenPluginPanel,
      onTitleAction: props.onTitleAction,
      projectId,
      resolveImageViewSrc: props.resolveImageViewSrc,
      resolveMentionLink: props.resolveMentionLink,
      resolveSegmentLinkHref,
      resolveUserAttachmentImageSrc: props.resolveUserAttachmentImageSrc,
      themeType,
      threadId: props.threadId,
      workspaceRootPath: props.workspaceRootPath,
    }),
    [
      props.canSpawnChild,
      getViewRows,
      props.onForkMessage,
      props.onEditMessage,
      props.inlineMessageEditor,
      props.onMessageAddToChat,
      props.onSendToMainMessage,
      selectionAddToChatHandler,
      messageActionSlots,
      props.includePluginMessageActions,
      props.consumerMessageActions,
      reportProseSelection,
      props.threadOriginKind,
      timelineThreadId,
      props.onOpenLink,
      props.onOpenLocalFileLink,
      props.onOpenPluginPanel,
      props.onTitleAction,
      projectId,
      props.resolveImageViewSrc,
      props.resolveMentionLink,
      resolveSegmentLinkHref,
      props.resolveUserAttachmentImageSrc,
      props.threadId,
      props.workspaceRootPath,
      themeType,
    ],
  );
  const turnStateContextValue = useMemo<TimelineTurnStateContextValue>(
    () => ({
      initialAutoExpandedRowIds,
      liveAutoExpandedRowIds,
      terminalAutoExpandedRowIds,
    }),
    [
      initialAutoExpandedRowIds,
      liveAutoExpandedRowIds,
      terminalAutoExpandedRowIds,
    ],
  );

  return (
    <MessageDirectiveRegistryProvider registry={messageDirectiveRegistry}>
      <TimelineRendererStaticContext.Provider value={staticContextValue}>
        <SenderThreadMetadataContext.Provider value={senderThreadMetadataById}>
          <LatestActionableAssistantMessageIdContext.Provider
            value={latestActionableAssistantMessageId}
          >
            <LatestActionableUserMessageIdContext.Provider
              value={latestActionableUserMessageId}
            >
              <TimelineTurnStateContext.Provider value={turnStateContextValue}>
                <TimelineRowsList
                  hasOlderTimelineRows={props.hasOlderTimelineRows}
                  isLoadingOlderTimelineRows={props.isLoadingOlderTimelineRows}
                  onLoadOlderRows={props.onLoadOlderRows}
                  rows={rows}
                  scopeActive={scopeActive}
                  showAssistantMessageActions={true}
                  compactActivityIntents={false}
                  spacing="top-level"
                  unreadDividerAutoScroll={
                    props.unreadDividerAutoScroll ?? true
                  }
                  unreadDividerPlacement={props.unreadDividerPlacement ?? null}
                />
                {hasSelectionActions ? (
                  <TimelineSelectionMenu
                    selection={activeSelection?.selection ?? null}
                    onAddToChat={selectionAddToChatHandler}
                    pluginActions={selectionPluginActions}
                    onDismiss={dismissSelection}
                  />
                ) : null}
              </TimelineTurnStateContext.Provider>
            </LatestActionableUserMessageIdContext.Provider>
          </LatestActionableAssistantMessageIdContext.Provider>
        </SenderThreadMetadataContext.Provider>
      </TimelineRendererStaticContext.Provider>
    </MessageDirectiveRegistryProvider>
  );
}

export const ThreadTimelineRows = memo(ThreadTimelineRowsComponent);
ThreadTimelineRows.displayName = "ThreadTimelineRows";
